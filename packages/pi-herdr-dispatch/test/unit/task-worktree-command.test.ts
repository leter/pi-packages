import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    BorderedLoader: class {
      readonly signal = new AbortController().signal;
      onAbort?: () => void;
      render(): string[] { return []; }
      invalidate(): void {}
    },
  };
});

import type { AgentLaunchService } from "../../src/dispatch/agent-launch.js";
import type { DispatchApplication } from "../../src/dispatch/application.js";
import type { TaskWorktreeService } from "../../src/domain/task-worktree.js";
import { registerDispatchCommands } from "../../src/pi/commands.js";
import type { DispatchController } from "../../src/pi/dispatch-controller.js";
import type { DispatchRuntime } from "../../src/pi/dispatch-runtime.js";
import type { FollowupController } from "../../src/pi/followup-controller.js";

function register(runtime: DispatchRuntime, controller = {} as DispatchController) {
  const handlers = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const pi = {
    registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
      handlers.set(name, options.handler),
    registerShortcut: vi.fn(),
    exec: vi.fn(async () => ({ stdout: "pi: current (v4)", stderr: "", code: 0 })),
  } as unknown as ExtensionAPI;
  registerDispatchCommands(pi, runtime, controller, {} as FollowupController);
  return { handlers, pi };
}

function context(ui: Record<string, unknown>): ExtensionContext {
  return {
    mode: "tui",
    cwd: "/repo",
    ui,
    sessionManager: {
      getSessionId: () => "session-origin",
      getSessionFile: () => "/session.jsonl",
    },
  } as unknown as ExtensionContext;
}

function loaderCustom() {
  return vi.fn(async (factory) =>
    new Promise((resolve) => {
      factory(
        { requestRender: vi.fn() } as never,
        { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
        {} as never,
        resolve,
      );
    }));
}

describe("Task Worktree commands", () => {
  it("creates a selected Task Worktree before creating the Agent pane", async () => {
    const events: string[] = [];
    const create = vi.fn(async () => {
      events.push("worktree");
      return { path: "/repo.worktrees/fix-tests", branch: "task/fix-tests" };
    });
    const plan = vi.fn(async () => ({
      path: "/repo.worktrees/fix-tests",
      branch: "task/fix-tests",
      originPath: "/repo",
      containerPath: "/repo.worktrees",
      containerExisted: false,
    }));
    const launch = vi.fn(async () => {
      events.push("pane");
      return { terminalId: "term-created" };
    });
    const assertCanCreateTargetAtWorktree = vi.fn(() => events.push("preflight"));
    const assertCanCreateTarget = vi.fn(async () => undefined);
    const runtime = {
      application: { defaultDeadlineMinutes: 30, assertCanCreateTargetAtWorktree, assertCanCreateTarget } as unknown as DispatchApplication,
      agentLauncher: { launch } as unknown as AgentLaunchService,
      taskWorktrees: { plan, create } as unknown as TaskWorktreeService,
      mutationUnavailableReason: undefined,
    } as unknown as DispatchRuntime;
    const proposeAndDispatch = vi.fn(async () => ({
      status: "active" as const,
      dispatchId: "hd_created",
      echoVerified: true as const,
    }));
    const { handlers } = register(runtime, { proposeAndDispatch } as unknown as DispatchController);
    const select = vi.fn()
      .mockResolvedValueOnce("pi")
      .mockResolvedValueOnce("当前标签页 · 自适应")
      .mockResolvedValueOnce("写入")
      .mockResolvedValueOnce("新任务 worktree(默认)· node_modules 等依赖不会带过去,可能需要按本次派发授权重新安装");
    const ctx = context({
      select,
      editor: vi.fn(async () => "Fix tests"),
      input: vi.fn(async () => "30"),
      confirm: vi.fn(async () => false),
      notify: vi.fn(),
      custom: loaderCustom(),
    });

    await handlers.get("hd-create")!("", ctx);

    expect(events).toEqual(["preflight", "worktree", "pane"]);
    expect(assertCanCreateTargetAtWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "write" }),
      "/repo.worktrees/fix-tests",
    );
    expect(assertCanCreateTarget).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/repo.worktrees/fix-tests",
      mode: "write",
    }));
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo.worktrees/fix-tests" }));
  });

  it("fails the launch closed when Task Worktree creation fails", async () => {
    const launch = vi.fn();
    const runtime = {
      application: {
        defaultDeadlineMinutes: 30,
        assertCanCreateTargetAtWorktree: vi.fn(),
      } as unknown as DispatchApplication,
      agentLauncher: { launch } as unknown as AgentLaunchService,
      taskWorktrees: {
        plan: vi.fn(async () => ({
          path: "/repo.worktrees/fix-tests",
          branch: "task/fix-tests",
          originPath: "/repo",
          containerPath: "/repo.worktrees",
          containerExisted: false,
        })),
        create: vi.fn(async () => { throw new Error("git worktree add failed"); }),
      } as unknown as TaskWorktreeService,
      mutationUnavailableReason: undefined,
    } as unknown as DispatchRuntime;
    const { handlers } = register(runtime);
    const notify = vi.fn();
    const ctx = context({
      select: vi.fn()
        .mockResolvedValueOnce("pi")
        .mockResolvedValueOnce("当前标签页 · 自适应")
        .mockResolvedValueOnce("写入")
        .mockResolvedValueOnce("新任务 worktree(默认)· node_modules 等依赖不会带过去,可能需要按本次派发授权重新安装"),
      editor: vi.fn(async () => "Fix tests"),
      input: vi.fn(async () => "30"),
      confirm: vi.fn(async () => false),
      notify,
      custom: vi.fn(),
    });

    await handlers.get("hd-create")!("", ctx);

    expect(launch).not.toHaveBeenCalled();
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "任务 worktree 创建失败:git worktree add failed 未创建任何 Agent 窗口。",
      "error",
    );
  });

  it("lists refusal reasons and removes only confirmed eligible selections", async () => {
    const entries = [
      { path: "/repo.worktrees/a", branch: "task/a", removable: true, reasons: [] },
      { path: "/repo.worktrees/b", branch: "task/b", removable: true, reasons: [] },
      { path: "/repo.worktrees/c", branch: "task/c", removable: false, reasons: ["working-tree-dirty"] },
    ] as const;
    const remove = vi.fn(async () => undefined);
    const runtime = {
      taskWorktrees: { list: vi.fn(async () => entries), remove } as unknown as TaskWorktreeService,
      mutationUnavailableReason: undefined,
    } as unknown as DispatchRuntime;
    const { handlers } = register(runtime);
    const select = vi.fn(async (_title: string, options: readonly string[]) => options[0]);
    const notify = vi.fn();
    const ctx = context({ select, confirm: vi.fn(async () => true), notify });

    await handlers.get("hd-clean")!("", ctx);

    expect(select.mock.calls[0]?.[1]).toContain(
      "/repo.worktrees/c · task/c · 拒绝:任务 worktree 有未提交变更",
    );
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenNthCalledWith(1, "/repo", entries[0]);
    expect(remove).toHaveBeenNthCalledWith(2, "/repo", entries[1]);
    expect(notify).toHaveBeenCalledWith("已清理 2 个任务 worktree。", "info");
  });

  it.each([
    ["/repo", true],
    ["/repo.worktrees/existing", false],
  ])("shows the shared-worktree write hint only when canonical paths match (%s)", async (targetWorktree, hinted) => {
    const target = {
      terminalId: "term-target",
      paneId: "w1:p2",
      workspaceId: "w1",
      agentLabel: "codex",
      cwd: targetWorktree,
      worktreePath: targetWorktree,
      status: "idle" as const,
      statusProvenance: "reported" as const,
    };
    const runtime = {
      application: {
        defaultDeadlineMinutes: 30,
        listEligibleAgents: vi.fn(async () => [target]),
        sharesCanonicalWorktree: vi.fn(async (worktreePath: string) => worktreePath === "/repo"),
      } as unknown as DispatchApplication,
      mutationUnavailableReason: undefined,
    } as unknown as DispatchRuntime;
    const proposeAndDispatch = vi.fn(async () => ({
      status: "active" as const,
      dispatchId: "hd_created",
      echoVerified: true as const,
    }));
    const { handlers } = register(runtime, { proposeAndDispatch } as unknown as DispatchController);
    const notify = vi.fn();
    const ctx = context({
      select: vi.fn().mockResolvedValueOnce(expect.anything()).mockResolvedValueOnce("写入"),
      editor: vi.fn(async () => "Write task"),
      input: vi.fn(async () => "30"),
      confirm: vi.fn(async () => false),
      notify,
    });
    // Select the exact option produced from the single target.
    vi.mocked(ctx.ui.select).mockReset();
    vi.mocked(ctx.ui.select)
      .mockImplementationOnce(async (_title, options) => options[0])
      .mockResolvedValueOnce("写入");

    await handlers.get("hd-new")!("", ctx);

    expect(notify.mock.calls.some(([message]) => String(message).includes("共享 worktree"))).toBe(hinted);
    expect(proposeAndDispatch).toHaveBeenCalledTimes(1);
  });
});
