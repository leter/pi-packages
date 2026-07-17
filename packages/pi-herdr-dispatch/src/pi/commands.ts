import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type RegisteredCommand,
} from "@earendil-works/pi-coding-agent";

import {
  AgentLaunchCancelledError,
  AgentLaunchError,
  type AgentLaunchLayout,
  type AgentLaunchService,
  type SupportedAgentType,
} from "../dispatch/agent-launch.js";
import type { CreateProposalRequest, DispatchApplication } from "../dispatch/application.js";
import type { HerdrPane } from "../herdr/protocol.js";
import type { StoredDispatch } from "../registry/types.js";
import type {
  TaskWorktree,
  TaskWorktreeEntry,
  TaskWorktreePlan,
  TaskWorktreeService,
} from "../domain/task-worktree.js";
import { firstTaskLine } from "../domain/task-worktree-path.js";
import { launchableAgentTypes } from "./agent-launch-catalog.js";
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
  sanitizedResultCard,
  displayWidth,
  shortenPath,
} from "./visual.js";
import type { DispatchRuntime } from "./dispatch-runtime.js";
import { selectDomainValue } from "./select-value.js";
import { UI_COPY } from "./ui-copy.js";

export function registerDispatchCommands(
  pi: ExtensionAPI,
  runtime: DispatchRuntime,
  controller: DispatchController,
  followup: FollowupController,
): void {
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
          return `${row.mark.glyph} ${row.label} · ${row.status} ${row.provenance} · ${UI_COPY.common.worktree(row.worktree)} · ${row.terminalId}`;
        });
        const selected = await ctx.ui.select(UI_COPY.command.chooseEligibleAgent(), options);
        if (!selected) return;
        const target = targets[options.indexOf(selected)];
        if (!target) throw new Error(UI_COPY.command.selectedAgentUnavailable());
        const request = await collectDispatchWizard(ctx, UI_COPY.command.completeTask());
        if (!request) return;
        if (request.mode === "write" && target.worktreePath) {
          try {
            if (await app.sharesCanonicalWorktree(target.worktreePath, ctx.cwd)) {
              ctx.ui.notify(UI_COPY.command.sharedWorktreeHint(), "info");
            }
          } catch {
            // The write proposal's normal validation remains authoritative.
          }
        }
        await dispatchRequest(ctx, target.terminalId, request);
      }),
  });

  registerCommandWithAlias(pi, "herdr-dispatch-create", "hd-create", {
    description: UI_COPY.command.description("create"),
    handler: async (_args, ctx) =>
      handle(ctx, async () => {
        if (ctx.mode !== "tui") throw new Error(UI_COPY.command.createTuiOnly());
        if (runtime.mutationUnavailableReason) throw new Error(runtime.mutationUnavailableReason);
        const launcher = agentLauncher(runtime);
        const integrationStatus = await pi.exec("herdr", ["integration", "status"], { cwd: ctx.cwd });
        if (integrationStatus.code !== 0) {
          throw new Error(
            UI_COPY.command.integrationStatusFailed(
              integrationStatus.stderr || `exit ${integrationStatus.code}`,
            ),
          );
        }
        const agentTypes = await launchableAgentTypes(integrationStatus.stdout);
        if (agentTypes.length === 0) throw new Error(UI_COPY.command.noLaunchableAgents());
        const selectedType = await selectDomainValue(
          (title, options) => ctx.ui.select(title, options),
          UI_COPY.command.chooseAgentType(),
          agentTypes,
          (value) => value,
        );
        if (selectedType === undefined) return;
        const layout = await selectDomainValue(
          (title, options) => ctx.ui.select(title, options),
          UI_COPY.command.chooseAgentLayout(),
          ["adaptive", "right", "down", "new-tab"] as const,
          (value) => UI_COPY.command.agentLayout(value),
        );
        if (layout === undefined) return;
        const request = await collectDispatchWizard(ctx, UI_COPY.command.completeTask());
        if (!request) return;
        let launchCwd = ctx.cwd;
        let taskWorktree: TaskWorktree | undefined;
        if (request.mode === "write") {
          const placement = await selectDomainValue(
            (title, options) => ctx.ui.select(title, options),
            UI_COPY.command.taskWorktreePlacement(),
            ["task-worktree", "current-directory"] as const,
            (value) =>
              value === "task-worktree"
                ? UI_COPY.command.newTaskWorktreePlacement()
                : UI_COPY.command.currentDirectoryPlacement(),
          );
          if (placement === undefined) return;
          if (placement === "task-worktree") {
            let plan: TaskWorktreePlan;
            try {
              const service = taskWorktrees(runtime);
              plan = await service.plan(ctx.cwd, request.task);
              application(runtime).assertCanCreateTargetAtWorktree(request, plan.path);
            } catch (error) {
              throw new Error(UI_COPY.command.agentCreationPreflightFailed(errorMessage(error)), {
                cause: error,
              });
            }
            try {
              taskWorktree = await taskWorktrees(runtime).create(plan);
              launchCwd = taskWorktree.path;
            } catch (error) {
              throw new Error(UI_COPY.command.taskWorktreeCreationFailed(errorMessage(error)), {
                cause: error,
              });
            }
          }
        }
        try {
          await application(runtime).assertCanCreateTarget({ ...request, cwd: launchCwd });
        } catch (error) {
          throw new Error(UI_COPY.command.agentCreationPreflightFailed(errorMessage(error)), {
            cause: error,
          });
        }
        const launched = await launchAgentWithLoader(
          ctx,
          launcher,
          selectedType,
          layout,
          launchCwd,
          createAgentLabel(selectedType, request.task),
        );
        if (launched.status === "cancelled") {
          ctx.ui.notify(
            UI_COPY.command.agentCreationCancelled(
              createdResourceLocation(launched.createdPane, taskWorktree?.path),
            ),
            "warning",
          );
          return;
        }
        if (launched.status === "failed") {
          throw new Error(
            UI_COPY.command.agentCreationFailed(
              errorMessage(launched.error),
              createdResourceLocation(
                launched.error instanceof AgentLaunchError
                  ? launched.error.createdPane
                  : undefined,
                taskWorktree?.path,
              ),
            ),
            { cause: launched.error },
          );
        }
        await dispatchRequest(ctx, launched.terminalId, request);
      }),
  });

  registerCommandWithAlias(pi, "herdr-agents", "hd-agents", {
    description: UI_COPY.command.description("agents"),
    handler: async (_args, ctx) =>
      handle(ctx, async () => {
        ctx.ui.notify(formatAgentTable(await application(runtime).listEligibleAgents()), "info");
      }),
  });

  /** Shared tail of the dispatch wizard: task, mode, deadline, dependency consent. */
  const collectDispatchWizard = async (
    ctx: ExtensionContext,
    taskTitle: string,
  ): Promise<Omit<CreateProposalRequest, "target"> | undefined> => {
    const task = await ctx.ui.editor(taskTitle);
    if (task === undefined) return;
    const mode = await selectDomainValue(
      (title, options) => ctx.ui.select(title, options),
      UI_COPY.command.mutationMode(),
      ["write", "non-mutating"] as const,
      (value) => UI_COPY.state.mode(value),
    );
    if (mode === undefined) return;
    const defaultDeadlineMinutes = application(runtime).defaultDeadlineMinutes;
    const deadlineInput = await ctx.ui.input(
      UI_COPY.command.deadlineMinutes(defaultDeadlineMinutes),
      String(defaultDeadlineMinutes),
    );
    if (deadlineInput === undefined) return;
    return {
      task,
      mode,
      deadlineMinutes:
        deadlineInput.trim() === "" ? defaultDeadlineMinutes : Number(deadlineInput),
      allowProjectDependencyInstall:
        mode === "write"
          ? await ctx.ui.confirm(
              UI_COPY.command.dependencyInstallTitle(),
              UI_COPY.command.dependencyInstallQuestion(),
            )
          : false,
    };
  };

  const dispatchRequest = async (
    ctx: ExtensionContext,
    targetTerminalId: string,
    request: Omit<CreateProposalRequest, "target">,
  ): Promise<void> => {
    const result = await controller.proposeAndDispatch(
      { ...request, target: targetTerminalId },
      interactionContext(ctx),
    );
    ctx.ui.notify(
      UI_COPY.presentation.confirmationResult(
        result.status,
        "outcome" in result ? String(result.outcome) : undefined,
      ),
      result.status === "active" ? "info" : "warning",
    );
  };

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
        const unseenSettled = action ? [] : app.listUnseenSettled();
        const unseenIds = new Set(unseenSettled.map((dispatch) => dispatch.id));
        return {
          originSessionId,
          autoRunArmed: runtime.autoRunState()?.armed ?? false,
          runQuotaRemaining: runtime.autoRunState()?.remainingQuota,
          tasks: action ? [] : app.listTasks(),
          unsettled: dispatches.map((dispatch) => ({
            dispatch,
            attention: app.listAttention(dispatch.id),
          })),
          unseenSettled,
          settled: action
            ? []
            : app
                .listRecentSettledInWorkspace(SETTLED_DISPLAY_LIMIT)
                .filter((dispatch) => !unseenIds.has(dispatch.id)),
        };
      },
      getDispatch: (dispatchId) => app.getDispatch(dispatchId),
      listAttention: (dispatchId) => app.listAttention(dispatchId),
      markResultSeen: (dispatchId) => app.markResultSeen(dispatchId, Date.now()),
      markResultsSeen: (dispatchIds) => app.markResultsSeen(dispatchIds, Date.now()),
      getResult: (dispatchId) => sanitizedResultCard(app.getResult(dispatchId)?.sanitizedResult),
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
    if ("taskIds" in result) {
      let changed: number;
      try {
        changed = result.action === "task-approve"
          ? app.approveTasks(result.taskIds, Date.now())
          : app.acceptTasks(result.taskIds, Date.now());
      } catch (error) {
        throw new Error(UI_COPY.command.taskOperationFailed(), { cause: error });
      }
      ctx.ui.notify(
        result.action === "task-approve"
          ? UI_COPY.command.tasksApproved(changed)
          : UI_COPY.command.tasksAccepted(changed),
        "info",
      );
      return openPanel(ctx);
    }
    if ("taskId" in result) {
      const task = app.listTasks().find((candidate) => candidate.id === result.taskId);
      if (!task) throw new Error(UI_COPY.command.selectedTaskUnavailable());
      if (result.action === "task-delete") {
        const confirmed = await ctx.ui.confirm(
          UI_COPY.command.taskDeleteConfirm(task.title),
          UI_COPY.command.taskDeleteConfirmBody(),
        );
        if (confirmed) {
          try {
            app.deleteDraft(task.id, Date.now());
          } catch (error) {
            throw new Error(UI_COPY.command.taskOperationFailed(), { cause: error });
          }
          ctx.ui.notify(UI_COPY.command.taskDraftDeleted(), "info");
        }
      } else {
        const feedback = await ctx.ui.editor(UI_COPY.command.taskReturnFeedback());
        if (feedback !== undefined) {
          try {
            app.returnTask(task.id, feedback, Date.now());
          } catch (error) {
            throw new Error(UI_COPY.command.taskOperationFailed(), { cause: error });
          }
          ctx.ui.notify(UI_COPY.command.taskReturned(), "info");
        }
      }
      return openPanel(ctx);
    }
    const dispatch = app.getDispatch(result.dispatchId);
    if (!dispatch) throw new Error(UI_COPY.command.selectedDispatchUnavailable());
    if (result.action === "redispatch") {
      if (runtime.mutationUnavailableReason) throw new Error(runtime.mutationUnavailableReason);
      const target = (await app.listEligibleAgents()).find(
        (candidate) => candidate.terminalId === dispatch.targetTerminalId,
      );
      if (!target) {
        const exists = await app.agentTerminalExists(dispatch.targetTerminalId);
        ctx.ui.notify(
          exists
            ? UI_COPY.command.redispatchTargetBusy()
            : UI_COPY.command.redispatchTargetGone(),
          "warning",
        );
        return;
      }
      const request = await collectDispatchWizard(ctx, UI_COPY.command.followupTask());
      if (request) await dispatchRequest(ctx, target.terminalId, request);
      return;
    }
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

  registerCommandWithAlias(pi, "herdr-task", "hd-task", {
    description: UI_COPY.command.description("task"),
    handler: async (_args, ctx) =>
      handle(ctx, async () => {
        if (ctx.mode !== "tui") throw new Error(UI_COPY.command.taskTuiOnly());
        if (runtime.mutationUnavailableReason) throw new Error(runtime.mutationUnavailableReason);
        const selected = await ctx.ui.select(UI_COPY.command.taskAction(), [
          UI_COPY.command.taskManualEntry(),
          UI_COPY.command.taskOpenBoard(),
        ]);
        if (!selected) return;
        if (selected === UI_COPY.command.taskOpenBoard()) return openPanel(ctx);
        const title = await ctx.ui.input(UI_COPY.command.taskTitle());
        if (title === undefined) return;
        const task = await ctx.ui.editor(UI_COPY.command.taskText());
        if (task === undefined) return;
        const mode = await selectDomainValue(
          (selectTitle, options) => ctx.ui.select(selectTitle, options),
          UI_COPY.command.mutationMode(),
          ["write", "non-mutating"] as const,
          (value) => UI_COPY.state.mode(value),
        );
        if (mode === undefined) return;
        let entries: readonly TaskWorktreeEntry[] = [];
        try {
          entries = await taskWorktrees(runtime).list(ctx.cwd);
        } catch {
          // Manual drafts may omit a preference outside a Git worktree.
        }
        const none = UI_COPY.command.taskNoPreferredWorktree();
        const labels = entries.map((entry) => shortenPath(entry.path, 60));
        const preferred = await ctx.ui.select(UI_COPY.command.taskPreferredWorktree(), [
          none,
          ...labels,
        ]);
        if (preferred === undefined) return;
        const preferredWorktreePath = preferred === none
          ? undefined
          : entries[labels.indexOf(preferred)]?.path;
        try {
          application(runtime).createTask({
            title,
            task,
            mode,
            ...(preferredWorktreePath === undefined ? {} : { preferredWorktreePath }),
            createdBy: "user",
            createdAt: Date.now(),
          });
        } catch (error) {
          throw new Error(UI_COPY.command.taskDraftInvalid(), { cause: error });
        }
        ctx.ui.notify(UI_COPY.command.taskDraftCreated(), "info");
        await openPanel(ctx);
      }),
  });

  registerCommandWithAlias(pi, "herdr-dispatch-auto", "hd-auto", {
    description: UI_COPY.command.description("auto"),
    getArgumentCompletions: () => ["on", "off"].map((value) => ({ value, label: value })),
    handler: async (args, ctx) =>
      handle(ctx, async () => {
        const argument = args.trim().toLowerCase();
        if (argument === "") {
          const state = runtime.autoRunState();
          if (!state) {
            throw new Error(
              runtime.mutationUnavailableReason ?? UI_COPY.command.runtimeUnavailable(),
            );
          }
          ctx.ui.notify(
            UI_COPY.command.autoStatus(state.armed, state.maxDepth, state.remainingQuota),
            "info",
          );
          return;
        }
        const [action, quotaText, extra] = argument.split(/\s+/u);
        if ((action !== "on" && action !== "off") || extra || (action === "off" && quotaText)) {
          throw new Error(UI_COPY.command.autoUsage());
        }
        if (ctx.mode !== "tui") throw new Error(UI_COPY.command.autoTuiOnly());
        const quota = quotaText === undefined ? undefined : Number(quotaText);
        if (quota !== undefined && (!Number.isSafeInteger(quota) || quota < 1 || quota > 50)) {
          throw new Error(UI_COPY.command.autoUsage());
        }
        runtime.setAutoRunArmed(action === "on", quota);
        const state = runtime.autoRunState();
        ctx.ui.notify(
          action === "on"
            ? UI_COPY.command.autoEnabled(
                state?.maxDepth ?? 0,
                state?.remainingQuota ?? quota ?? 0,
              )
            : UI_COPY.command.autoDisabled(),
          "info",
        );
      }),
  });

  registerCommandWithAlias(pi, "herdr-dispatch-clean", "hd-clean", {
    description: UI_COPY.command.description("clean"),
    handler: async (_args, ctx) =>
      handle(ctx, async () => {
        if (ctx.mode !== "tui") throw new Error(UI_COPY.command.cleanTuiOnly());
        if (runtime.mutationUnavailableReason) throw new Error(runtime.mutationUnavailableReason);
        const service = taskWorktrees(runtime);
        const entries = await service.list(ctx.cwd);
        if (entries.length === 0) {
          ctx.ui.notify(UI_COPY.command.noTaskWorktrees(), "info");
          return;
        }
        const removable = entries.filter((entry) => entry.removable);
        const allOption =
          removable.length > 1
            ? UI_COPY.command.cleanAllTaskWorktrees(removable.length)
            : undefined;
        const entryOptions = new Map(
          entries.map((entry) => [taskWorktreeCleanupLabel(entry), entry] as const),
        );
        const selected = await ctx.ui.select(UI_COPY.command.chooseTaskWorktreeCleanup(), [
          ...(allOption ? [allOption] : []),
          ...entryOptions.keys(),
        ]);
        if (!selected) return;
        const selectedEntry = entryOptions.get(selected);
        if (selectedEntry && !selectedEntry.removable) {
          ctx.ui.notify(taskWorktreeCleanupLabel(selectedEntry), "warning");
          return;
        }
        const selectedEntries =
          selected === allOption ? removable : selectedEntry ? [selectedEntry] : [];
        if (selectedEntries.length === 0) return;
        const confirmed = await ctx.ui.confirm(
          UI_COPY.command.taskWorktreeCleanupConfirm(selectedEntries.length),
          UI_COPY.command.taskWorktreeCleanupConfirmBody(
            selectedEntries.map((entry) => entry.path),
          ),
        );
        if (!confirmed) return;
        let removed = 0;
        for (const entry of selectedEntries) {
          try {
            await service.remove(ctx.cwd, entry);
            removed += 1;
          } catch (error) {
            ctx.ui.notify(
              UI_COPY.command.taskWorktreeCleanupFailed(entry.path, errorMessage(error)),
              "warning",
            );
          }
        }
        if (removed > 0) {
          ctx.ui.notify(UI_COPY.command.taskWorktreeCleanupComplete(removed), "info");
        }
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

type AgentLoaderResult =
  | { status: "ready"; terminalId: string }
  | { status: "cancelled"; createdPane?: HerdrPane }
  | { status: "failed"; error: unknown };

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

async function launchAgentWithLoader(
  ctx: ExtensionContext,
  launcher: AgentLaunchService,
  agentType: SupportedAgentType,
  layout: AgentLaunchLayout,
  cwd: string,
  label: string,
): Promise<AgentLoaderResult> {
  return ctx.ui.custom<AgentLoaderResult>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, UI_COPY.command.creatingAgent(agentType));
    let settled = false;
    const finish = (result: AgentLoaderResult) => {
      if (settled) return;
      settled = true;
      done(result);
    };
    loader.onAbort = () => undefined;
    void launcher
      .launch({ agentType, layout, cwd, label, signal: loader.signal })
      .then((target) => finish({ status: "ready", terminalId: target.terminalId }))
      .catch((error: unknown) =>
        finish(
          error instanceof AgentLaunchCancelledError
            ? { status: "cancelled", createdPane: error.createdPane }
            : { status: "failed", error },
        ),
      );
    return loader;
  });
}

function createdResourceLocation(pane?: HerdrPane, worktreePath?: string): string | undefined {
  return UI_COPY.command.createdResourceLocation(pane?.paneId, pane?.tabId, worktreePath);
}

function createAgentLabel(agentType: SupportedAgentType, task: string): string {
  // The label travels over the Herdr protocol, which rejects control
  // characters, so it must never pass through an ANSI-emitting TUI helper.
  const text = `${agentType} · ${firstTaskLine(task)}`;
  if (displayWidth(text) <= 48) return text;
  let shown = "";
  for (const point of text) {
    if (displayWidth(`${shown}${point}`) > 47) break;
    shown += point;
  }
  return `${shown}…`;
}

function registerCommandWithAlias(
  pi: ExtensionAPI,
  canonicalName: string,
  alias: string,
  options: CommandOptions,
): void {
  pi.registerCommand(canonicalName, options);
  pi.registerCommand(alias, options);
}

function agentLauncher(runtime: DispatchRuntime): AgentLaunchService {
  if (!runtime.agentLauncher) {
    throw new Error(runtime.mutationUnavailableReason ?? UI_COPY.command.runtimeUnavailable());
  }
  return runtime.agentLauncher;
}

function taskWorktrees(runtime: DispatchRuntime): TaskWorktreeService {
  if (!runtime.taskWorktrees) {
    throw new Error(runtime.mutationUnavailableReason ?? UI_COPY.command.runtimeUnavailable());
  }
  return runtime.taskWorktrees;
}

function taskWorktreeCleanupLabel(entry: TaskWorktreeEntry): string {
  return UI_COPY.command.taskWorktreeCleanupEntry(
    shortenPath(entry.path, 54),
    entry.branch,
    entry.reasons.map((reason) => UI_COPY.command.taskWorktreeRefusalReason(reason)),
  );
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

function interactionContext(ctx: ExtensionContext) {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
