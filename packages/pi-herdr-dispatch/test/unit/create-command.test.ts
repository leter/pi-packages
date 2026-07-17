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

import {
  AgentLaunchCancelledError,
  type AgentLaunchService,
} from "../../src/dispatch/agent-launch.js";
import type { DispatchApplication } from "../../src/dispatch/application.js";
import type { DispatchController } from "../../src/pi/dispatch-controller.js";
import { registerDispatchCommands } from "../../src/pi/commands.js";
import type { DispatchRuntime } from "../../src/pi/dispatch-runtime.js";
import type { FollowupController } from "../../src/pi/followup-controller.js";

function theme() {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

describe("/hd-create", () => {
  it("collects every option before creating, waits for the exact target, then uses the normal dispatch path", async () => {
    const handlers = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
    const exec = vi.fn(async () => ({
      stdout: "pi: current (v4) (/tmp/pi)\nclaude: not installed (/tmp/claude)",
      stderr: "",
      code: 0,
    }));
    const pi = {
      registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
        handlers.set(name, options.handler),
      registerShortcut: vi.fn(),
      exec,
    } as unknown as ExtensionAPI;
    const assertCanCreateTarget = vi.fn(async () => undefined);
    const application = {
      defaultDeadlineMinutes: 30,
      assertCanCreateTarget,
    } as unknown as DispatchApplication;
    const launch = vi.fn(async () => ({ terminalId: "term-created" }));
    const runtime = {
      application,
      agentLauncher: { launch } as unknown as AgentLaunchService,
      mutationUnavailableReason: undefined,
    } as unknown as DispatchRuntime;
    const proposeAndDispatch = vi.fn(async () => ({
      status: "active" as const,
      dispatchId: "hd_created",
      echoVerified: true as const,
    }));
    const controller = { proposeAndDispatch } as unknown as DispatchController;
    registerDispatchCommands(pi, runtime, controller, {} as FollowupController);

    const select = vi
      .fn()
      .mockResolvedValueOnce("pi")
      .mockResolvedValueOnce("当前标签页 · 自适应")
      .mockResolvedValueOnce("非变更");
    const notify = vi.fn();
    const ctx = {
      mode: "tui",
      cwd: "/repo",
      ui: {
        select,
        editor: vi.fn(async () => "修复测试"),
        input: vi.fn(async () => ""),
        confirm: vi.fn(),
        notify,
        custom: vi.fn(async (factory) =>
          new Promise((resolve) => {
            factory(
              { requestRender: vi.fn() } as never,
              theme() as never,
              {} as never,
              resolve,
            );
          })),
      },
      sessionManager: {
        getSessionId: () => "session-origin",
        getSessionFile: () => "/session.jsonl",
      },
    } as unknown as ExtensionContext;

    await handlers.get("hd-create")!("", ctx);

    expect(exec).toHaveBeenCalledWith("herdr", ["integration", "status"], { cwd: "/repo" });
    expect(assertCanCreateTarget).toHaveBeenCalledWith({
      cwd: "/repo",
      task: "修复测试",
      mode: "non-mutating",
      deadlineMinutes: 30,
      allowProjectDependencyInstall: false,
    });
    expect(ctx.ui.input).toHaveBeenCalledWith("截止时间(分钟,默认 30)", "30");
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: "pi",
        layout: "adaptive",
        cwd: "/repo",
        label: "pi · 修复测试",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(proposeAndDispatch).toHaveBeenCalledWith(
      {
        target: "term-created",
        task: "修复测试",
        mode: "non-mutating",
        deadlineMinutes: 30,
        allowProjectDependencyInstall: false,
      },
      expect.objectContaining({
        mode: "tui",
        origin: { sessionId: "session-origin", sessionFile: "/session.jsonl" },
      }),
    );
    expect(notify).toHaveBeenCalledWith("派发正在运行;投递回显已验证。", "info");
  });

  it("truncates a long task into a label free of control characters", async () => {
    const handlers = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
    const exec = vi.fn(async () => ({
      stdout: "pi: current (v4) (/tmp/pi)",
      stderr: "",
      code: 0,
    }));
    const pi = {
      registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
        handlers.set(name, options.handler),
      registerShortcut: vi.fn(),
      exec,
    } as unknown as ExtensionAPI;
    const application = {
      defaultDeadlineMinutes: 30,
      assertCanCreateTarget: vi.fn(async () => undefined),
    } as unknown as DispatchApplication;
    const launch = vi.fn(async (_request: { label: string }) => ({
      terminalId: "term-created",
    }));
    const runtime = {
      application,
      agentLauncher: { launch } as unknown as AgentLaunchService,
      mutationUnavailableReason: undefined,
    } as unknown as DispatchRuntime;
    const controller = {
      proposeAndDispatch: vi.fn(async () => ({
        status: "active" as const,
        dispatchId: "hd_created",
        echoVerified: true as const,
      })),
    } as unknown as DispatchController;
    registerDispatchCommands(pi, runtime, controller, {} as FollowupController);

    const longTask =
      "W1 smoke: create a file named ADR15-W1.txt containing exactly ok at the root, then report done.";
    const ctx = {
      mode: "tui",
      cwd: "/repo",
      ui: {
        select: vi
          .fn()
          .mockResolvedValueOnce("pi")
          .mockResolvedValueOnce("当前标签页 · 自适应")
          .mockResolvedValueOnce("非变更"),
        editor: vi.fn(async () => longTask),
        input: vi.fn(async () => ""),
        confirm: vi.fn(),
        notify: vi.fn(),
        custom: vi.fn(async (factory) =>
          new Promise((resolve) => {
            factory(
              { requestRender: vi.fn() } as never,
              theme() as never,
              {} as never,
              resolve,
            );
          })),
      },
      sessionManager: {
        getSessionId: () => "session-origin",
        getSessionFile: () => "/session.jsonl",
      },
    } as unknown as ExtensionContext;

    await handlers.get("hd-create")!("", ctx);

    expect(launch).toHaveBeenCalledTimes(1);
    const label = launch.mock.calls[0]![0].label;
    expect(label.startsWith("pi · W1 smoke:")).toBe(true);
    expect(label.endsWith("…")).toBe(true);
    // The Herdr protocol rejects control characters; an ANSI-emitting
    // truncation helper regressed this once (pi-tui 0.80.10).
    expect(label).not.toMatch(/[\u0000-\u001f\u007f]/u);
  });

  it("reports the retained pane and tab when cancellation arrives after creation", async () => {
    const handlers = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
    const pi = {
      registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
        handlers.set(name, options.handler),
      registerShortcut: vi.fn(),
      exec: vi.fn(async () => ({ stdout: "pi: current (v4)", stderr: "", code: 0 })),
    } as unknown as ExtensionAPI;
    const launch = vi.fn(async () => {
      throw new AgentLaunchCancelledError({
        paneId: "w1:p2",
        tabId: "w1:t1",
        terminalId: "term-created",
        workspaceId: "w1",
        focused: false,
        agentStatus: "unknown",
        revision: 0,
        cwd: "/repo",
      });
    });
    const runtime = {
      application: {
        defaultDeadlineMinutes: 30,
        assertCanCreateTarget: vi.fn(async () => undefined),
      } as unknown as DispatchApplication,
      agentLauncher: { launch } as unknown as AgentLaunchService,
      mutationUnavailableReason: undefined,
    } as unknown as DispatchRuntime;
    registerDispatchCommands(pi, runtime, {} as DispatchController, {} as FollowupController);
    const notify = vi.fn();
    const ctx = {
      mode: "tui",
      cwd: "/repo",
      ui: {
        select: vi
          .fn()
          .mockResolvedValueOnce("pi")
          .mockResolvedValueOnce("当前标签页 · 自适应")
          .mockResolvedValueOnce("非变更"),
        editor: vi.fn(async () => "修复测试"),
        input: vi.fn(async () => "15"),
        confirm: vi.fn(),
        notify,
        custom: vi.fn(async (factory) =>
          new Promise((resolve) => {
            factory({ requestRender: vi.fn() } as never, theme() as never, {} as never, resolve);
          })),
      },
      sessionManager: {
        getSessionId: () => "session-origin",
        getSessionFile: () => "/session.jsonl",
      },
    } as unknown as ExtensionContext;

    await handlers.get("hd-create")!("", ctx);

    expect(notify).toHaveBeenCalledWith(
      "已停止等待和派发;如窗口已经创建,它会继续保留:pane w1:p2 · tab w1:t1。",
      "warning",
    );
  });

  it.each(["rpc", "json", "print"] as const)(
    "rejects %s mode before integration discovery or creation",
    async (mode) => {
      const handlers = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
      const exec = vi.fn();
      const pi = {
        registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
          handlers.set(name, options.handler),
        registerShortcut: vi.fn(),
        exec,
      } as unknown as ExtensionAPI;
      const launch = vi.fn();
      const runtime = {
        application: { defaultDeadlineMinutes: 60 } as DispatchApplication,
        agentLauncher: { launch } as unknown as AgentLaunchService,
        mutationUnavailableReason: undefined,
      } as unknown as DispatchRuntime;
      registerDispatchCommands(pi, runtime, {} as DispatchController, {} as FollowupController);
      const notify = vi.fn();
      const ctx = { mode, cwd: "/repo", ui: { notify } } as unknown as ExtensionContext;

      await handlers.get("hd-create")!("", ctx);

      expect(exec).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith("Agent 创建和派发仅在 TUI 模式下可用", "error");
    },
  );

  it("does not create anything when the wizard is cancelled", async () => {
    const handlers = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
    const pi = {
      registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
        handlers.set(name, options.handler),
      registerShortcut: vi.fn(),
      exec: vi.fn(async () => ({ stdout: "pi: current (v4)", stderr: "", code: 0 })),
    } as unknown as ExtensionAPI;
    const launch = vi.fn();
    const runtime = {
      application: { defaultDeadlineMinutes: 60 } as DispatchApplication,
      agentLauncher: { launch } as unknown as AgentLaunchService,
      mutationUnavailableReason: undefined,
    } as unknown as DispatchRuntime;
    registerDispatchCommands(pi, runtime, {} as DispatchController, {} as FollowupController);
    const ctx = {
      mode: "tui",
      cwd: "/repo",
      ui: {
        select: vi.fn().mockResolvedValueOnce("pi").mockResolvedValueOnce(undefined),
        notify: vi.fn(),
      },
    } as unknown as ExtensionContext;

    await handlers.get("hd-create")!("", ctx);

    expect(launch).not.toHaveBeenCalled();
  });
});
