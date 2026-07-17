import { describe, expect, it } from "vitest";

import {
  guardDispatchRegistryAccess,
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

  it.each([
    "rm -f /repo/worktree/generated.txt",
    "git -C /repo/worktree add src/file.ts",
    "cd /repo/worktree && touch generated.txt",
    "cd ../worktree && echo x > generated.txt",
    "cd ../worktree && unknown-build-command",
  ])("blocks mutation reached from a different cwd: %s", (command) => {
    expect(
      guardWorktreeOperation({ kind: "bash", cwd: "/repo/other", command }, context()).action,
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

  it.each(["rm -f /tmp/foo", "mv /tmp/a /tmp/b"])(
    "does not fall back to leased cwd when every parsed mutation path is outside: %s",
    (command) => {
      expect(
        guardWorktreeOperation(
          { kind: "bash", cwd: "/repo/worktree", command },
          context(),
        ),
      ).toEqual({ action: "allow" });
    },
  );

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

describe("Dispatch Registry access guard", () => {
  const registryPath = "/home/jack/.local/state/pi-herdr-dispatch/registry.sqlite";

  it.each([
    "sqlite3 /home/jack/.local/state/pi-herdr-dispatch/registry.sqlite \"INSERT INTO auto_run_sessions VALUES ('s', 1)\"",
    "sqlite3 ~/.local/state/pi-herdr-dispatch/registry.sqlite 'UPDATE dispatches SET auto_run_depth = 0'",
    "sqlite3 ~/.local/state/pi-herdr-dispatch/registry.sqlite 'UPDATE tasks SET state = \'queued\''",
    "cat ~/.local/state/pi-herdr-dispatch/registry.sqlite",
    "rm ~/.local/state/pi-herdr-dispatch/registry.sqlite-wal",
  ])("denies a bash command that touches the Registry: %s", (command) => {
    const decision = guardDispatchRegistryAccess(
      { kind: "bash", cwd: "/repo", command },
      registryPath,
    );
    expect(decision.action).toBe("deny");
    if (decision.action === "deny") expect(decision.code).toBe("dispatch-registry-access");
  });

  it("denies an edit or write into the Registry directory", () => {
    const decision = guardDispatchRegistryAccess(
      {
        kind: "write",
        cwd: "/home/jack/.local/state/pi-herdr-dispatch",
        path: "registry.sqlite",
      },
      registryPath,
    );
    expect(decision.action).toBe("deny");
  });

  it("allows unrelated commands and edits", () => {
    expect(
      guardDispatchRegistryAccess(
        { kind: "bash", cwd: "/repo", command: "git status" },
        registryPath,
      ),
    ).toEqual({ action: "allow" });
    expect(
      guardDispatchRegistryAccess(
        { kind: "edit", cwd: "/repo", path: "src/index.ts" },
        registryPath,
      ),
    ).toEqual({ action: "allow" });
  });
});
