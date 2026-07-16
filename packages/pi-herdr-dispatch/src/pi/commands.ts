import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";

import type { CreateProposalRequest, DispatchApplication } from "../dispatch/application.js";
import type { StoredDispatch } from "../registry/types.js";
import {
  actionCandidates,
  actionIneligibility,
  dispatchChoiceLabel,
  dispatchCompletions,
  resolveDispatchSelector,
} from "./dispatch-command-selection.js";
import { DispatchController } from "./dispatch-controller.js";
import { SETTLED_DISPLAY_LIMIT, type DispatchAction } from "./dispatch-view-model.js";
import { openDispatchView, type DispatchViewPorts } from "./dispatch-view.js";
import { FollowupController } from "./followup-controller.js";
import {
  agentRow,
  formatAgentTable,
  formatDispatchTable,
  formatInspectionText,
} from "./visual.js";
import type { DispatchRuntime } from "./dispatch-runtime.js";
import { UI_COPY } from "./ui-copy.js";

export function registerDispatchCommands(
  pi: ExtensionAPI,
  runtime: DispatchRuntime,
  controller: DispatchController,
  followup: FollowupController,
): void {
  registerCommandWithAlias(pi, "herdr-agents", "hd-agents", {
    description: UI_COPY.command.description("agents"),
    handler: async (_args, ctx) =>
      handle(ctx, async () => {
        ctx.ui.notify(formatAgentTable(await application(runtime).listEligibleAgents()), "info");
      }),
  });

  registerCommandWithAlias(pi, "herdr-dispatch", "hd-new", {
    description: UI_COPY.command.description("new"),
    handler: async (_args, ctx) =>
      handle(ctx, async () => {
        if (ctx.mode !== "tui") throw new Error(UI_COPY.command.dispatchTuiOnly());
        if (runtime.mutationUnavailableReason) throw new Error(runtime.mutationUnavailableReason);
        const app = application(runtime);
        const targets = await app.listEligibleAgents();
        if (targets.length === 0) throw new Error(UI_COPY.command.noEligibleAgents());
        const options = targets.map((target) => {
          const row = agentRow(target);
          return `${row.mark.glyph} ${row.label} · ${row.status} ${row.provenance} · ${row.cwd} · ${row.terminalId}`;
        });
        const selected = await ctx.ui.select(UI_COPY.command.chooseEligibleAgent(), options);
        if (!selected) return;
        const target = targets[options.indexOf(selected)];
        if (!target) throw new Error(UI_COPY.command.selectedAgentUnavailable());
        const task = await ctx.ui.editor(UI_COPY.command.completeTask());
        if (task === undefined) return;
        const mode = await ctx.ui.select(UI_COPY.command.mutationMode(), [
          UI_COPY.state.mode("non-mutating"),
          UI_COPY.state.mode("write"),
        ]);
        if (mode !== "non-mutating" && mode !== "write") return;
        const deadlineInput = await ctx.ui.input(UI_COPY.command.deadlineMinutes(), "30");
        if (deadlineInput === undefined) return;
        const request: CreateProposalRequest = {
          target: target.terminalId,
          task,
          mode,
          deadlineMinutes: Number(deadlineInput),
          allowProjectDependencyInstall:
            mode === "write"
              ? await ctx.ui.confirm(
                  UI_COPY.command.dependencyInstallTitle(),
                  UI_COPY.command.dependencyInstallQuestion(),
                )
              : false,
        };
        const result = await controller.proposeAndDispatch(request, interactionContext(ctx));
        ctx.ui.notify(
          UI_COPY.presentation.confirmationResult(
            result.status,
            "outcome" in result ? String(result.outcome) : undefined,
          ),
          result.status === "active" ? "info" : "warning",
        );
      }),
  });

  let dispatchViewOpen = false;
  const executeFollowup = async (
    action: DispatchAction,
    dispatch: StoredDispatch,
    ctx: ExtensionContext,
  ): Promise<void> => {
    const app = application(runtime);
    const reason = actionIneligibility(
      action,
      dispatch,
      ctx.sessionManager.getSessionId(),
      app.listAttention(dispatch.id),
    );
    if (reason) {
      ctx.ui.notify(reason, dispatch.lifecycle === "settled" ? "info" : "warning");
      return;
    }
    const message = await followup[action](dispatch.id, followupContext(ctx));
    ctx.ui.notify(message, action === "reply" ? "info" : "warning");
  };

  const openPanel = async (ctx: ExtensionContext, action?: DispatchAction): Promise<void> => {
    if (ctx.mode !== "tui") throw new Error(UI_COPY.command.managerTuiOnly());
    if (dispatchViewOpen) return;
    const app = application(runtime);
    const originSessionId = ctx.sessionManager.getSessionId();
    const candidates = () => {
      const all = app.listUnsettledInWorkspace();
      return action
        ? actionCandidates(action, all, originSessionId, (dispatchId) => app.listAttention(dispatchId))
        : all;
    };
    if (action && candidates().length === 0) {
      ctx.ui.notify(emptyActionMessage(action), "info");
      return;
    }
    const ports: DispatchViewPorts = {
      snapshot: () => {
        const dispatches = candidates();
        return {
          originSessionId,
          unsettled: dispatches.map((dispatch) => ({
            dispatch,
            attention: app.listAttention(dispatch.id),
          })),
          settled: action ? [] : app.listRecentSettled(originSessionId, SETTLED_DISPLAY_LIMIT),
        };
      },
      getDispatch: (dispatchId) => app.getDispatch(dispatchId),
      listAttention: (dispatchId) => app.listAttention(dispatchId),
      inspect: async (terminalId, lines) => ({
        text: (await app.inspectAgent(terminalId, lines)).text,
      }),
      onStateChanged: (listener) => runtime.onStateChanged(listener),
    };
    dispatchViewOpen = true;
    let result;
    try {
      result = await openDispatchView(ctx.ui, ports, action ? { action } : {});
    } finally {
      dispatchViewOpen = false;
    }
    if (!result) return;
    const dispatch = app.getDispatch(result.dispatchId);
    if (!dispatch) throw new Error(UI_COPY.command.selectedDispatchUnavailable());
    await executeFollowup(result.action, dispatch, ctx);
  };

  pi.registerShortcut("alt+h", {
    description: UI_COPY.command.description("manager"),
    handler: async (ctx) => handle(ctx, () => openPanel(ctx)),
  });

  registerCommandWithAlias(pi, "herdr-dispatches", "hd-manager", {
    description: UI_COPY.command.description("manager"),
    handler: async (_args, ctx) =>
      handle(ctx, async () => {
        if (ctx.mode === "tui") return openPanel(ctx);
        const app = application(runtime);
        ctx.ui.notify(
          formatDispatchTable(
            app.listUnsettledInWorkspace(),
            (dispatchId) => app.listAttention(dispatchId),
            Date.now(),
          ),
          "info",
        );
      }),
  });

  registerCommandWithAlias(pi, "herdr-dispatch-reply", "hd-reply", {
    description: UI_COPY.command.description("reply"),
    getArgumentCompletions: completionFor("reply", runtime),
    handler: async (args, ctx) =>
      handle(ctx, async () => {
        if (!args.trim()) return openPanel(ctx, "reply");
        const dispatch = await resolveCommandDispatch(application(runtime), args, ctx);
        if (dispatch) await executeFollowup("reply", dispatch, ctx);
      }),
  });

  registerCommandWithAlias(pi, "herdr-dispatch-cancel", "hd-cancel", {
    description: UI_COPY.command.description("cancel"),
    getArgumentCompletions: completionFor("cancel", runtime),
    handler: async (args, ctx) =>
      handle(ctx, async () => {
        if (!args.trim()) return openPanel(ctx, "cancel");
        const dispatch = await resolveCommandDispatch(application(runtime), args, ctx);
        if (dispatch) await executeFollowup("cancel", dispatch, ctx);
      }),
  });

  registerCommandWithAlias(pi, "herdr-dispatch-resolve", "hd-resolve", {
    description: UI_COPY.command.description("resolve"),
    getArgumentCompletions: completionFor("resolve", runtime),
    handler: async (args, ctx) =>
      handle(ctx, async () => {
        if (!args.trim()) return openPanel(ctx, "resolve");
        const dispatch = await resolveCommandDispatch(application(runtime), args, ctx);
        if (dispatch) await executeFollowup("resolve", dispatch, ctx);
      }),
  });

  registerCommandWithAlias(pi, "herdr-dispatch-setup", "hd-setup", {
    description: UI_COPY.command.description("setup"),
    handler: async (_args, ctx) =>
      handle(ctx, async () => {
        if (ctx.mode !== "tui") throw new Error(UI_COPY.command.setupTuiOnly());
        const status = await pi.exec("herdr", ["integration", "status"], { cwd: ctx.cwd });
        ctx.ui.notify(status.stdout || UI_COPY.command.setupNoStatusOutput(), "info");
        const integration = await ctx.ui.select(UI_COPY.command.setupChooseIntegration(), [
          "pi",
          "claude",
          "codex",
          "opencode",
          UI_COPY.command.setupCancel(),
        ]);
        if (!integration || integration === UI_COPY.command.setupCancel()) return;
        const confirmed = await ctx.ui.confirm(
          UI_COPY.command.setupConfirmTitle(integration),
          UI_COPY.command.setupConfirmBody(),
        );
        if (!confirmed) return;
        const result = await pi.exec("herdr", ["integration", "install", integration], {
          cwd: ctx.cwd,
        });
        if (result.code !== 0) {
          throw new Error(result.stderr || UI_COPY.command.setupInstallFailed(result.code));
        }
        ctx.ui.notify(result.stdout || UI_COPY.command.setupInstalled(integration), "info");
      }),
  });

  registerCommandWithAlias(pi, "herdr-agent-output", "hd-output", {
    description: UI_COPY.command.description("output"),
    handler: async (args, ctx) =>
      handle(ctx, async () => {
        const [target, linesText] = args.trim().split(/\s+/u);
        if (!target) throw new Error(UI_COPY.command.outputUsage());
        const inspected = await application(runtime).inspectAgent(
          target,
          linesText === undefined ? 50 : Number(linesText),
        );
        ctx.ui.notify(formatInspectionText(inspected.target.terminalId, inspected.text), "info");
      }),
  });
}

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

function registerCommandWithAlias(
  pi: ExtensionAPI,
  canonicalName: string,
  alias: string,
  options: CommandOptions,
): void {
  pi.registerCommand(canonicalName, options);
  pi.registerCommand(alias, options);
}

function application(runtime: DispatchRuntime): DispatchApplication {
  if (!runtime.application) {
    throw new Error(runtime.mutationUnavailableReason ?? UI_COPY.command.runtimeUnavailable());
  }
  return runtime.application;
}

function followupContext(ctx: ExtensionContext) {
  return { mode: ctx.mode, ui: ctx.ui, sessionId: ctx.sessionManager.getSessionId() };
}

function completionFor(action: DispatchAction, runtime: DispatchRuntime) {
  return (prefix: string) => {
    const app = runtime.application;
    const originSessionId = runtime.originSessionId;
    if (!app || !originSessionId) return null;
    try {
      return dispatchCompletions(
        prefix.trim(),
        action,
        app.listUnsettledInWorkspace(),
        originSessionId,
        (dispatchId) => app.listAttention(dispatchId),
      );
    } catch {
      return null;
    }
  };
}

async function resolveCommandDispatch(
  app: DispatchApplication,
  args: string,
  ctx: ExtensionContext,
): Promise<StoredDispatch | undefined> {
  const selector = args.trim();
  const result = resolveDispatchSelector(app, selector);
  if (result.status === "not-found") {
    throw new Error(UI_COPY.command.dispatchNotFound(selector));
  }
  if (result.status === "matched") return result.dispatch;
  const baseOptions = result.matches.map(dispatchChoiceLabel);
  const options = baseOptions.map((label, index) =>
    baseOptions.indexOf(label) === baseOptions.lastIndexOf(label)
      ? label
      : `${label} · ${result.matches[index]!.id}`,
  );
  const selected = await ctx.ui.select(UI_COPY.command.chooseMatchingDispatch(), options);
  if (!selected) return undefined;
  return result.matches[options.indexOf(selected)];
}

function emptyActionMessage(action: DispatchAction): string {
  return UI_COPY.command.noDispatchForAction(action);
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

async function handle(
  ctx: Pick<ExtensionCommandContext, "ui">,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
}
