import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { CreateProposalRequest, DispatchApplication } from "../dispatch/application.js";
import { DispatchController } from "./dispatch-controller.js";
import {
  formatAgentData,
  formatConfirmationResult,
  formatDispatchList,
  formatInspectionData,
} from "./presentation.js";
import type { DispatchRuntime } from "./dispatch-runtime.js";

export function registerDispatchCommands(
  pi: ExtensionAPI,
  runtime: DispatchRuntime,
  controller: DispatchController,
): void {
  pi.registerCommand("herdr-agents", {
    description: "List Eligible Agents in the current Herdr workspace",
    handler: async (_args, ctx) =>
      handle(ctx, async () => {
        ctx.ui.notify(formatAgentData(await application(runtime).listEligibleAgents()), "info");
      }),
  });

  pi.registerCommand("herdr-dispatch", {
    description: "Create, preview, and confirm a Herdr dispatch",
    handler: async (_args, ctx) =>
      handle(ctx, async () => {
        if (ctx.mode !== "tui") throw new Error("Dispatch confirmation is available only in TUI mode");
        if (runtime.mutationUnavailableReason) throw new Error(runtime.mutationUnavailableReason);
        const app = application(runtime);
        const targets = await app.listEligibleAgents();
        if (targets.length === 0) throw new Error("No Eligible Agents are available");
        const options = targets.map(
          (target) =>
            `${target.displayName ?? target.agentLabel} · ${target.status} (${target.statusProvenance}) · ${target.terminalId}`,
        );
        const selected = await ctx.ui.select("Choose an Eligible Agent", options);
        if (!selected) return;
        const target = targets[options.indexOf(selected)];
        if (!target) throw new Error("Selected Agent is no longer available");
        const task = await ctx.ui.editor("Complete dispatch task");
        if (task === undefined) return;
        const mode = await ctx.ui.select("Dispatch mutation mode", ["non-mutating", "write"]);
        if (mode !== "non-mutating" && mode !== "write") return;
        const deadlineInput = await ctx.ui.input("Deadline in minutes", "30");
        if (deadlineInput === undefined) return;
        const request: CreateProposalRequest = {
          target: target.terminalId,
          task,
          mode,
          deadlineMinutes: Number(deadlineInput),
          allowProjectDependencyInstall:
            mode === "write"
              ? await ctx.ui.confirm(
                  "Project dependency installation",
                  "Explicitly allow project-local dependency installation?",
                )
              : false,
        };
        const result = await controller.proposeAndConfirm(request, interactionContext(ctx));
        ctx.ui.notify(formatConfirmationResult(result), result.status === "active" ? "info" : "warning");
      }),
  });

  pi.registerCommand("herdr-dispatches", {
    description: "List unsettled dispatches for this Origin Session",
    handler: async (_args, ctx) =>
      handle(ctx, async () => {
        ctx.ui.notify(
          formatDispatchList(application(runtime).listUnsettled(ctx.sessionManager.getSessionId())),
          "info",
        );
      }),
  });

  pi.registerCommand("herdr-agent-output", {
    description: "Read one bounded current-workspace Agent output tail",
    handler: async (args, ctx) =>
      handle(ctx, async () => {
        const [target, linesText] = args.trim().split(/\s+/u);
        if (!target) throw new Error("Usage: /herdr-agent-output <target> [lines]");
        const inspected = await application(runtime).inspectAgent(
          target,
          linesText === undefined ? 50 : Number(linesText),
        );
        ctx.ui.notify(formatInspectionData(inspected.target.terminalId, inspected.text), "info");
      }),
  });
}

function application(runtime: DispatchRuntime): DispatchApplication {
  if (!runtime.application) {
    throw new Error(runtime.mutationUnavailableReason ?? "Dispatch runtime unavailable");
  }
  return runtime.application;
}

function interactionContext(ctx: ExtensionCommandContext) {
  const sessionFile = ctx.sessionManager.getSessionFile();
  return {
    mode: ctx.mode,
    ui: ctx.ui,
    origin: {
      sessionId: ctx.sessionManager.getSessionId(),
      ...(sessionFile === undefined ? {} : { sessionFile }),
    },
  };
}

async function handle(ctx: ExtensionCommandContext, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
}
