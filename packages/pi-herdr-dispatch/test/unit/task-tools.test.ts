import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { registerDispatchTools } from "../../src/pi/tools.js";

describe("Task Board tools", () => {
  it("creates one model draft through the application only in TUI mode", async () => {
    const tools: ToolDefinition[] = [];
    const pi = {
      registerTool: (tool: ToolDefinition) => tools.push(tool),
    } as unknown as ExtensionAPI;
    const createTask = vi.fn((input) => ({
      id: "hdt_created",
      workspaceId: "w1",
      state: "draft" as const,
      updatedAt: input.createdAt,
      ...input,
    }));
    const runtime = { application: { createTask } };
    registerDispatchTools(pi, runtime as never, {} as never);
    const draft = tools.find((tool) => tool.name === "herdr_task_draft")!;

    const result = await draft.execute(
      "call_1",
      {
        title: "检查解析器",
        task: "检查解析器边界。",
        mode: "non-mutating",
        preferredWorktree: "/repo/task-a",
      },
      undefined,
      undefined,
      { mode: "tui" } as ExtensionContext,
    );

    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: "检查解析器",
      task: "检查解析器边界。",
      mode: "non-mutating",
      preferredWorktreePath: "/repo/task-a",
      createdBy: "model",
    }));
    expect(result.details).toEqual({ taskId: "hdt_created", title: "检查解析器" });

    await expect(draft.execute(
      "call_2",
      { title: "不能创建", task: "不能写入。", mode: "non-mutating" },
      undefined,
      undefined,
      { mode: "print" } as ExtensionContext,
    )).rejects.toThrow("仅在 TUI 模式下可用");
    expect(createTask).toHaveBeenCalledTimes(1);
  });

  it("notifies once as soon as the last Run Quota unit is consumed", async () => {
    const tools: ToolDefinition[] = [];
    const pi = {
      registerTool: (tool: ToolDefinition) => tools.push(tool),
    } as unknown as ExtensionAPI;
    const notifyRunQuotaExhaustedOnce = vi.fn(async () => undefined);
    const runtime = {
      notifyRunQuotaExhaustedOnce,
    };
    const controller = {
      proposeAndDispatch: vi.fn(async () => ({
        status: "active" as const,
        dispatchId: "hd_task",
        echoVerified: true as const,
        remainingQuota: 0,
      })),
    };
    registerDispatchTools(pi, runtime as never, controller as never);
    const proposal = tools.find((tool) => tool.name === "herdr_dispatch_propose")!;
    const ctx = {
      mode: "tui",
      cwd: "/repo",
      sessionManager: {
        getSessionId: () => "session-origin",
        getSessionFile: () => "/session.jsonl",
      },
    } as unknown as ExtensionContext;

    await proposal.execute(
      "call_1",
      {
        target: "term-target",
        task: "Approved task text",
        taskId: "hdt_task",
        mode: "non-mutating",
      },
      undefined,
      undefined,
      ctx,
    );

    expect(notifyRunQuotaExhaustedOnce).toHaveBeenCalledOnce();
  });

  it("omits quota and does not notify for a disarmed task-bound dispatch", async () => {
    const tools: ToolDefinition[] = [];
    const pi = {
      registerTool: (tool: ToolDefinition) => tools.push(tool),
    } as unknown as ExtensionAPI;
    const notifyRunQuotaExhaustedOnce = vi.fn(async () => undefined);
    const runtime = { notifyRunQuotaExhaustedOnce };
    const controller = {
      proposeAndDispatch: vi.fn(async () => ({
        status: "active" as const,
        dispatchId: "hd_disarmed",
        echoVerified: true as const,
      })),
    };
    registerDispatchTools(pi, runtime as never, controller as never);
    const proposal = tools.find((tool) => tool.name === "herdr_dispatch_propose")!;

    const result = await proposal.execute(
      "call_disarmed",
      {
        target: "term-target",
        task: "Approved task text",
        taskId: "hdt_disarmed",
        mode: "non-mutating",
      },
      undefined,
      undefined,
      {
        mode: "tui",
        cwd: "/repo",
        sessionManager: {
          getSessionId: () => "session-origin",
          getSessionFile: () => "/session.jsonl",
        },
      } as unknown as ExtensionContext,
    );

    expect(result.details).not.toHaveProperty("remainingQuota");
    expect(result.content).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining("Run quota remaining") }),
    ]));
    expect(notifyRunQuotaExhaustedOnce).not.toHaveBeenCalled();
  });
});
