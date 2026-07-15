import { describe, expect, it } from "vitest";

import {
  guardWorktreeOperation,
  type LeaseGuardContext,
  type WorktreeLease,
} from "../../src/safety/policy.js";

const lease: WorktreeLease = {
  dispatchId: "hd_test",
  targetTerminalId: "term_target",
  worktreePath: "/repo/worktree",
};

function context(overrides: Partial<LeaseGuardContext> = {}): LeaseGuardContext {
  return {
    actorTerminalId: "term_other",
    leaseSnapshot: { status: "ready", leases: [lease] },
    ...overrides,
  };
}

describe("Worktree Write Lease guard", () => {
  it.each(["edit", "write"] as const)("blocks non-holder %s inside a leased worktree", (kind) => {
    const decision = guardWorktreeOperation(
      { kind, cwd: "/repo/worktree", path: "src/file.ts" },
      context(),
    );

    expect(decision.action).toBe("deny");
    if (decision.action === "deny") {
      expect(decision.code).toBe("worktree-write-lease");
      expect(decision.reason).toContain("hd_test");
    }
  });

  it("allows the target terminal that holds the lease", () => {
    expect(
      guardWorktreeOperation(
        { kind: "write", cwd: "/repo/worktree", path: "src/file.ts" },
        context({ actorTerminalId: "term_target" }),
      ),
    ).toEqual({ action: "allow" });
  });

  it("normalizes traversal into a leased worktree", () => {
    expect(
      guardWorktreeOperation(
        { kind: "edit", cwd: "/repo/other", path: "../worktree/src/file.ts" },
        context(),
      ).action,
    ).toBe("deny");
  });

  it("does not confuse a sibling path prefix with the leased worktree", () => {
    expect(
      guardWorktreeOperation(
        { kind: "write", cwd: "/repo/worktree-copy", path: "src/file.ts" },
        context(),
      ),
    ).toEqual({ action: "allow" });
  });

  it.each([
    "git status --short",
    "git diff -- src/file.ts",
    "rg TODO src",
    "cat package.json",
    "pwd",
  ])("allows a known read-only bash command in a leased worktree: %s", (command) => {
    expect(
      guardWorktreeOperation({ kind: "bash", cwd: "/repo/worktree", command }, context()),
    ).toEqual({ action: "allow" });
  });

  it.each([
    "touch generated.txt",
    "rm -f generated.txt",
    "git add src/file.ts",
    "sed -i 's/a/b/' src/file.ts",
    "printf x > generated.txt",
    "unknown-build-command",
  ])("blocks a mutating or unknown bash command in a leased worktree: %s", (command) => {
    expect(
      guardWorktreeOperation({ kind: "bash", cwd: "/repo/worktree", command }, context()).action,
    ).toBe("deny");
  });

  it("blocks an explicit leased path from a different cwd", () => {
    expect(
      guardWorktreeOperation(
        { kind: "bash", cwd: "/tmp", command: "rm -f /repo/worktree/generated.txt" },
        context(),
      ).action,
    ).toBe("deny");
  });

  it("allows a known mutation outside every leased worktree", () => {
    expect(
      guardWorktreeOperation(
        { kind: "bash", cwd: "/tmp/scratch", command: "touch generated.txt" },
        context(),
      ),
    ).toEqual({ action: "allow" });
  });

  it("fails closed for covered mutations when the lease Registry is unavailable", () => {
    const unavailable = context({
      leaseSnapshot: { status: "unavailable", reason: "database is locked" },
    });

    for (const operation of [
      { kind: "edit", cwd: "/repo/worktree", path: "src/file.ts" } as const,
      { kind: "write", cwd: "/tmp", path: "file.txt" } as const,
      { kind: "bash", cwd: "/tmp", command: "touch file.txt" } as const,
      { kind: "bash", cwd: "/tmp", command: "unknown-build-command" } as const,
    ]) {
      const decision = guardWorktreeOperation(operation, unavailable);
      expect(decision.action).toBe("deny");
      if (decision.action === "deny") {
        expect(decision.code).toBe("lease-registry-unavailable");
      }
    }
  });

  it("keeps proven read-only bash available when the Registry is unavailable", () => {
    expect(
      guardWorktreeOperation(
        { kind: "bash", cwd: "/repo/worktree", command: "git status --short" },
        context({ leaseSnapshot: { status: "unavailable", reason: "database is locked" } }),
      ),
    ).toEqual({ action: "allow" });
  });
});
