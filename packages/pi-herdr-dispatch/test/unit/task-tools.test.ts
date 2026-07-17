import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { registerDispatchTools } from "../../src/pi/tools.js";
import { ReadonlyAgentLaunchRefusalError } from "../../src/dispatch/application.js";

describe("Task Board tools", () => {
  it("launches a read-only-role Agent only after armed, role/reuse, and budget checks", async () => {
    const tools: ToolDefinition[] = [];
    const pi = {
      registerTool: (tool: ToolDefinition) => tools.push(tool),
      exec: vi.fn(async () => {
        order.push("launchable-agent");
        return { stdout: "claude: current", stderr: "", code: 0 };
      }),
    } as unknown as ExtensionAPI;
    const order: string[] = [];
    const launched = {
      terminalId: "term-reviewer",
      paneId: "p-reviewer",
      agentLabel: "claude",
      statusProvenance: "reported" as const,
      paneName: "reviewer-auto-1",
      role: "reviewer",
      roleLabel: "评审",
    };
    const runtime = {
      application: {
        assertReadonlyAgentLaunchAllowed: vi.fn(async () => { order.push("role-and-reuse"); }),
        launchReadonlyAgent: vi.fn(async () => { order.push("launch"); return launched; }),
      },
      launchBudgetState: vi.fn(() => {
        order.push("budget-state");
        return { armed: true, remaining: 1 };
      }),
      consumeLaunchBudget: vi.fn(() => { order.push("consume"); return 0; }),
      notifyReadonlyAgentLaunched: vi.fn(async () => { order.push("notify"); }),
      notifyLaunchBudgetExhaustedOnce: vi.fn(async () => undefined),
      runReadonlyLaunchExclusive: <T>(action: () => Promise<T>) => action(),
    };
    registerDispatchTools(pi, runtime as never, {} as never);
    const tool = tools.find((candidate) => candidate.name === "herdr_agent_launch_readonly")!;

    const result = await tool.execute(
      "call_launch",
      { role: "reviewer", agentType: "claude" },
      undefined,
      undefined,
      { mode: "tui" } as ExtensionContext,
    );

    expect(order).toEqual([
      "budget-state",
      "role-and-reuse",
      "launchable-agent",
      "budget-state",
      "launch",
      "consume",
      "notify",
    ]);
    expect(result.content).toEqual([expect.objectContaining({
      text: expect.stringContaining("Launch Budget remaining: 0"),
    })]);
    expect(result.details).toEqual(expect.objectContaining({ status: "launched", remainingBudget: 0 }));
  });

  it("refuses disarmed, invalid-role, reuse-first, and exhausted calls before launch", async () => {
    const cases = [
      {
        name: "disarmed",
        state: { armed: false },
        refusal: undefined,
        expected: "user's /hd-create",
        notify: false,
      },
      {
        name: "write role",
        state: { armed: true, remaining: 1 },
        refusal: new ReadonlyAgentLaunchRefusalError("write-role", "Role coder is write-role capacity"),
        expected: "write-role",
        notify: false,
      },
      {
        name: "reuse first",
        state: { armed: true, remaining: 1 },
        refusal: new ReadonlyAgentLaunchRefusalError(
          "eligible-role-agent",
          "Eligible Agent pane reviewer-1 already matches role reviewer; dispatch to it instead",
          "reviewer-1",
        ),
        expected: "reviewer-1",
        notify: false,
      },
      {
        name: "exhausted",
        state: { armed: true, remaining: 0 },
        refusal: undefined,
        expected: "Launch Budget is exhausted",
        notify: true,
      },
    ];

    for (const item of cases) {
      const tools: ToolDefinition[] = [];
      const pi = {
        registerTool: (tool: ToolDefinition) => tools.push(tool),
        exec: vi.fn(async () => ({ stdout: "claude: current", stderr: "", code: 0 })),
      } as unknown as ExtensionAPI;
      const launchReadonlyAgent = vi.fn();
      const notifyLaunchBudgetExhaustedOnce = vi.fn(async () => undefined);
      const runtime = {
        application: {
          assertReadonlyAgentLaunchAllowed: item.refusal
            ? vi.fn(async () => { throw item.refusal; })
            : vi.fn(async () => undefined),
          launchReadonlyAgent,
        },
        launchBudgetState: () => item.state,
        notifyLaunchBudgetExhaustedOnce,
        runReadonlyLaunchExclusive: <T>(action: () => Promise<T>) => action(),
      };
      registerDispatchTools(pi, runtime as never, {} as never);
      const tool = tools.find((candidate) => candidate.name === "herdr_agent_launch_readonly")!;
      const result = await tool.execute(
        `call_${item.name}`,
        { role: item.name === "write role" ? "coder" : "reviewer", agentType: "claude" },
        undefined,
        undefined,
        { mode: "tui" } as ExtensionContext,
      );
      const text = result.content?.map((content) => content.type === "text" ? content.text : "").join("") ?? "";
      expect(text).toContain(item.expected);
      expect(result.details).toEqual(expect.objectContaining({ status: "refused" }));
      expect(launchReadonlyAgent).not.toHaveBeenCalled();
      expect(notifyLaunchBudgetExhaustedOnce).toHaveBeenCalledTimes(item.notify ? 1 : 0);
    }
  });

  it("does not consume Launch Budget when Agent launch fails", async () => {
    const tools: ToolDefinition[] = [];
    const pi = {
      registerTool: (tool: ToolDefinition) => tools.push(tool),
      exec: vi.fn(async () => ({ stdout: "claude: current", stderr: "", code: 0 })),
    } as unknown as ExtensionAPI;
    const consumeLaunchBudget = vi.fn();
    const runtime = {
      application: {
        assertReadonlyAgentLaunchAllowed: vi.fn(async () => undefined),
        launchReadonlyAgent: vi.fn(async () => { throw new Error("startup failed"); }),
      },
      launchBudgetState: () => ({ armed: true, remaining: 1 }),
      consumeLaunchBudget,
      runReadonlyLaunchExclusive: <T>(action: () => Promise<T>) => action(),
    };
    registerDispatchTools(pi, runtime as never, {} as never);
    const tool = tools.find((candidate) => candidate.name === "herdr_agent_launch_readonly")!;

    await expect(tool.execute(
      "call_failed",
      { role: "reviewer", agentType: "claude" },
      undefined,
      undefined,
      { mode: "tui" } as ExtensionContext,
    )).rejects.toThrow("startup failed");
    expect(consumeLaunchBudget).not.toHaveBeenCalled();
  });
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
        role: "researcher",
        workflow: "research",
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
      role: "researcher",
      workflow: "research",
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

  it("exposes role, workflow stage, rework cycles, and parked reason in board status", async () => {
    const tools: ToolDefinition[] = [];
    const pi = {
      registerTool: (tool: ToolDefinition) => tools.push(tool),
    } as unknown as ExtensionAPI;
    const task = {
      id: "hdt_review",
      workspaceId: "w1",
      title: "Review parser",
      task: "Review the parser",
      mode: "non-mutating" as const,
      state: "review" as const,
      role: "coder",
      workflow: "dev",
      stageIndex: 1,
      reworkCycles: 2,
      parkedReason: "no-verdict" as const,
      createdBy: "model" as const,
      createdAt: 100,
      updatedAt: 200,
    };
    const runtime = {
      application: {
        listUnsettled: () => [],
        listTasks: () => [task],
        listAttention: () => [],
      },
      registryRuntime: {
        registry: {
          teamCatalog: () => ({
            roles: { reviewer: { key: "reviewer", label: "评审", mode: "non-mutating", brief: "Review." } },
            workflows: {
              dev: { key: "dev", stages: ["coder", "reviewer"], maxReworkCycles: 2, escalation: [] },
            },
          }),
        },
      },
    };
    registerDispatchTools(pi, runtime as never, {} as never);
    const status = tools.find((tool) => tool.name === "herdr_dispatch_status")!;
    const result = await status.execute(
      "call_status",
      {},
      undefined,
      undefined,
      {
        mode: "tui",
        sessionManager: { getSessionId: () => "session-origin" },
      } as ExtensionContext,
    );
    const text = result.content?.map((item) => item.type === "text" ? item.text : "").join("\n") ?? "";
    expect(text).toContain("role coder");
    expect(text).toContain("workflow dev");
    expect(text).toContain("stage 2/2 reviewer");
    expect(text).toContain("rework cycles 2");
    expect(text).toContain("parked no-verdict");
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
