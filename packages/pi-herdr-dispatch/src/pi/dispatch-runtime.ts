import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { DispatchApplication } from "../dispatch/application.js";
import { DispatchFollowupService } from "../dispatch/followup.js";
import {
  DEFAULT_DISPATCH_CONFIG,
  defaultConfigPath,
  loadDispatchConfig,
} from "../domain/config.js";
import { HerdrAdapter } from "../herdr/adapter.js";
import { OriginMonitor } from "../monitor/origin-monitor.js";
import {
  OriginContextDelivery,
  type OriginContextPort,
} from "../settlement/context-delivery.js";
import { RegistryRuntime } from "./registry-runtime.js";

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
  #mutationUnavailableReason = "Dispatch runtime session has not started";

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

  get mutationUnavailableReason(): string | undefined {
    return this.#mutationUnavailableReason || undefined;
  }

  async start(
    ctx: ExtensionContext,
    reason: "startup" | "reload" | "new" | "resume" | "fork" = "startup",
  ): Promise<boolean> {
    this.stop();
    const registryReady = await this.registryRuntime.start();
    const configState = await loadDispatchConfig(this.#configPath);
    const config = configState.status === "ready" ? configState.config : { ...DEFAULT_DISPATCH_CONFIG };
    if (!registryReady) {
      this.#mutationUnavailableReason =
        this.registryRuntime.unavailableReason ?? "Dispatch Registry unavailable";
    } else if (configState.status === "invalid") {
      this.#mutationUnavailableReason = `Invalid dispatch configuration: ${configState.reason}`;
    } else {
      this.#mutationUnavailableReason = "";
    }

    const socketPath = this.#environment.HERDR_SOCKET_PATH;
    const workspaceId = this.#environment.HERDR_WORKSPACE_ID;
    const paneId = this.#environment.HERDR_PANE_ID;
    if (!socketPath || !workspaceId || !paneId) {
      this.#mutationUnavailableReason = "Herdr socket, workspace, or current pane identity is unavailable";
      return false;
    }
    try {
      this.#adapter = await HerdrAdapter.connect({ socketPath, workspaceId });
      const snapshot = await this.#adapter.currentWorkspaceSnapshot();
      const originPane = snapshot.panes.find((pane) => pane.paneId === paneId);
      if (!originPane) throw new Error("current Pi pane is absent from the captured Herdr workspace");
      this.registryRuntime.setActorTerminalId(originPane.terminalId);
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
              await this.deliverPendingContext(ctx, dispatchId);
            },
          });
        }
        this.#followup = new DispatchFollowupService({ registry, herdr: this.#adapter, config });
        this.#application = new DispatchApplication({
          config,
          registry,
          herdr: this.#adapter,
          workspaceId,
          originTerminalId: originPane.terminalId,
          ...(this.#monitor === undefined
            ? {}
            : {
                prepareMonitoring: (targets) => this.#monitor!.watchTargets(targets),
                onIntentRecorded: () => this.#monitor!.refresh(),
              }),
        });
        await this.#monitor?.start();
        await this.deliverPendingContext(ctx);
      }
      return this.#application !== undefined;
    } catch (error) {
      this.#adapter?.close();
      this.#adapter = undefined;
      this.#application = undefined;
      this.#mutationUnavailableReason = `Herdr Adapter unavailable: ${errorMessage(error)}`;
      return false;
    }
  }

  async deliverPendingContext(ctx: ExtensionContext, onlyDispatchId?: string): Promise<void> {
    if (ctx.mode !== "tui" || !this.#contextDelivery || !this.#sendContextMessage) return;
    const registry = this.registryRuntime.registry;
    if (!registry) return;
    const context = this.#contextPort(ctx);
    const pending = onlyDispatchId
      ? [registry.getDispatch(onlyDispatchId)].filter((item) => item !== undefined)
      : registry.listPendingContextDelivery(ctx.sessionManager.getSessionId());
    for (const dispatch of pending) {
      if (dispatch.originSessionId !== ctx.sessionManager.getSessionId()) continue;
      this.#contextDelivery.deliver(dispatch.id, context);
    }
  }

  stop(): void {
    this.#monitor?.stop();
    this.#monitor = undefined;
    this.#contextDelivery = undefined;
    this.#followup = undefined;
    this.#adapter?.close();
    this.#adapter = undefined;
    this.#application = undefined;
    this.registryRuntime.stop();
    if (!this.#mutationUnavailableReason) {
      this.#mutationUnavailableReason = "Dispatch runtime session is stopped";
    }
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
