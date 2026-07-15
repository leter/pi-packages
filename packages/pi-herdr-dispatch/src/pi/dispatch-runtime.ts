import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { DispatchApplication } from "../dispatch/application.js";
import {
  DEFAULT_DISPATCH_CONFIG,
  defaultConfigPath,
  loadDispatchConfig,
} from "../domain/config.js";
import { HerdrAdapter } from "../herdr/adapter.js";
import { RegistryRuntime } from "./registry-runtime.js";

export interface DispatchRuntimeOptions {
  registry?: RegistryRuntime;
  configPath?: string;
  environment?: NodeJS.ProcessEnv;
}

export class DispatchRuntime {
  readonly registryRuntime: RegistryRuntime;
  readonly #configPath: string;
  readonly #environment: NodeJS.ProcessEnv;
  #adapter?: HerdrAdapter;
  #application?: DispatchApplication;
  #mutationUnavailableReason = "Dispatch runtime session has not started";

  constructor(options: DispatchRuntimeOptions = {}) {
    this.registryRuntime = options.registry ?? new RegistryRuntime();
    this.#configPath = options.configPath ?? defaultConfigPath();
    this.#environment = options.environment ?? process.env;
  }

  get application(): DispatchApplication | undefined {
    return this.#application;
  }

  get mutationUnavailableReason(): string | undefined {
    return this.#mutationUnavailableReason || undefined;
  }

  async start(_ctx: ExtensionContext): Promise<boolean> {
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
        this.#application = new DispatchApplication({
          config,
          registry: this.registryRuntime.registry,
          herdr: this.#adapter,
          workspaceId,
          originTerminalId: originPane.terminalId,
        });
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

  stop(): void {
    this.#adapter?.close();
    this.#adapter = undefined;
    this.#application = undefined;
    this.registryRuntime.stop();
    if (!this.#mutationUnavailableReason) {
      this.#mutationUnavailableReason = "Dispatch runtime session is stopped";
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
