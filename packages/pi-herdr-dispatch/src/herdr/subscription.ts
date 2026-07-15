import {
  type HerdrAgentStatus,
  type HerdrPane,
  type HerdrPaneRead,
  parsePane,
  parsePaneRead,
} from "./protocol.js";
import {
  type HerdrEventEnvelope,
  HerdrDisconnectedError,
  HerdrProtocolError,
  HerdrSocketClient,
} from "./socket-client.js";

export interface HerdrMonitorTarget {
  paneId: string;
  correlationId: string;
}

export type HerdrMonitorEvent =
  | { type: "pane-closed"; paneId: string; workspaceId: string }
  | { type: "pane-moved"; previousPaneId: string; previousWorkspaceId: string; pane: HerdrPane }
  | { type: "agent-status-changed"; paneId: string; workspaceId: string; status: HerdrAgentStatus }
  | { type: "output-matched"; paneId: string; matchedLine: string; read: HerdrPaneRead };

export interface HerdrSubscriptionOptions {
  requestTimeoutMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

export class HerdrSubscriptionStream {
  readonly #socketPath: string;
  readonly #workspaceId: string;
  readonly #requestTimeoutMs?: number;
  readonly #reconnectMinMs: number;
  readonly #reconnectMaxMs: number;
  #targets: HerdrMonitorTarget[] = [];
  #listener?: (event: HerdrMonitorEvent) => void;
  #client?: HerdrSocketClient;
  #timer?: NodeJS.Timeout;
  #stabilityTimer?: NodeJS.Timeout;
  #generation = 0;
  #attempt = 0;
  #closed = false;
  #connectPromise?: Promise<void>;

  constructor(socketPath: string, workspaceId: string, options: HerdrSubscriptionOptions = {}) {
    this.#socketPath = socketPath;
    this.#workspaceId = workspaceId;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#reconnectMinMs = normalizeBackoff(options.reconnectMinMs ?? 100, "reconnectMinMs");
    this.#reconnectMaxMs = normalizeBackoff(options.reconnectMaxMs ?? 5_000, "reconnectMaxMs");
    if (this.#reconnectMinMs > this.#reconnectMaxMs) {
      throw new RangeError("reconnectMinMs must not exceed reconnectMaxMs");
    }
  }

  async start(
    targets: readonly HerdrMonitorTarget[],
    listener: (event: HerdrMonitorEvent) => void,
  ): Promise<void> {
    if (this.#closed) throw new HerdrDisconnectedError("subscription stream is closed", false);
    this.#targets = normalizeTargets(targets);
    this.#listener = listener;
    await this.#restart();
  }

  async reconnect(): Promise<void> {
    if (this.#closed) throw new HerdrDisconnectedError("subscription stream is closed", false);
    if (this.#targets.length === 0 || !this.#listener) return;
    if (this.#connectPromise) return this.#connectPromise;
    return this.#restart();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#generation += 1;
    this.#clearTimer();
    this.#clearStabilityTimer();
    this.#client?.close();
    this.#client = undefined;
  }

  async #restart(): Promise<void> {
    this.#generation += 1;
    const generation = this.#generation;
    this.#clearTimer();
    this.#clearStabilityTimer();
    this.#client?.close();
    this.#client = undefined;
    this.#attempt = 0;
    const connecting = this.#connect(generation);
    this.#connectPromise = connecting;
    try {
      await connecting;
    } finally {
      if (this.#connectPromise === connecting) this.#connectPromise = undefined;
    }
  }

  async #connect(generation: number): Promise<void> {
    let client: HerdrSocketClient;
    try {
      client = await HerdrSocketClient.connect(this.#socketPath, {
        ...(this.#requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.#requestTimeoutMs }),
      });
    } catch (error) {
      this.#scheduleReconnect(generation);
      throw error;
    }
    if (this.#closed || generation !== this.#generation) {
      client.close();
      return;
    }
    this.#client = client;
    client.onEvent((envelope) => {
      const event = parseMonitorEvent(envelope, this.#workspaceId);
      if (event) this.#listener?.(event);
    });
    client.onDisconnect(() => {
      if (this.#client === client) this.#client = undefined;
      this.#scheduleReconnect(generation);
    });
    try {
      await client.request(
        "events.subscribe",
        { subscriptions: buildSubscriptions(this.#targets) },
        "subscription_started",
      );
      this.#clearStabilityTimer();
      this.#stabilityTimer = setTimeout(() => {
        if (this.#client === client) this.#attempt = 0;
      }, this.#reconnectMaxMs);
    } catch (error) {
      if (this.#client === client) this.#client = undefined;
      client.close();
      this.#scheduleReconnect(generation);
      throw error;
    }
  }

  #scheduleReconnect(generation: number): void {
    this.#clearStabilityTimer();
    if (
      this.#closed ||
      generation !== this.#generation ||
      this.#timer !== undefined ||
      this.#targets.length === 0
    ) {
      return;
    }
    const delay = Math.min(this.#reconnectMaxMs, this.#reconnectMinMs * 2 ** this.#attempt);
    this.#attempt = Math.min(this.#attempt + 1, 31);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#closed || generation !== this.#generation) return;
      const connecting = this.#connect(generation);
      this.#connectPromise = connecting;
      void connecting
        .catch(() => undefined)
        .finally(() => {
          if (this.#connectPromise === connecting) this.#connectPromise = undefined;
        });
    }, delay);
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #clearStabilityTimer(): void {
    if (this.#stabilityTimer) clearTimeout(this.#stabilityTimer);
    this.#stabilityTimer = undefined;
  }
}

function buildSubscriptions(targets: readonly HerdrMonitorTarget[]): Record<string, unknown>[] {
  return [
    { type: "pane.closed" },
    { type: "pane.moved" },
    ...targets.flatMap((target) => [
      { type: "pane.agent_status_changed", pane_id: target.paneId },
      {
        type: "pane.output_matched",
        pane_id: target.paneId,
        source: "recent_unwrapped",
        lines: 200,
        strip_ansi: true,
        match: { type: "substring", value: target.correlationId },
      },
    ]),
  ];
}

function parseMonitorEvent(
  envelope: HerdrEventEnvelope,
  workspaceId: string,
): HerdrMonitorEvent | undefined {
  const data = envelope.data;
  if (envelope.event === "pane_closed") {
    exactType(data, "pane_closed");
    const eventWorkspace = string(data.workspace_id, "pane_closed.workspace_id");
    if (eventWorkspace !== workspaceId) return undefined;
    return {
      type: "pane-closed",
      paneId: string(data.pane_id, "pane_closed.pane_id"),
      workspaceId: eventWorkspace,
    };
  }
  if (envelope.event === "pane_moved") {
    exactType(data, "pane_moved");
    const pane = parsePane(record(data.pane, "pane_moved.pane"));
    const previousWorkspaceId = string(data.previous_workspace_id, "pane_moved.previous_workspace_id");
    if (previousWorkspaceId !== workspaceId && pane.workspaceId !== workspaceId) return undefined;
    return {
      type: "pane-moved",
      previousPaneId: string(data.previous_pane_id, "pane_moved.previous_pane_id"),
      previousWorkspaceId,
      pane,
    };
  }
  if (envelope.event === "pane_agent_status_changed" || envelope.event === "pane.agent_status_changed") {
    if (envelope.event === "pane_agent_status_changed") exactType(data, "pane_agent_status_changed");
    const eventWorkspace = string(data.workspace_id, "agent status workspace_id");
    if (eventWorkspace !== workspaceId) return undefined;
    return {
      type: "agent-status-changed",
      paneId: string(data.pane_id, "agent status pane_id"),
      workspaceId: eventWorkspace,
      status: agentStatus(data.agent_status),
    };
  }
  if (envelope.event === "pane.output_matched") {
    const read = parsePaneRead(record(data.read, "output matched read"));
    const paneId = string(data.pane_id, "output matched pane_id");
    if (read.workspaceId !== workspaceId) return undefined;
    if (read.paneId !== paneId) throw new HerdrProtocolError("output match pane does not match its read");
    return {
      type: "output-matched",
      paneId,
      matchedLine: string(data.matched_line, "output matched line"),
      read,
    };
  }
  throw new HerdrProtocolError(`unexpected subscribed Herdr event ${envelope.event}`);
}

function normalizeTargets(targets: readonly HerdrMonitorTarget[]): HerdrMonitorTarget[] {
  const unique = new Map<string, HerdrMonitorTarget>();
  for (const target of targets) {
    if (!target.paneId || !target.correlationId) {
      throw new TypeError("monitor targets require paneId and correlationId");
    }
    unique.set(`${target.paneId}\u0000${target.correlationId}`, { ...target });
  }
  return [...unique.values()];
}

function exactType(data: Record<string, unknown>, expected: string): void {
  if (data.type !== expected) {
    throw new HerdrProtocolError(`event data type must be ${expected}`);
  }
}

function agentStatus(value: unknown): HerdrAgentStatus {
  if (value === "idle" || value === "working" || value === "blocked" || value === "done" || value === "unknown") {
    return value;
  }
  throw new HerdrProtocolError("invalid agent status event");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HerdrProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new HerdrProtocolError(`${label} must be a string`);
  return value;
}

function normalizeBackoff(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new RangeError(`${label} must be an integer from 1 to 60000`);
  }
  return value;
}
