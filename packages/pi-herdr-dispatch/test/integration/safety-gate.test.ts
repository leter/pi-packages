import type {
  ToolCallEvent,
  UserBashEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createSafetyGate } from "../../src/pi/safety-gate.js";
import type { LeaseGuardContext } from "../../src/safety/policy.js";

const blockedLeaseContext: LeaseGuardContext = {
  actorTerminalId: "term_other",
  leaseSnapshot: {
    status: "ready",
    leases: [
      {
        dispatchId: "hd_test",
        targetTerminalId: "term_target",
        worktreePath: "/repo/worktree",
      },
    ],
  },
};

function bashEvent(command: string): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "call_1",
    toolName: "bash",
    input: { command },
  };
}

function userBashEvent(command: string): UserBashEvent {
  return {
    type: "user_bash",
    command,
    cwd: "/repo/worktree",
    excludeFromContext: false,
  };
}

describe("Pi safety gate adapters", () => {
  it("blocks raw Herdr tasking from built-in bash before lease lookup", async () => {
    const getLeaseContext = vi.fn(async () => blockedLeaseContext);
    const gate = createSafetyGate({
      currentPaneId: () => "w1:p1",
      getLeaseContext,
    });

    const result = await gate.onToolCall(bashEvent("herdr pane run w1:p2 task"), {
      cwd: "/repo/worktree",
    });

    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("herdr_dispatch_propose or /herdr-dispatch"),
    });
    expect(getLeaseContext).not.toHaveBeenCalled();
  });

  it("blocks the same raw Herdr tasking through user_bash", async () => {
    const gate = createSafetyGate({
      currentPaneId: () => "w1:p1",
      getLeaseContext: async () => blockedLeaseContext,
    });

    const result = await gate.onUserBash(userBashEvent("herdr agent send term_other task"));

    expect(result?.result).toMatchObject({
      exitCode: 126,
      cancelled: false,
      truncated: false,
      output: expect.stringContaining("herdr_dispatch_propose or /herdr-dispatch"),
    });
  });

  it("blocks edit and write tool calls for a non-holder", async () => {
    const gate = createSafetyGate({
      currentPaneId: () => "w1:p1",
      getLeaseContext: async () => blockedLeaseContext,
    });

    for (const event of [
      {
        type: "tool_call",
        toolCallId: "edit_1",
        toolName: "edit",
        input: { path: "src/file.ts", edits: [] },
      },
      {
        type: "tool_call",
        toolCallId: "write_1",
        toolName: "write",
        input: { path: "src/file.ts", content: "x" },
      },
    ] satisfies ToolCallEvent[]) {
      expect((await gate.onToolCall(event, { cwd: "/repo/worktree" }))?.block).toBe(true);
    }
  });

  it("blocks mutating bash and user_bash for a non-holder", async () => {
    const gate = createSafetyGate({
      currentPaneId: () => "w1:p1",
      getLeaseContext: async () => blockedLeaseContext,
    });

    expect(
      (await gate.onToolCall(bashEvent("touch generated.txt"), {
        cwd: "/repo/worktree",
      }))?.block,
    ).toBe(true);
    expect((await gate.onUserBash(userBashEvent("touch generated.txt")))?.result?.exitCode).toBe(
      126,
    );
  });

  it("allows read-only shell commands through both paths", async () => {
    const gate = createSafetyGate({
      currentPaneId: () => "w1:p1",
      getLeaseContext: async () => blockedLeaseContext,
    });

    expect(
      await gate.onToolCall(bashEvent("git status --short"), { cwd: "/repo/worktree" }),
    ).toBeUndefined();
    expect(await gate.onUserBash(userBashEvent("git status --short"))).toBeUndefined();
  });

  it("fails closed when lease lookup throws", async () => {
    const gate = createSafetyGate({
      currentPaneId: () => "w1:p1",
      getLeaseContext: async () => {
        throw new Error("database is locked");
      },
    });

    const result = await gate.onToolCall(
      {
        type: "tool_call",
        toolCallId: "write_1",
        toolName: "write",
        input: { path: "src/file.ts", content: "x" },
      },
      { cwd: "/repo/worktree" },
    );

    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("Registry is unavailable"),
    });
  });

  it("does not claim coverage for unknown third-party tools", async () => {
    const getLeaseContext = vi.fn(async () => blockedLeaseContext);
    const gate = createSafetyGate({
      currentPaneId: () => "w1:p1",
      getLeaseContext,
    });

    const result = await gate.onToolCall(
      {
        type: "tool_call",
        toolCallId: "custom_1",
        toolName: "third_party_mutator",
        input: { path: "src/file.ts" },
      },
      { cwd: "/repo/worktree" },
    );

    expect(result).toBeUndefined();
    expect(getLeaseContext).not.toHaveBeenCalled();
  });
});
