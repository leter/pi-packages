import { basename, dirname, join } from "node:path";

export const TASK_WORKTREE_MAX_SLUG_LENGTH = 48;

export type TaskWorktreeRefusalReason =
  | "branch-unmerged"
  | "working-tree-dirty"
  | "unsettled-dispatch"
  | "missing-task-branch";

export function taskWorktreeContainer(originWorktree: string): string {
  return join(dirname(originWorktree), `${basename(originWorktree)}.worktrees`);
}

export function taskWorktreeSlug(task: string): string {
  const slug = firstTaskLine(task)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, TASK_WORKTREE_MAX_SLUG_LENGTH)
    .replace(/-+$/gu, "");
  return slug || "task";
}

export function isTaskWorktreePath(path: string): boolean {
  return basename(dirname(path)).endsWith(".worktrees") && basename(path).length > 0;
}

export function firstTaskLine(task: string): string {
  return task.replace(/\r\n?/gu, "\n").trim().split("\n", 1)[0] ?? "";
}
