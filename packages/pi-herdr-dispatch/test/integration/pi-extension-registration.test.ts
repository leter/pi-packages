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
    const pi = {
      registerTool: (tool: ToolDefinition) => tools.push(tool),
      registerCommand: (name: string) => commands.push(name),
      on: vi.fn(),
    } as unknown as ExtensionAPI;

    piHerdrDispatch(pi);

    expect(tools.map((tool) => tool.name)).toEqual([
      "herdr_dispatch_propose",
      "herdr_agents_list",
      "herdr_agent_output_inspect",
      "herdr_dispatch_status",
    ]);
    expect(commands).toEqual([
      "herdr-agents",
      "herdr-dispatch",
      "herdr-dispatches",
      "herdr-agent-output",
    ]);
  });

  it.each(["rpc", "json", "print"] as const)(
    "proposal tool fails before UI or mutation in %s mode",
    async (mode) => {
      const tools: ToolDefinition[] = [];
      const pi = {
        registerTool: (tool: ToolDefinition) => tools.push(tool),
        registerCommand: vi.fn(),
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
