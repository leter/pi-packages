import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { TaskWorktreeService } from "../../src/domain/task-worktree.js";
import { openDispatchRegistry, type DispatchRegistry } from "../../src/registry/registry.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const registries: DispatchRegistry[] = [];
const withoutRegistryGuard = <T>(_worktreePath: string, cleanup: () => T): T => cleanup();

afterEach(async () => {
  for (const registry of registries.splice(0)) registry.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "pi-herdr-task-worktree-"));
  roots.push(parent);
  const root = join(parent, "repo");
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", root]);
  await writeFile(join(root, "tracked.txt"), "base\n", "utf8");
  await execFileAsync("git", ["-C", root, "add", "tracked.txt"]);
  await execFileAsync("git", [
    "-C", root,
    "-c", "user.name=Test",
    "-c", "user.email=test@example.invalid",
    "commit", "--quiet", "-m", "base",
  ]);
  return root;
}

describe("TaskWorktreeService", () => {
  it("creates a task branch and sibling worktree at Origin HEAD, suffixing collisions", async () => {
    const root = await repository();
    const service = new TaskWorktreeService({
      unsettledWorktreePaths: () => [],
      withRemovalGuard: withoutRegistryGuard,
    });

    const first = await service.create(await service.plan(root, "Fix API tests"));
    const second = await service.create(await service.plan(root, "Fix API tests"));

    expect(first.path).toBe(join(`${root}.worktrees`, "fix-api-tests"));
    expect(first.branch).toBe("task/fix-api-tests");
    expect(second.path).toBe(join(`${root}.worktrees`, "fix-api-tests-2"));
    expect(second.branch).toBe("task/fix-api-tests-2");
    await expect(readFile(join(first.path, "tracked.txt"), "utf8")).resolves.toBe("base\n");
  });

  it("leaves no container or pane-side resource when git rejects the planned creation", async () => {
    const root = await repository();
    const service = new TaskWorktreeService({
      unsettledWorktreePaths: () => [],
      withRemovalGuard: withoutRegistryGuard,
    });
    const plan = await service.plan(root, "Raced branch");
    await execFileAsync("git", ["-C", root, "branch", plan.branch]);

    await expect(service.create(plan)).rejects.toThrow(
      "Planned Task Worktree branch is no longer available",
    );

    await expect(access(plan.containerPath)).rejects.toMatchObject({ code: "ENOENT" });
    const branches = await execFileAsync("git", ["-C", root, "branch", "--format=%(refname:short)"]);
    expect(branches.stdout).toContain(plan.branch);
  });

  it("rolls back dirty files, worktree, and branch left by a failing post-checkout hook", async () => {
    const root = await repository();
    const service = new TaskWorktreeService({
      unsettledWorktreePaths: () => [],
      withRemovalGuard: withoutRegistryGuard,
    });
    const plan = await service.plan(root, "Hook failure");
    const hook = join(root, ".git", "hooks", "post-checkout");
    await writeFile(hook, "#!/bin/sh\ntouch generated.txt\nexit 1\n", "utf8");
    await chmod(hook, 0o755);

    await expect(service.create(plan)).rejects.toThrow("Could not create Task Worktree");

    const listed = await execFileAsync("git", ["-C", root, "worktree", "list", "--porcelain"]);
    expect(listed.stdout).not.toContain(plan.path);
    const branches = await execFileAsync("git", ["-C", root, "branch", "--format=%(refname:short)"]);
    expect(branches.stdout).not.toContain(plan.branch);
    await expect(access(plan.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(plan.containerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not roll back another process that won the same creation plan", async () => {
    const root = await repository();
    const first = new TaskWorktreeService({
      unsettledWorktreePaths: () => [],
      withRemovalGuard: withoutRegistryGuard,
    });
    const second = new TaskWorktreeService({
      unsettledWorktreePaths: () => [],
      withRemovalGuard: withoutRegistryGuard,
    });
    const plan = await first.plan(root, "Concurrent plan");

    const results = await Promise.allSettled([first.create(plan), second.create(plan)]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(access(plan.path)).resolves.toBeUndefined();
    const listed = await execFileAsync("git", ["-C", root, "worktree", "list", "--porcelain"]);
    expect(listed.stdout).toContain(plan.path);
    const branches = await execFileAsync("git", ["-C", root, "branch", "--format=%(refname:short)"]);
    expect(branches.stdout).toContain(plan.branch);
  });

  it("classifies clean merged entries as removable and refuses dirty, unmerged, or held entries", async () => {
    const root = await repository();
    let held: readonly string[] = [];
    const service = new TaskWorktreeService({
      unsettledWorktreePaths: () => held,
      withRemovalGuard: withoutRegistryGuard,
    });
    const removable = await service.create(await service.plan(root, "Removable"));
    const dirty = await service.create(await service.plan(root, "Dirty"));
    const unmerged = await service.create(await service.plan(root, "Unmerged"));
    const occupied = await service.create(await service.plan(root, "Occupied"));
    await writeFile(join(dirty.path, "dirty.txt"), "dirty\n", "utf8");
    await writeFile(join(unmerged.path, "commit.txt"), "commit\n", "utf8");
    await execFileAsync("git", ["-C", unmerged.path, "add", "commit.txt"]);
    await execFileAsync("git", [
      "-C", unmerged.path,
      "-c", "user.name=Test",
      "-c", "user.email=test@example.invalid",
      "commit", "--quiet", "-m", "unmerged",
    ]);
    held = [occupied.path];

    const entries = await service.list(root);
    const byName = new Map(entries.map((entry) => [basename(entry.path), entry]));
    expect(byName.get("removable")).toMatchObject({ removable: true, reasons: [] });
    expect(byName.get("dirty")?.reasons).toContain("working-tree-dirty");
    expect(byName.get("unmerged")?.reasons).toContain("branch-unmerged");
    expect(byName.get("occupied")?.reasons).toContain("unsettled-dispatch");
  });

  it("removes without force and deletes the merged task branch", async () => {
    const root = await repository();
    const service = new TaskWorktreeService({
      unsettledWorktreePaths: () => [],
      withRemovalGuard: withoutRegistryGuard,
    });
    const task = await service.create(await service.plan(root, "Done task"));

    await service.remove(root, task);

    await expect(service.list(root)).resolves.toEqual([]);
    const branches = await execFileAsync("git", ["-C", root, "branch", "--format=%(refname:short)"]);
    expect(branches.stdout).not.toContain("task/done-task");
  });

  it("backs cleanup eligibility with unsettled records in temporary SQLite", async () => {
    const root = await repository();
    const registry = await openDispatchRegistry(join(root, "..", "registry.sqlite"));
    registries.push(registry);
    const service = new TaskWorktreeService({
      unsettledWorktreePaths: () =>
        registry
          .listUnsettled()
          .flatMap((dispatch) => dispatch.worktreePath ? [dispatch.worktreePath] : []),
      withRemovalGuard: (worktreePath, cleanup) =>
        registry.withWorktreeCleanupGuard(worktreePath, cleanup),
    });
    const task = await service.create(await service.plan(root, "Registry held"));
    registry.confirmDeliveryIntent({
      id: "hd_registry_held",
      originSessionId: "session-origin",
      originWorkspaceId: "w1",
      targetWorkspaceId: "w1",
      targetTerminalId: "term-target",
      targetPaneId: "w1:p2",
      targetAgentLabel: "codex",
      targetCwd: task.path,
      worktreePath: task.path,
      mode: "non-mutating",
      task: "Review",
      constraints: [],
      payload: "payload",
      payloadHash: "sha256:payload",
      deadlineAt: 2_000,
      confirmedAt: 1_000,
      maxActivePerTargetWorkspace: 4,
      maxActiveGlobal: 8,
    });

    await expect(service.list(root)).resolves.toEqual([
      expect.objectContaining({ path: task.path, removable: false, reasons: ["unsettled-dispatch"] }),
    ]);
    await expect(service.remove(root, task)).rejects.toThrow("not removable");
    const staleView = new TaskWorktreeService({
      unsettledWorktreePaths: () => [],
      withRemovalGuard: (worktreePath, cleanup) =>
        registry.withWorktreeCleanupGuard(worktreePath, cleanup),
    });
    await expect(staleView.remove(root, task)).rejects.toMatchObject({
      code: "worktree-held",
      conflictingDispatchId: "hd_registry_held",
    });

    registry.settle({
      dispatchId: "hd_registry_held",
      outcome: "done",
      sanitizedResult: { id: "hd_registry_held", outcome: "done", summary: "Reviewed" },
      kind: "result",
      settledAt: 1_500,
    });
    await expect(service.list(root)).resolves.toEqual([
      expect.objectContaining({ path: task.path, removable: true, reasons: [] }),
    ]);
    await expect(service.remove(root, task)).resolves.toBeUndefined();
  });
});
