import type {
  BashOperations,
  ToolCallEvent,
  ToolResultEvent,
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
      reason: expect.stringContaining("herdr_dispatch_propose, /hd-new, or user-run /hd-create"),
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
      output: expect.stringContaining("herdr_dispatch_propose, /hd-new, or user-run /hd-create"),
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

  it("wraps an allowed current-pane bash result as untrusted data exactly once", async () => {
    const gate = createSafetyGate({
      currentPaneId: () => "w1:p1",
      getLeaseContext: async () => ({ leaseSnapshot: { status: "ready", leases: [] } }),
    });
    const call = bashEvent("herdr pane read w1:p1 --source recent-unwrapped --lines 50");
    await gate.onToolCall(call, { cwd: "/repo/worktree" });
    const resultEvent = {
      type: "tool_result",
      toolCallId: call.toolCallId,
      toolName: "bash",
      input: call.input,
      content: [{ type: "text", text: "pane output" }],
      details: undefined,
      isError: false,
    } satisfies ToolResultEvent;

    const patch = await gate.onToolResult(resultEvent);

    expect(patch?.content?.[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("<untrusted-herdr-cli-output>"),
    });
    expect(patch?.content?.at(-1)).toMatchObject({
      type: "text",
      text: expect.stringContaining("</untrusted-herdr-cli-output>"),
    });
    expect(await gate.onToolResult(resultEvent)).toBeUndefined();
  });

  it("wraps current-pane user_bash output before it can enter model context", async () => {
    const chunks: string[] = [];
    const operations: BashOperations = {
      async exec(_command, _cwd, options) {
        options.onData(Buffer.from("pane output"));
        return { exitCode: 0 };
      },
    };
    const gate = createSafetyGate({
      currentPaneId: () => "w1:p1",
      getLeaseContext: async () => ({ leaseSnapshot: { status: "ready", leases: [] } }),
      createLocalBashOperations: () => operations,
    });

    const intercepted = await gate.onUserBash(
      userBashEvent("herdr pane read w1:p1 --source recent-unwrapped --lines 50"),
    );
    await intercepted?.operations?.exec("ignored", "/repo/worktree", {
      onData: (data) => chunks.push(data.toString("utf8")),
    });

    expect(chunks.join("")).toContain(
      "<untrusted-herdr-cli-output>\npane output\n</untrusted-herdr-cli-output>",
    );
  });

  it("does not wrap !! output that is already excluded from model context", async () => {
    const gate = createSafetyGate({
      currentPaneId: () => "w1:p1",
      getLeaseContext: async () => ({ leaseSnapshot: { status: "ready", leases: [] } }),
    });

    expect(
      await gate.onUserBash({
        ...userBashEvent("herdr pane read w1:p1"),
        excludeFromContext: true,
      }),
    ).toBeUndefined();
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
