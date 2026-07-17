import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import type { DispatchApplication } from "../../src/dispatch/application.js";
import { DEFAULT_TEAM_CATALOG } from "../../src/domain/team.js";
import { registerDispatchCommands } from "../../src/pi/commands.js";
import type { DispatchController } from "../../src/pi/dispatch-controller.js";
import type { DispatchRuntime } from "../../src/pi/dispatch-runtime.js";
import type { FollowupController } from "../../src/pi/followup-controller.js";

describe("/hd-task roles and workflows", () => {
  it("collects role and workflow after mode and stores the role-defaulted workflow", async () => {
    const handlers = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
    const pi = {
      registerCommand: (
        name: string,
        options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
      ) => handlers.set(name, options.handler),
      registerShortcut: vi.fn(),
    } as unknown as ExtensionAPI;
    const createTask = vi.fn((input) => ({
      id: "hdt_created",
      workspaceId: "w1",
      state: "draft" as const,
      stageIndex: 0,
      reworkCycles: 0,
      updatedAt: input.createdAt,
      ...input,
    }));
    const application = {
      createTask,
      listTasks: () => [],
      listUnsettledInWorkspace: () => [],
      listUnseenSettled: () => [],
      listRecentSettledInWorkspace: () => [],
      listAttention: () => [],
    } as unknown as DispatchApplication;
    const runtime = {
      application,
      mutationUnavailableReason: undefined,
      taskWorktrees: { list: vi.fn(async () => []) },
      autoRunState: () => ({ armed: false, maxDepth: 5 }),
      onStateChanged: () => () => undefined,
      registryRuntime: {
        registry: { teamCatalog: () => DEFAULT_TEAM_CATALOG },
      },
    } as unknown as DispatchRuntime;
    registerDispatchCommands(
      pi,
      runtime,
      {} as DispatchController,
      {} as FollowupController,
    );

    const select = vi
      .fn()
      .mockResolvedValueOnce("手动添加草稿")
      .mockResolvedValueOnce("写入")
      .mockResolvedValueOnce("开发")
      .mockResolvedValueOnce("按角色自动(dev)")
      .mockResolvedValueOnce("不指定");
    const ctx = {
      mode: "tui",
      cwd: "/repo",
      ui: {
        select,
        input: vi.fn(async () => "实现解析器"),
        editor: vi.fn(async () => "Implement the parser"),
        notify: vi.fn(),
        custom: vi.fn(async () => undefined),
      },
      sessionManager: { getSessionId: () => "session-origin" },
    } as unknown as ExtensionContext;

    await handlers.get("hd-task")!("", ctx);

    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: "实现解析器",
      task: "Implement the parser",
      mode: "write",
      role: "coder",
      createdBy: "user",
    }));
    expect(createTask.mock.calls[0]![0]).not.toHaveProperty("workflow");
    expect(select.mock.calls.map((call) => call[0])).toEqual([
      "任务板",
      "派发变更模式",
      "选择角色(可跳过)",
      "选择工作流",
      "选择偏好的任务 worktree(可选)",
    ]);
  });
});
