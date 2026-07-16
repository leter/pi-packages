import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { AgentLaunchService } from "../dispatch/agent-launch.js";
import { DispatchApplication } from "../dispatch/application.js";
import { DispatchFollowupService } from "../dispatch/followup.js";
import {
  DEFAULT_DISPATCH_CONFIG,
  defaultConfigPath,
  loadDispatchConfig,
  type DispatchConfig,
} from "../domain/config.js";
import { HerdrAdapter } from "../herdr/adapter.js";
import { OriginMonitor } from "../monitor/origin-monitor.js";
import {
  buildAutoRunPreamble,
  decideSettlementWake,
} from "../settlement/auto-run.js";
import {
  OriginContextDelivery,
  type OriginContextPort,
} from "../settlement/context-delivery.js";
import {
  attentionNotification,
  clearDispatchWidget,
  outcomeNotification,
  updateDispatchWidget,
} from "./live-presentation.js";
import { agentDisplayName, taskSummary } from "./dispatch-view-model.js";
import { RegistryRuntime } from "./registry-runtime.js";
import { UI_COPY } from "./ui-copy.js";

export interface DispatchRuntimeOptions {
  registry?: RegistryRuntime;
  configPath?: string;
  environment?: NodeJS.ProcessEnv;
  sendContextMessage?: OriginContextPort["sendMessage"];
}

export class DispatchRuntime {
  readonly registryRuntime: RegistryRuntime;
  readonly #configPath: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #sendContextMessage?: OriginContextPort["sendMessage"];
  #adapter?: HerdrAdapter;
  #monitor?: OriginMonitor;
  #contextDelivery?: OriginContextDelivery;
  #followup?: DispatchFollowupService;
  #application?: DispatchApplication;
  #agentLauncher?: AgentLaunchService;
  #ui?: ExtensionContext["ui"];
  #originSessionId?: string;
  #workspaceId?: string;
  #config: DispatchConfig = { ...DEFAULT_DISPATCH_CONFIG };
  /** Auto Run Depth for proposals in the currently triggered turn; cleared when the agent run settles. */
  #autoRunTurnDepth?: number;
  #mutationUnavailableReason = UI_COPY.runtime.dispatchSessionNotStarted();
  readonly #stateListeners = new Set<() => void>();

  constructor(options: DispatchRuntimeOptions = {}) {
    this.registryRuntime = options.registry ?? new RegistryRuntime();
    this.#configPath = options.configPath ?? defaultConfigPath();
    this.#environment = options.environment ?? process.env;
    this.#sendContextMessage = options.sendContextMessage;
  }

  get application(): DispatchApplication | undefined {
    return this.#application;
  }

  get followup(): DispatchFollowupService | undefined {
    return this.#followup;
  }

  get agentLauncher(): AgentLaunchService | undefined {
    return this.#agentLauncher;
  }

  get mutationUnavailableReason(): string | undefined {
    return this.#mutationUnavailableReason || undefined;
  }

  get originSessionId(): string | undefined {
    return this.#originSessionId;
  }

  /** Subscribe to dispatch state changes (settlement, attention, delivery intent). */
  onStateChanged(listener: () => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  async start(
    ctx: ExtensionContext,
    reason: "startup" | "reload" | "new" | "resume" | "fork" = "startup",
  ): Promise<boolean> {
    this.stop();
    const registryReady = await this.registryRuntime.start();
    const configState = await loadDispatchConfig(this.#configPath);
    const config = configState.status === "ready" ? configState.config : { ...DEFAULT_DISPATCH_CONFIG };
    this.#config = config;
    if (!registryReady) {
      this.#mutationUnavailableReason =
        this.registryRuntime.unavailableReason ?? UI_COPY.runtime.registryUnavailable();
    } else if (configState.status === "invalid") {
      this.#mutationUnavailableReason = UI_COPY.runtime.invalidConfiguration(configState.reason);
    } else {
      this.#mutationUnavailableReason = "";
    }

    const socketPath = this.#environment.HERDR_SOCKET_PATH;
    const workspaceId = this.#environment.HERDR_WORKSPACE_ID;
    const paneId = this.#environment.HERDR_PANE_ID;
    if (!socketPath || !workspaceId || !paneId) {
      this.#mutationUnavailableReason = UI_COPY.runtime.herdrIdentityUnavailable();
      return false;
    }
    try {
      this.#adapter = await HerdrAdapter.connect({ socketPath, workspaceId });
      const snapshot = await this.#adapter.currentWorkspaceSnapshot();
      const originPane = snapshot.panes.find((pane) => pane.paneId === paneId);
      if (!originPane) throw new Error(UI_COPY.runtime.currentPaneAbsent());
      this.registryRuntime.setActorTerminalId(originPane.terminalId);
      if (ctx.mode === "tui") {
        this.#ui = ctx.ui;
        this.#originSessionId = ctx.sessionManager.getSessionId();
        this.#workspaceId = workspaceId;
      }
      if (this.registryRuntime.registry) {
        const registry = this.registryRuntime.registry;
        if (ctx.mode === "tui") {
          this.#contextDelivery = new OriginContextDelivery(registry, Date.now, reason === "reload");
          this.#monitor = new OriginMonitor({
            registry,
            herdr: this.#adapter,
            config,
            originSessionId: ctx.sessionManager.getSessionId(),
            resumedAfterOriginGap: reason === "resume" || reason === "reload",
            onSettled: async (dispatchId) => {
              await this.#notifyOutcome(dispatchId);
              await this.deliverPendingContext(ctx, dispatchId);
            },
            onAttention: async (dispatchId, condition) => {
              await this.#notifyAttention(dispatchId, condition);
            },
            onChanged: () => this.#updateWidget(),
          });
        }
        this.#followup = new DispatchFollowupService({
          registry,
          herdr: this.#adapter,
          config,
          workspaceId,
          onSettled: (dispatchId) => void this.#notifyOutcome(dispatchId),
        });
        this.#application = new DispatchApplication({
          config,
          registry,
          herdr: this.#adapter,
          workspaceId,
          originTerminalId: originPane.terminalId,
          currentAutoRunDepth: () => this.#autoRunTurnDepth ?? 0,
          ...(this.#monitor === undefined
            ? {}
            : {
                prepareMonitoring: (targets) => this.#monitor!.watchTargets(targets),
                onIntentRecorded: async () => {
                  await this.#monitor!.refresh();
                  this.#updateWidget();
                },
              }),
          onSettled: (dispatchId) => void this.#notifyOutcome(dispatchId),
        });
        if (ctx.mode === "tui") {
          this.#agentLauncher = new AgentLaunchService({
            herdr: this.#adapter,
            workspaceId,
            originPaneId: originPane.paneId,
            startupTimeoutMs: config.agentStartupTimeoutMs,
          });
        }
        await this.#monitor?.start();
        this.#updateWidget();
        if (this.autoRunState()?.armed) await this.#notifyAutoRunArmedOnStart();
        await this.deliverPendingContext(ctx);
      }
      return this.#application !== undefined;
    } catch (error) {
      this.#adapter?.close();
      this.#adapter = undefined;
      this.#application = undefined;
      this.#agentLauncher = undefined;
      this.#mutationUnavailableReason = UI_COPY.runtime.adapterUnavailable(errorMessage(error));
      return false;
    }
  }

  async deliverPendingContext(ctx: ExtensionContext, onlyDispatchId?: string): Promise<void> {
    if (ctx.mode !== "tui" || !this.#contextDelivery || !this.#sendContextMessage) return;
    const registry = this.registryRuntime.registry;
    if (!registry) return;
    const context = this.#contextPort(ctx);
    const sessionId = ctx.sessionManager.getSessionId();
    const armed =
      this.#mutationUnavailableReason === "" && registry.isAutoRunArmed(sessionId);
    const pending = onlyDispatchId
      ? [registry.getDispatch(onlyDispatchId)].filter((item) => item !== undefined)
      : registry.listPendingContextDelivery(sessionId);
    for (const dispatch of pending) {
      if (dispatch.originSessionId !== sessionId) continue;
      const decision = decideSettlementWake({
        armed,
        dispatch,
        maxAutoRunDepth: this.#config.maxAutoRunDepth,
      });
      if (decision.wake) {
        // The marker outlives this delivery until the triggered run settles, so
        // proposals created in the woken turn inherit max(settled depths) + 1.
        this.#autoRunTurnDepth = Math.max(this.#autoRunTurnDepth ?? 0, decision.nextDepth);
        this.#contextDelivery.deliver(dispatch.id, context, {
          preamble: buildAutoRunPreamble(decision.remainingBudget),
        });
        continue;
      }
      const delivered = this.#contextDelivery.deliver(dispatch.id, context);
      if (decision.reason === "depth-exhausted" && delivered === "delivered") {
        await this.#notifyAutoRunDepthExhausted(dispatch.id);
      }
    }
  }

  /** Clears the Auto Run turn marker; wired to agent_settled, when queued continuations are drained. */
  clearAutoRunTurnMarker(): void {
    this.#autoRunTurnDepth = undefined;
  }

  autoRunState(): { armed: boolean; maxDepth: number } | undefined {
    const registry = this.registryRuntime.registry;
    if (!registry || !this.#originSessionId) return undefined;
    return {
      armed: registry.isAutoRunArmed(this.#originSessionId),
      maxDepth: this.#config.maxAutoRunDepth,
    };
  }

  setAutoRunArmed(armed: boolean): void {
    if (this.#mutationUnavailableReason) throw new Error(this.#mutationUnavailableReason);
    const registry = this.registryRuntime.registry;
    if (!registry || !this.#originSessionId) {
      throw new Error(UI_COPY.command.runtimeUnavailable());
    }
    if (armed) registry.armAutoRun(this.#originSessionId, Date.now());
    else registry.disarmAutoRun(this.#originSessionId, Date.now());
    this.#updateWidget();
  }

  stop(): void {
    if (this.#ui) clearDispatchWidget(this.#ui);
    this.#ui = undefined;
    this.#originSessionId = undefined;
    this.#workspaceId = undefined;
    this.#autoRunTurnDepth = undefined;
    this.#monitor?.stop();
    this.#monitor = undefined;
    this.#contextDelivery = undefined;
    this.#followup = undefined;
    this.#agentLauncher = undefined;
    this.#adapter?.close();
    this.#adapter = undefined;
    this.#application = undefined;
    this.registryRuntime.stop();
    if (!this.#mutationUnavailableReason) {
      this.#mutationUnavailableReason = UI_COPY.runtime.dispatchSessionStopped();
    }
  }

  async #notifyAutoRunDepthExhausted(dispatchId: string): Promise<void> {
    const dispatch = this.registryRuntime.registry?.getDispatch(dispatchId);
    if (!dispatch || !this.#adapter) return;
    try {
      await this.#adapter.showNotification({
        title: UI_COPY.notification.autoRunDepthExhaustedTitle(
          agentDisplayName(dispatch),
        ),
        body: UI_COPY.notification.autoRunDepthExhaustedBody(taskSummary(dispatch.task, 80)),
        sound: "request",
      });
    } catch {
      // The queued result and widget counts remain authoritative.
    }
  }

  async #notifyAutoRunArmedOnStart(): Promise<void> {
    if (!this.#adapter) return;
    try {
      await this.#adapter.showNotification({
        title: UI_COPY.notification.autoRunActiveTitle(),
        body: UI_COPY.notification.autoRunActiveBody(this.#config.maxAutoRunDepth),
        sound: "none",
      });
    } catch {
      // The persistent widget segment remains the authoritative signal.
    }
  }

  async #notifyOutcome(dispatchId: string): Promise<void> {
    const dispatch = this.registryRuntime.registry?.getDispatch(dispatchId);
    if (!dispatch?.finalOutcome || !this.#adapter) return;
    try {
      await this.#adapter.showNotification(
        outcomeNotification(dispatch, dispatch.finalOutcome),
      );
    } catch {
      // Durable state and the Pi widget remain authoritative when desktop notification fails.
    }
    this.#updateWidget();
  }

  async #notifyAttention(
    dispatchId: string,
    condition: Parameters<typeof attentionNotification>[1],
  ): Promise<void> {
    const dispatch = this.registryRuntime.registry?.getDispatch(dispatchId);
    if (!dispatch) return;
    if (this.#adapter) {
      try {
        await this.#adapter.showNotification(attentionNotification(dispatch, condition));
      } catch {
        // Attention is already durable; notification transport is best effort.
      }
    }
    this.#updateWidget();
  }

  #updateWidget(): void {
    for (const listener of this.#stateListeners) listener();
    if (!this.#ui || !this.#originSessionId || !this.#workspaceId || !this.registryRuntime.registry) return;
    updateDispatchWidget(
      this.#ui,
      this.registryRuntime.registry,
      this.#originSessionId,
      this.#workspaceId,
    );
  }

  #contextPort(ctx: ExtensionContext): OriginContextPort {
    return {
      getSessionId: () => ctx.sessionManager.getSessionId(),
      getLeafId: () => ctx.sessionManager.getLeafId(),
      getBranch: () => ctx.sessionManager.getBranch(),
      sendMessage: (message, options) => this.#sendContextMessage!(message, options),
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
