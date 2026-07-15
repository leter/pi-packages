import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { CreateProposalRequest, DispatchApplication } from "../dispatch/application.js";
import { DispatchController } from "./dispatch-controller.js";
import { FollowupController } from "./followup-controller.js";
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
  followup: FollowupController,
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

  pi.registerCommand("herdr-dispatch-reply", {
    description: "Preview and confirm a reply to an Active Dispatch with attention",
    handler: async (args, ctx) =>
      handle(ctx, async () => {
        const id = requiredDispatchId(args, "/herdr-dispatch-reply <id>");
        ctx.ui.notify(await followup.reply(id, followupContext(ctx)), "info");
      }),
  });

  pi.registerCommand("herdr-dispatch-cancel", {
    description: "Preview and confirm a normal cancellation request",
    handler: async (args, ctx) =>
      handle(ctx, async () => {
        const id = requiredDispatchId(args, "/herdr-dispatch-cancel <id>");
        ctx.ui.notify(await followup.cancel(id, followupContext(ctx)), "warning");
      }),
  });

  pi.registerCommand("herdr-dispatch-resolve", {
    description: "Manually or emergently resolve a dispatch with confirmation",
    handler: async (args, ctx) =>
      handle(ctx, async () => {
        const id = requiredDispatchId(args, "/herdr-dispatch-resolve <id>");
        ctx.ui.notify(await followup.resolve(id, followupContext(ctx)), "warning");
      }),
  });

  pi.registerCommand("herdr-dispatch-setup", {
    description: "Explicitly install one Herdr Agent status integration",
    handler: async (_args, ctx) =>
      handle(ctx, async () => {
        if (ctx.mode !== "tui") throw new Error("Integration setup is available only in TUI mode");
        const status = await pi.exec("herdr", ["integration", "status"], { cwd: ctx.cwd });
        ctx.ui.notify(status.stdout || "No integration status output.", "info");
        const integration = await ctx.ui.select("Install one Herdr integration", [
          "pi",
          "claude",
          "codex",
          "opencode",
          "Cancel",
        ]);
        if (!integration || integration === "Cancel") return;
        const confirmed = await ctx.ui.confirm(
          `Install Herdr ${integration} integration?`,
          "This explicitly modifies that Agent's local integration configuration. Nothing is installed automatically and only this one selected integration will be changed.",
        );
        if (!confirmed) return;
        const result = await pi.exec("herdr", ["integration", "install", integration], {
          cwd: ctx.cwd,
        });
        if (result.code !== 0) throw new Error(result.stderr || `Herdr integration install exited ${result.code}`);
        ctx.ui.notify(result.stdout || `Installed Herdr ${integration} integration.`, "info");
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

function followupContext(ctx: ExtensionCommandContext) {
  return { mode: ctx.mode, ui: ctx.ui, sessionId: ctx.sessionManager.getSessionId() };
}

function requiredDispatchId(args: string, usage: string): string {
  const id = args.trim();
  if (!/^hd_[A-Za-z0-9_-]+$/u.test(id)) throw new Error(`Usage: ${usage}`);
  return id;
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
