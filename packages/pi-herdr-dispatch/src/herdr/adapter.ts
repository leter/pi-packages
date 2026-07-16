import {
  type HerdrDeliveryRequest,
  type HerdrDeliveryResult,
  type HerdrEchoVerificationOptions,
  type ExpectedHerdrTarget,
  hasDeliveryEcho,
} from "./delivery.js";
import {
  type HerdrAgent,
  type HerdrPane,
  type HerdrPaneRead,
  type HerdrSnapshot,
  type HerdrWorkspace,
  parsePaneInfoResult,
  parsePaneReadResult,
  parseSnapshotResult,
} from "./protocol.js";
import {
  HerdrApiError,
  HerdrDisconnectedError,
  HerdrProtocolError,
  HerdrUnaryTransport,
} from "./socket-client.js";
import {
  type HerdrMonitorEvent,
  type HerdrMonitorTarget,
  type HerdrSubscriptionState,
  HerdrSubscriptionStream,
} from "./subscription.js";

export interface HerdrAdapterOptions {
  socketPath: string;
  workspaceId: string;
  requestTimeoutMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

export interface CurrentWorkspaceSnapshot {
  workspace: HerdrWorkspace;
  panes: HerdrPane[];
  agents: HerdrAgent[];
  serverVersion: string;
  protocol: number;
}

export interface ResolvedHerdrTarget {
  pane: HerdrPane;
  agent?: HerdrAgent;
}

export interface HerdrNotification {
  title: string;
  body?: string;
  sound?: "none" | "done" | "request";
}

export interface HerdrNotificationResult {
  shown: boolean;
  reason: "shown" | "disabled" | "rate_limited" | "no_foreground_client" | "busy";
}

export class HerdrWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HerdrWorkspaceError";
  }
}

export class HerdrTargetLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HerdrTargetLostError";
  }
}

class HerdrRouteInvalidatedError extends Error {}

export class HerdrAdapter {
  readonly #options: HerdrAdapterOptions;
  readonly #unary: HerdrUnaryTransport;
  #subscription?: HerdrSubscriptionStream;
  readonly #invalidatedPaneIds = new Set<string>();
  #reconnectPromise?: Promise<void>;
  #closed = false;

  private constructor(options: HerdrAdapterOptions, unary: HerdrUnaryTransport) {
    this.#options = options;
    this.#unary = unary;
  }

  static async connect(options: HerdrAdapterOptions): Promise<HerdrAdapter> {
    validateOptions(options);
    const unary = new HerdrUnaryTransport(options.socketPath, {
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    });
    const adapter = new HerdrAdapter(options, unary);
    adapter.#currentWorkspace(await adapter.#snapshot());
    return adapter;
  }

  async reconnect(): Promise<void> {
    if (this.#closed) throw new HerdrDisconnectedError("Herdr adapter is closed", false);
    if (this.#reconnectPromise) return this.#reconnectPromise;
    const reconnect = this.#performReconnect();
    this.#reconnectPromise = reconnect;
    try {
      await reconnect;
    } finally {
      if (this.#reconnectPromise === reconnect) this.#reconnectPromise = undefined;
    }
  }

  async currentWorkspaceSnapshot(): Promise<CurrentWorkspaceSnapshot> {
    return this.#currentWorkspace(await this.#snapshot());
  }

  async resolveTerminal(terminalId: string): Promise<ResolvedHerdrTarget | undefined> {
    if (!terminalId) throw new TypeError("terminalId must not be empty");
    return this.#resolveTerminal(terminalId);
  }

  async readTail(paneId: string, lines: 50 | 200): Promise<HerdrPaneRead> {
    validateTailLines(lines);
    return this.#readTail(paneId, lines);
  }

  async showNotification(notification: HerdrNotification): Promise<HerdrNotificationResult> {
    if (!notification.title) throw new TypeError("notification title must not be empty");
    const result = await this.#unary.request(
      "notification.show",
      {
        title: notification.title,
        ...(notification.body === undefined ? {} : { body: notification.body }),
        ...(notification.sound === undefined ? {} : { sound: notification.sound }),
      },
      "notification_show",
    );
    if (typeof result.shown !== "boolean" || !isNotificationReason(result.reason)) {
      throw new HerdrProtocolError("invalid notification.show result");
    }
    return { shown: result.shown, reason: result.reason };
  }

  async monitorTargets(
    targets: readonly HerdrMonitorTarget[],
    listener: (event: HerdrMonitorEvent) => void,
    stateListener?: (state: HerdrSubscriptionState) => void,
  ): Promise<void> {
    if (this.#closed) throw new HerdrDisconnectedError("Herdr adapter is closed", false);
    this.#subscription ??= new HerdrSubscriptionStream(
      this.#options.socketPath,
      this.#options.workspaceId,
      {
        ...(this.#options.requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: this.#options.requestTimeoutMs }),
        ...(this.#options.reconnectMinMs === undefined
          ? {}
          : { reconnectMinMs: this.#options.reconnectMinMs }),
        ...(this.#options.reconnectMaxMs === undefined
          ? {}
          : { reconnectMaxMs: this.#options.reconnectMaxMs }),
      },
    );
    this.#invalidatedPaneIds.clear();
    await this.#subscription.start(
      targets,
      (event) => {
        if (event.type === "pane-closed") this.#invalidatedPaneIds.add(event.paneId);
        if (event.type === "pane-moved" && event.previousPaneId !== event.pane.paneId) {
          this.#invalidatedPaneIds.add(event.previousPaneId);
        }
        listener(event);
      },
      stateListener,
    );
  }

  async deliverAndVerify(
    request: HerdrDeliveryRequest,
    echoOptions: HerdrEchoVerificationOptions = { echoWindowMs: 0 },
  ): Promise<HerdrDeliveryResult> {
    validateDeliveryRequest(request);
    validateEchoOptions(echoOptions);
    let resolved: ResolvedHerdrTarget | undefined;
    try {
      resolved = await this.#resolveTerminal(request.target.terminalId);
    } catch (error) {
      if (error instanceof HerdrTargetLostError) {
        return { status: "not-sent", reason: "target-lost", detail: error.message };
      }
      throw error;
    }
    if (!resolved) return { status: "not-sent", reason: "target-lost" };
    const targetCheck = validateResolvedTarget(resolved, request.target);
    if (targetCheck) return targetCheck;
    const stagedPane = resolved.pane;

    try {
      await this.#unary.request(
        "pane.send_input",
        { pane_id: stagedPane.paneId, text: request.text },
        "ok",
        () => {
          if (this.#invalidatedPaneIds.has(stagedPane.paneId)) {
            throw new HerdrRouteInvalidatedError("target pane closed or moved before text staging");
          }
        },
      );
    } catch (error) {
      if (error instanceof HerdrRouteInvalidatedError) {
        return { status: "not-sent", reason: "target-changed", detail: error.message };
      }
      if (error instanceof HerdrApiError) {
        return { status: "not-sent", reason: "api-rejected", detail: error.message };
      }
      if (error instanceof HerdrDisconnectedError && !error.submitted) {
        return { status: "not-sent", reason: "transport-unavailable", detail: error.message };
      }
      return {
        status: "ambiguous",
        reason: "response-unknown",
        pane: stagedPane,
        detail: errorMessage(error),
      };
    }

    // Agent TUIs can process a multiline paste asynchronously. Sending Enter in
    // the same request can leave the text staged in the editor without submitting
    // it. Let the TUI consume the paste, re-resolve the immutable terminal route,
    // then submit Enter in a second request. Any failure after staging is
    // ambiguous because the text may still be present in the target editor.
    await new Promise((resolve) => setTimeout(resolve, 50));
    let submitTarget: ResolvedHerdrTarget | undefined;
    try {
      submitTarget = await this.#resolveTerminal(request.target.terminalId);
    } catch (error) {
      return {
        status: "ambiguous",
        reason: "response-unknown",
        pane: stagedPane,
        detail: `text staged but target revalidation failed before Enter: ${errorMessage(error)}`,
      };
    }
    if (
      !submitTarget ||
      submitTarget.pane.paneId !== stagedPane.paneId ||
      validateResolvedTarget(submitTarget, request.target)
    ) {
      return {
        status: "ambiguous",
        reason: "response-unknown",
        pane: stagedPane,
        detail: "text staged but target changed before Enter",
      };
    }
    try {
      await this.#unary.request(
        "pane.send_input",
        { pane_id: submitTarget.pane.paneId, keys: ["Enter"] },
        "ok",
        () => {
          if (this.#invalidatedPaneIds.has(submitTarget!.pane.paneId)) {
            throw new HerdrRouteInvalidatedError("target pane closed or moved before Enter");
          }
        },
      );
    } catch (error) {
      return {
        status: "ambiguous",
        reason: "response-unknown",
        pane: stagedPane,
        detail: `text staged but Enter submission is unverified: ${errorMessage(error)}`,
      };
    }

    resolved = submitTarget;
    const echoDeadline = Date.now() + echoOptions.echoWindowMs;
    const echoPollMs = echoOptions.echoPollMs ?? 100;
    let lastEchoTarget = resolved;
    while (true) {
      let echoTarget: ResolvedHerdrTarget | undefined;
      let echo: HerdrPaneRead;
      try {
        echoTarget = await this.#resolveTerminal(request.target.terminalId);
        if (!echoTarget) throw new HerdrTargetLostError("target disappeared before echo verification");
        lastEchoTarget = echoTarget;
        echo = await this.#readTail(echoTarget.pane.paneId, 200);
      } catch (error) {
        return {
          status: "ambiguous",
          reason: "echo-read-failed",
          pane: resolved.pane,
          detail: errorMessage(error),
        };
      }
      if (hasDeliveryEcho(echo.text, request.correlationId)) {
        return { status: "verified", pane: echoTarget.pane, echo };
      }
      const remainingMs = echoDeadline - Date.now();
      if (remainingMs <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(echoPollMs, remainingMs)));
    }
    return { status: "ambiguous", reason: "echo-not-found", pane: lastEchoTarget.pane };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#subscription?.close();
    this.#unary.close();
  }

  async #performReconnect(): Promise<void> {
    this.#currentWorkspace(await this.#snapshot());
    if (this.#closed) throw new HerdrDisconnectedError("Herdr adapter closed during reconnect", false);
    await this.#subscription?.reconnect();
  }

  async #snapshot(): Promise<HerdrSnapshot> {
    const result = await this.#unary.request("session.snapshot", {}, "session_snapshot");
    return parseSnapshotResult(result);
  }

  async #resolveTerminal(terminalId: string): Promise<ResolvedHerdrTarget | undefined> {
    const current = this.#currentWorkspace(await this.#snapshot());
    const matchingPanes = current.panes.filter((pane) => pane.terminalId === terminalId);
    if (matchingPanes.length === 0) return undefined;
    if (matchingPanes.length !== 1) {
      throw new HerdrTargetLostError(`terminal ${terminalId} does not identify exactly one current pane`);
    }
    const route = matchingPanes[0]!;
    let pane: HerdrPane;
    try {
      const result = await this.#unary.request("pane.get", { pane_id: route.paneId }, "pane_info");
      pane = parsePaneInfoResult(result);
    } catch (error) {
      if (error instanceof HerdrApiError && error.code === "not_found") return undefined;
      throw error;
    }
    if (
      pane.terminalId !== terminalId ||
      pane.paneId !== route.paneId ||
      pane.workspaceId !== this.#options.workspaceId
    ) {
      return undefined;
    }
    const matchingAgents = current.agents.filter((agent) => agent.terminalId === terminalId);
    if (matchingAgents.length > 1) {
      throw new HerdrProtocolError(`snapshot contains duplicate agents for terminal ${terminalId}`);
    }
    return { pane, ...(matchingAgents[0] === undefined ? {} : { agent: matchingAgents[0] }) };
  }

  async #readTail(paneId: string, lines: 50 | 200): Promise<HerdrPaneRead> {
    const result = await this.#unary.request(
      "pane.read",
      {
        pane_id: paneId,
        source: "recent_unwrapped",
        lines,
        format: "text",
        strip_ansi: true,
      },
      "pane_read",
    );
    const read = parsePaneReadResult(result);
    if (
      read.paneId !== paneId ||
      read.workspaceId !== this.#options.workspaceId ||
      read.source !== "recent_unwrapped" ||
      read.format !== "text"
    ) {
      throw new HerdrProtocolError("pane.read response does not match the bounded current-workspace request");
    }
    return read;
  }

  #currentWorkspace(snapshot: HerdrSnapshot): CurrentWorkspaceSnapshot {
    const workspaces = snapshot.workspaces.filter(
      (workspace) => workspace.workspaceId === this.#options.workspaceId,
    );
    if (workspaces.length !== 1) {
      throw new HerdrWorkspaceError(
        `captured workspace ${this.#options.workspaceId} is not uniquely present in Herdr`,
      );
    }
    return {
      workspace: workspaces[0]!,
      panes: snapshot.panes.filter((pane) => pane.workspaceId === this.#options.workspaceId),
      agents: snapshot.agents.filter((agent) => agent.workspaceId === this.#options.workspaceId),
      serverVersion: snapshot.version,
      protocol: snapshot.protocol,
    };
  }
}

function validateOptions(options: HerdrAdapterOptions): void {
  if (!options.socketPath) throw new TypeError("socketPath must not be empty");
  if (!options.workspaceId) throw new TypeError("workspaceId must not be empty");
}

function validateTailLines(lines: number): asserts lines is 50 | 200 {
  if (lines !== 50 && lines !== 200) throw new RangeError("Herdr tail reads must request exactly 50 or 200 lines");
}

function validateDeliveryRequest(request: HerdrDeliveryRequest): void {
  if (!request.target.terminalId) throw new TypeError("delivery terminalId must not be empty");
  if (!request.correlationId) throw new TypeError("delivery correlationId must not be empty");
  if (!request.text) throw new TypeError("delivery text must not be empty");
}

function validateEchoOptions(options: HerdrEchoVerificationOptions): void {
  if (!Number.isSafeInteger(options.echoWindowMs) || options.echoWindowMs < 0 || options.echoWindowMs > 300_000) {
    throw new RangeError("echoWindowMs must be an integer from 0 to 300000");
  }
  if (
    options.echoPollMs !== undefined &&
    (!Number.isSafeInteger(options.echoPollMs) || options.echoPollMs < 1 || options.echoPollMs > 5_000)
  ) {
    throw new RangeError("echoPollMs must be an integer from 1 to 5000");
  }
}

function validateResolvedTarget(
  resolved: ResolvedHerdrTarget,
  expected: ExpectedHerdrTarget,
): Extract<HerdrDeliveryResult, { status: "not-sent" }> | undefined {
  const actualAgent = resolved.agent?.agent ?? resolved.pane.agent;
  if (
    (expected.expectedAgent !== undefined && actualAgent !== expected.expectedAgent) ||
    (expected.expectedCwd !== undefined && resolved.pane.cwd !== expected.expectedCwd)
  ) {
    return { status: "not-sent", reason: "target-changed" };
  }
  const allowed = expected.allowedStatuses ?? ["idle", "done"];
  if (!allowed.includes(resolved.pane.agentStatus)) {
    return { status: "not-sent", reason: "target-not-idle" };
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotificationReason(
  value: unknown,
): value is HerdrNotificationResult["reason"] {
  return (
    value === "shown" ||
    value === "disabled" ||
    value === "rate_limited" ||
    value === "no_foreground_client" ||
    value === "busy"
  );
}
