import { homedir } from "node:os";
import { join } from "node:path";

import { type DispatchRegistry, openDispatchRegistry } from "../registry/registry.js";
import type { LeaseGuardContext } from "../safety/policy.js";
import { UI_COPY } from "./ui-copy.js";

export function defaultRegistryPath(home = homedir()): string {
  return join(home, ".local", "state", "pi-herdr-dispatch", "registry.sqlite");
}

export class RegistryRuntime {
  readonly path: string;
  #registry?: DispatchRegistry;
  #unavailableReason = UI_COPY.runtime.registrySessionNotStarted();
  #actorTerminalId?: string;

  constructor(path = defaultRegistryPath()) {
    this.path = path;
  }

  get registry(): DispatchRegistry | undefined {
    return this.#registry;
  }

  get unavailableReason(): string | undefined {
    return this.#registry ? undefined : this.#unavailableReason;
  }

  async start(): Promise<boolean> {
    this.stop();
    try {
      this.#registry = await openDispatchRegistry(this.path);
      this.#unavailableReason = "";
      return true;
    } catch (error) {
      this.#unavailableReason =
        error instanceof Error ? error.message : UI_COPY.runtime.registryUnavailable();
      return false;
    }
  }

  stop(): void {
    this.#registry?.close();
    this.#registry = undefined;
    if (!this.#unavailableReason) {
      this.#unavailableReason = UI_COPY.runtime.registrySessionStopped();
    }
  }

  setActorTerminalId(terminalId: string | undefined): void {
    this.#actorTerminalId = terminalId;
  }

  leaseContext(): LeaseGuardContext {
    if (!this.#registry) {
      return {
        actorTerminalId: this.#actorTerminalId,
        leaseSnapshot: { status: "unavailable", reason: this.#unavailableReason },
      };
    }

    try {
      return {
        actorTerminalId: this.#actorTerminalId,
        leaseSnapshot: {
          status: "ready",
          leases: this.#registry.listWriteLeases().map((lease) => ({
            dispatchId: lease.dispatchId,
            targetTerminalId: lease.targetTerminalId,
            worktreePath: lease.worktreePath,
          })),
        },
      };
    } catch (error) {
      return {
        actorTerminalId: this.#actorTerminalId,
        leaseSnapshot: {
          status: "unavailable",
          reason: error instanceof Error ? error.message : UI_COPY.runtime.registryUnavailable(),
        },
      };
    }
  }
}
