import { describe, expect, it } from "vitest";

import {
  taskWorktreeContainer,
  taskWorktreeSlug,
  taskWorktreeSlugWithSuffix,
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

  it("truncates a long multi-word slug at the last complete word boundary", () => {
    expect(taskWorktreeSlug("Fix API tests with container isolation")).toBe(
      "fix-api-tests-with",
    );
    expect(taskWorktreeSlug("Add container isolation checks")).toBe(
      "add-container-isolation",
    );
  });

  it("hard-cuts a single long word at 24 characters", () => {
    const slug = taskWorktreeSlug("a".repeat(100));
    expect(slug).toBe("a".repeat(24));
    expect(slug).toMatch(/^[a-z0-9]+$/u);
  });

  it("keeps a numeric collision suffix inside the shortened slug limit", () => {
    const baseSlug = "a".repeat(24);

    expect(taskWorktreeSlugWithSuffix(baseSlug, 1)).toBe(baseSlug);
    expect(taskWorktreeSlugWithSuffix(baseSlug, 2)).toBe(`${"a".repeat(22)}-2`);
    expect(taskWorktreeSlugWithSuffix(baseSlug, 10)).toBe(`${"a".repeat(21)}-10`);
  });

  it("recognizes only paths using the Task Worktree container convention", () => {
    expect(isTaskWorktreePath("/home/user/project.worktrees/fix-tests")).toBe(true);
    expect(isTaskWorktreePath("/home/user/project")).toBe(false);
    expect(isTaskWorktreePath("/home/user/worktrees/fix-tests")).toBe(false);
  });
});
