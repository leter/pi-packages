import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import piHerdrDispatch from "../../src/index.js";

function context(mode: ExtensionContext["mode"]): ExtensionContext {
  return {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: "/repo",
    ui: {
      select: vi.fn(),
      confirm: vi.fn(),
      input: vi.fn(),
      editor: vi.fn(),
      notify: vi.fn(),
    },
    sessionManager: {
      getSessionId: () => "session_1",
      getSessionFile: () => "/session.jsonl",
    },
  } as unknown as ExtensionContext;
}

describe("Pi extension Phase 4 registration", () => {
  it("registers proposal, listing, inspection, status tools and matching slash commands", () => {
    const tools: ToolDefinition[] = [];
    const commands: string[] = [];
    const descriptions = new Map<string, string>();
    const shortcuts: string[] = [];
    const pi = {
      registerMessageRenderer: (() => undefined) as never,
      registerTool: (tool: ToolDefinition) => tools.push(tool),
      registerCommand: (name: string, options: { description: string }) => {
        commands.push(name);
        descriptions.set(name, options.description);
      },
      registerShortcut: (shortcut: string) => shortcuts.push(shortcut),
      on: vi.fn(),
    } as unknown as ExtensionAPI;

    piHerdrDispatch(pi);

    expect(tools.map((tool) => tool.name)).toEqual([
      "herdr_dispatch_propose",
      "herdr_agents_list",
      "herdr_agent_output_inspect",
      "herdr_dispatch_status",
    ]);
    expect(tools.map((tool) => tool.label)).toEqual([
      "Propose Herdr Dispatch",
      "List Herdr Agents",
      "Inspect Herdr Agent Output",
      "Herdr Dispatch Status",
    ]);
    expect(commands).toEqual([
      "herdr-agents",
      "hd-agents",
      "herdr-dispatch",
      "hd-new",
      "herdr-dispatches",
      "hd-manager",
      "herdr-dispatch-reply",
      "hd-reply",
      "herdr-dispatch-cancel",
      "hd-cancel",
      "herdr-dispatch-resolve",
      "hd-resolve",
      "herdr-dispatch-setup",
      "hd-setup",
      "herdr-agent-output",
      "hd-output",
    ]);
    expect(shortcuts).toEqual(["alt+h"]);
    expect(Object.fromEntries(descriptions)).toEqual({
      "herdr-agents": "List Eligible Agents in the current Herdr workspace",
      "hd-agents": "List Eligible Agents in the current Herdr workspace",
      "herdr-dispatch": "Create and immediately send a Herdr dispatch",
      "hd-new": "Create and immediately send a Herdr dispatch",
      "herdr-dispatches": "Open the Herdr Dispatch Manager",
      "hd-manager": "Open the Herdr Dispatch Manager",
      "herdr-dispatch-reply": "Preview and confirm a reply to an Active Dispatch with attention",
      "hd-reply": "Preview and confirm a reply to an Active Dispatch with attention",
      "herdr-dispatch-cancel": "Preview and confirm a normal cancellation request",
      "hd-cancel": "Preview and confirm a normal cancellation request",
      "herdr-dispatch-resolve": "Manually or emergently resolve a dispatch with confirmation",
      "hd-resolve": "Manually or emergently resolve a dispatch with confirmation",
      "herdr-dispatch-setup": "Explicitly install one Herdr Agent status integration",
      "hd-setup": "Explicitly install one Herdr Agent status integration",
      "herdr-agent-output": "Read one bounded current-workspace Agent output tail",
      "hd-output": "Read one bounded current-workspace Agent output tail",
    });
  });

  it("runs the setup workflow through its short alias", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "status", stderr: "", code: 0 })
      .mockResolvedValueOnce({ stdout: "installed", stderr: "", code: 0 });
    const pi = {
      registerMessageRenderer: (() => undefined) as never,
      registerTool: vi.fn(),
      registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
        commands.set(name, options),
      registerShortcut: vi.fn(),
      on: vi.fn(),
      exec,
    } as unknown as ExtensionAPI;
    piHerdrDispatch(pi);
    const ctx = context("tui");
    vi.mocked(ctx.ui.select).mockResolvedValue("pi");
    vi.mocked(ctx.ui.confirm).mockResolvedValue(true);

    await commands.get("hd-setup")!.handler("", ctx);

    expect(exec).toHaveBeenNthCalledWith(1, "herdr", ["integration", "status"], { cwd: "/repo" });
    expect(exec).toHaveBeenNthCalledWith(2, "herdr", ["integration", "install", "pi"], {
      cwd: "/repo",
    });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it.each(["rpc", "json", "print"] as const)(
    "proposal tool fails before UI or mutation in %s mode",
    async (mode) => {
      const tools: ToolDefinition[] = [];
      const pi = {
        registerMessageRenderer: (() => undefined) as never,
      registerTool: (tool: ToolDefinition) => tools.push(tool),
        registerCommand: vi.fn(),
        registerShortcut: vi.fn(),
        on: vi.fn(),
      } as unknown as ExtensionAPI;
      piHerdrDispatch(pi);
      const proposal = tools.find((tool) => tool.name === "herdr_dispatch_propose")!;
      const ctx = context(mode);

      await expect(
        proposal.execute(
          "call_1",
          { target: "term_1", task: "Inspect", mode: "non-mutating" },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("only in TUI mode");
      expect(ctx.ui.select).not.toHaveBeenCalled();
      expect(ctx.ui.confirm).not.toHaveBeenCalled();
    },
  );
});
