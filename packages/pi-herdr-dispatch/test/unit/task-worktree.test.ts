import { describe, expect, it } from "vitest";

import {
  taskWorktreeContainer,
  taskWorktreeSlug,
} from "../../src/domain/task-worktree.js";
import { isTaskWorktreePath } from "../../src/domain/task-worktree-path.js";

describe("Task Worktree planning", () => {
  it("derives the sibling container from the Origin worktree", () => {
    expect(taskWorktreeContainer("/home/user/project")).toBe(
      "/home/user/project.worktrees",
    );
  });

  it.each([
    ["Fix flaky API tests", "fix-flaky-api-tests"],
    ["  Café déjà vu  ", "cafe-deja-vu"],
    ["修复测试", "task"],
    ["one\ntwo", "one"],
  ])("creates an ASCII-safe slug from %j", (task, expected) => {
    expect(taskWorktreeSlug(task)).toBe(expected);
  });

  it("caps long slugs without a trailing separator", () => {
    const slug = taskWorktreeSlug("a".repeat(100));
    expect(slug).toHaveLength(48);
    expect(slug).toMatch(/^[a-z0-9]+$/u);
  });

  it("recognizes only paths using the Task Worktree container convention", () => {
    expect(isTaskWorktreePath("/home/user/project.worktrees/fix-tests")).toBe(true);
    expect(isTaskWorktreePath("/home/user/project")).toBe(false);
    expect(isTaskWorktreePath("/home/user/worktrees/fix-tests")).toBe(false);
  });
});
