import { execFile, execFileSync } from "node:child_process";
import { lstat, mkdir, realpath, rm, rmdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import {
  taskWorktreeContainer,
  taskWorktreeSlug,
  taskWorktreeSlugWithSuffix,
  type TaskWorktreeRefusalReason,
} from "./task-worktree-path.js";
import { resolveCanonicalWorktree } from "./worktree.js";

export {
  taskWorktreeContainer,
  taskWorktreeSlug,
  taskWorktreeSlugWithSuffix,
} from "./task-worktree-path.js";
export type { TaskWorktreeRefusalReason } from "./task-worktree-path.js";

export interface TaskWorktree {
  path: string;
  branch: string;
}

export interface TaskWorktreePlan extends TaskWorktree {
  originPath: string;
  containerPath: string;
  containerExisted: boolean;
}

export interface TaskWorktreeEntry extends TaskWorktree {
  removable: boolean;
  reasons: readonly TaskWorktreeRefusalReason[];
}

export interface TaskWorktreeServiceOptions {
  unsettledWorktreePaths: () => readonly string[];
  withRemovalGuard: <T>(worktreePath: string, cleanup: () => T) => T;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class TaskWorktreeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskWorktreeError";
  }
}

export class TaskWorktreeService {
  readonly #unsettledWorktreePaths: () => readonly string[];
  readonly #withRemovalGuard: <T>(worktreePath: string, cleanup: () => T) => T;

  constructor(options: TaskWorktreeServiceOptions) {
    this.#unsettledWorktreePaths = options.unsettledWorktreePaths;
    this.#withRemovalGuard = options.withRemovalGuard;
  }

  async plan(originCwd: string, task: string): Promise<TaskWorktreePlan> {
    const origin = await resolveCanonicalWorktree(originCwd);
    const intendedContainer = taskWorktreeContainer(origin);
    const containerExisted = await pathExists(intendedContainer);
    const container = containerExisted ? await realpath(intendedContainer) : intendedContainer;
    const baseSlug = taskWorktreeSlug(task);
    for (let suffix = 1; suffix <= 10_000; suffix += 1) {
      const slug = taskWorktreeSlugWithSuffix(baseSlug, suffix);
      const path = join(container, slug);
      const branch = `task/${slug}`;
      if (await pathExists(path)) continue;
      const branchExists = await git(origin, [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]);
      if (branchExists.code === 0) continue;
      if (branchExists.code !== 1) {
        throw gitError("Could not check Task Worktree branch availability", branchExists);
      }
      return Object.freeze({
        path,
        branch,
        originPath: origin,
        containerPath: container,
        containerExisted,
      });
    }
    throw new TaskWorktreeError("Could not find an available Task Worktree slug");
  }

  async create(plan: TaskWorktreePlan): Promise<TaskWorktree> {
    await mkdir(plan.containerPath, { recursive: true });
    const creationLock = `${plan.path}.creating`;
    try {
      await mkdir(creationLock);
    } catch (error) {
      throw new TaskWorktreeError("Task Worktree creation is already in progress", {
        cause: error,
      });
    }
    try {
      await this.#assertPlanStillAvailable(plan);
      const created = await git(plan.originPath, [
        "worktree",
        "add",
        plan.path,
        "-b",
        plan.branch,
      ]);
      if (created.code !== 0) {
        await this.#rollbackOwnedCreation(plan);
        throw gitError("Could not create Task Worktree", created);
      }
      try {
        return Object.freeze({ path: await realpath(plan.path), branch: plan.branch });
      } catch (error) {
        await this.#rollbackOwnedCreation(plan);
        throw new TaskWorktreeError("Could not resolve the created Task Worktree", {
          cause: error,
        });
      }
    } finally {
      await rmdir(creationLock).catch(() => undefined);
      if (!plan.containerExisted) await rmdir(plan.containerPath).catch(() => undefined);
    }
  }

  async list(originCwd: string): Promise<readonly TaskWorktreeEntry[]> {
    const origin = await resolveCanonicalWorktree(originCwd);
    const intendedContainer = taskWorktreeContainer(origin);
    if (!(await pathExists(intendedContainer))) return [];
    const container = await realpath(intendedContainer);
    const listed = await git(origin, ["worktree", "list", "--porcelain", "-z"]);
    if (listed.code !== 0) throw gitError("Could not list Task Worktrees", listed);
    const merged = await git(origin, ["branch", "--merged", "HEAD", "--format=%(refname)"]);
    if (merged.code !== 0) throw gitError("Could not inspect merged Task Worktree branches", merged);
    const mergedBranches = new Set(merged.stdout.split(/\r?\n/u).filter(Boolean));
    const heldPaths = new Set(
      await Promise.all(this.#unsettledWorktreePaths().map((path) => canonicalIfPresent(path))),
    );
    const entries: TaskWorktreeEntry[] = [];
    for (const worktree of parseWorktreeList(listed.stdout)) {
      const canonicalPath = await canonicalIfPresent(worktree.path);
      if (!isInside(container, canonicalPath)) continue;
      const reasons: TaskWorktreeRefusalReason[] = [];
      const branch = worktree.branch?.replace(/^refs\/heads\//u, "");
      if (!branch?.startsWith("task/")) reasons.push("missing-task-branch");
      else if (!mergedBranches.has(`refs/heads/${branch}`)) reasons.push("branch-unmerged");
      const status = await git(canonicalPath, ["status", "--porcelain=v1", "-z"]);
      if (status.code !== 0) throw gitError(`Could not inspect Task Worktree ${canonicalPath}`, status);
      if (status.stdout.length > 0) reasons.push("working-tree-dirty");
      if (heldPaths.has(canonicalPath)) reasons.push("unsettled-dispatch");
      entries.push(
        Object.freeze({
          path: canonicalPath,
          branch: branch ?? "",
          removable: reasons.length === 0,
          reasons: Object.freeze(reasons),
        }),
      );
    }
    return Object.freeze(entries.sort((left, right) => left.path.localeCompare(right.path)));
  }

  async remove(originCwd: string, selected: TaskWorktree): Promise<void> {
    const origin = await resolveCanonicalWorktree(originCwd);
    const current = (await this.list(origin)).find((entry) => entry.path === selected.path);
    if (!current) throw new TaskWorktreeError("Task Worktree is no longer present");
    if (!current.removable) {
      throw new TaskWorktreeError(`Task Worktree is not removable: ${current.reasons.join(", ")}`);
    }
    this.#withRemovalGuard(current.path, () => {
      const removed = gitSync(origin, ["worktree", "remove", current.path]);
      if (removed.code !== 0) throw gitError("Git refused to remove the Task Worktree", removed);
      const deleted = gitSync(origin, ["branch", "-d", current.branch]);
      if (deleted.code !== 0) throw gitError("Git refused to delete the Task Worktree branch", deleted);
    });
  }

  async #assertPlanStillAvailable(plan: TaskWorktreePlan): Promise<void> {
    if (await pathExists(plan.path)) {
      throw new TaskWorktreeError("Planned Task Worktree path is no longer available");
    }
    const branch = await git(plan.originPath, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${plan.branch}`,
    ]);
    if (branch.code === 0) {
      throw new TaskWorktreeError("Planned Task Worktree branch is no longer available");
    }
    if (branch.code !== 1) {
      throw gitError("Could not recheck Task Worktree branch availability", branch);
    }
  }

  async #rollbackOwnedCreation(plan: TaskWorktreePlan): Promise<void> {
    const listed = await git(plan.originPath, ["worktree", "list", "--porcelain", "-z"]);
    if (listed.code !== 0) {
      throw gitError("Could not inspect failed Task Worktree creation", listed);
    }
    const registered =
      parseWorktreeList(listed.stdout).some(
        (worktree) => worktree.path === plan.path && worktree.branch === `refs/heads/${plan.branch}`,
      );
    if (registered) {
      const removed = await git(plan.originPath, ["worktree", "remove", "--force", plan.path]);
      if (removed.code !== 0) throw gitError("Could not roll back Task Worktree", removed);
    } else {
      await rm(plan.path, { recursive: true, force: true });
    }
    const branch = await git(plan.originPath, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${plan.branch}`,
    ]);
    if (branch.code === 0) {
      const deleted = await git(plan.originPath, ["branch", "-D", plan.branch]);
      if (deleted.code !== 0) throw gitError("Could not roll back Task Worktree branch", deleted);
    } else if (branch.code !== 1) {
      throw gitError("Could not inspect failed Task Worktree branch", branch);
    }
  }
}

function parseWorktreeList(output: string): readonly { path: string; branch?: string }[] {
  const records: { path: string; branch?: string }[] = [];
  let current: { path: string; branch?: string } | undefined;
  for (const field of output.split("\0")) {
    if (field === "") {
      if (current) records.push(current);
      current = undefined;
      continue;
    }
    if (field.startsWith("worktree ")) {
      if (current) records.push(current);
      current = { path: field.slice("worktree ".length) };
    } else if (field.startsWith("branch ") && current) {
      current.branch = field.slice("branch ".length);
    }
  }
  if (current) records.push(current);
  return records;
}

function isInside(container: string, path: string): boolean {
  const child = relative(container, path);
  return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

async function canonicalIfPresent(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function git(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: typeof error?.code === "number" ? error.code : error ? -1 : 0,
          stdout,
          stderr,
        });
      });
  });
}

function gitSync(cwd: string, args: readonly string[]): GitResult {
  try {
    return {
      code: 0,
      stdout: execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }),
      stderr: "",
    };
  } catch (error) {
    if (isExecFileError(error)) {
      return {
        code: typeof error.status === "number" ? error.status : -1,
        stdout: typeof error.stdout === "string" ? error.stdout : "",
        stderr: typeof error.stderr === "string" ? error.stderr : "",
      };
    }
    throw error;
  }
}

function gitError(message: string, result: GitResult): TaskWorktreeError {
  const detail = (result.stderr || result.stdout || `git exited ${result.code}`).trim();
  return new TaskWorktreeError(`${message}: ${detail}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isExecFileError(
  error: unknown,
): error is Error & { status?: number; stdout?: string; stderr?: string } {
  return error instanceof Error;
}
