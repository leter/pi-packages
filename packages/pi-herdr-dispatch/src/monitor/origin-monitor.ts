import { relative, resolve } from "node:path";

import type { DispatchConfig } from "../domain/config.js";
import { scanResultTail } from "../domain/result-envelope.js";
import { hasDeliveryEcho } from "../herdr/delivery.js";
import type { ResolvedHerdrTarget } from "../herdr/adapter.js";
import type { HerdrPaneRead } from "../herdr/protocol.js";
import type {
  HerdrMonitorEvent,
  HerdrMonitorTarget,
  HerdrSubscriptionState,
} from "../herdr/subscription.js";
import {
  type DispatchRegistry,
  RegistryStateError,
} from "../registry/registry.js";
import type { AttentionCondition, StoredDispatch } from "../registry/types.js";
import type { MonitorClock, ScheduledTask } from "./clock.js";
import { systemMonitorClock } from "./clock.js";

export interface OriginMonitorHerdrPort {
  resolveTerminal(terminalId: string): Promise<ResolvedHerdrTarget | undefined>;
  readTail(paneId: string, lines: 50 | 200): Promise<HerdrPaneRead>;
  monitorTargets(
    targets: readonly HerdrMonitorTarget[],
    listener: (event: HerdrMonitorEvent) => void,
    stateListener?: (state: HerdrSubscriptionState) => void,
  ): Promise<void>;
}

export interface OriginMonitorOptions {
  registry: DispatchRegistry;
  herdr: OriginMonitorHerdrPort;
  config: DispatchConfig;
  originSessionId: string;
  clock?: MonitorClock;
  onSettled?: (dispatchId: string) => void | Promise<void>;
  onAttention?: (
    dispatchId: string,
    condition: AttentionCondition,
    details: unknown,
  ) => void | Promise<void>;
  resumedAfterOriginGap?: boolean;
}

export class OriginMonitor {
  readonly #registry: DispatchRegistry;
  readonly #herdr: OriginMonitorHerdrPort;
  readonly #config: DispatchConfig;
  readonly #originSessionId: string;
  readonly #clock: MonitorClock;
  readonly #onSettled: (dispatchId: string) => void | Promise<void>;
  readonly #onAttention: (
    dispatchId: string,
    condition: AttentionCondition,
    details: unknown,
  ) => void | Promise<void>;
  readonly #resumedAfterOriginGap: boolean;
  readonly #timers = new Set<ScheduledTask>();
  readonly #cwdMismatches = new Map<string, number>();
  readonly #acknowledged = new Set<string>();
  #targets: HerdrMonitorTarget[] = [];
  #running = false;
  #initializing = false;

  constructor(options: OriginMonitorOptions) {
    this.#registry = options.registry;
    this.#herdr = options.herdr;
    this.#config = options.config;
    this.#originSessionId = required(options.originSessionId, "originSessionId");
    this.#clock = options.clock ?? systemMonitorClock;
    this.#onSettled = options.onSettled ?? (() => undefined);
    this.#onAttention = options.onAttention ?? (() => undefined);
    this.#resumedAfterOriginGap = options.resumedAfterOriginGap ?? false;
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#initializing = true;
    if (this.#resumedAfterOriginGap) {
      for (const dispatch of this.#dispatches()) {
        this.#registry.recordAudit(
          dispatch.id,
          "origin-monitor-resumed",
          { derivedOriginClosedGap: true },
          this.#clock.now(),
        );
      }
    }
    await this.refresh();
    this.#initializing = false;
    await this.#catchUpAll();
    this.#scheduleCwdPoll();
  }

  async refresh(): Promise<void> {
    if (!this.#running) return;
    const dispatches = this.#dispatches();
    await this.watchTargets(
      dispatches.map((dispatch) => ({
        paneId: dispatch.targetPaneId,
        correlationId: dispatch.id,
      })),
    );
    for (const dispatch of dispatches) this.#scheduleDispatchTimers(dispatch);
  }

  async watchTargets(targets: readonly HerdrMonitorTarget[]): Promise<void> {
    if (!this.#running) return;
    this.#targets = dedupeTargets(targets);
    if (this.#targets.length === 0) return;
    await this.#herdr.monitorTargets(
      this.#targets,
      (event) => this.#handleEvent(event),
      (state) => this.#handleConnectionState(state),
    );
  }

  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    for (const timer of this.#timers) this.#clock.clearTimeout(timer);
    this.#timers.clear();
    this.#cwdMismatches.clear();
    this.#acknowledged.clear();
    this.#targets = [];
  }

  async #catchUpAll(): Promise<void> {
    for (const dispatch of this.#dispatches()) await this.#catchUp(dispatch);
  }

  async #catchUp(dispatch: StoredDispatch): Promise<void> {
    const resolved = await this.#resolve(dispatch);
    if (!resolved) {
      await this.#attention(dispatch.id, "target-lost", { terminalId: dispatch.targetTerminalId });
      return;
    }
    const read = await this.#herdr.readTail(resolved.pane.paneId, 200);
    this.#registry.recordAudit(dispatch.id, "monitor-catch-up", { lines: 200 }, this.#clock.now());
    const settled = await this.#processRead(dispatch, read);
    if (settled) return;
    const current = this.#registry.getDispatch(dispatch.id);
    if (!current || current.lifecycle === "settled") return;
    if (current.lifecycle === "delivering") {
      if (hasDeliveryEcho(read.text, current.id)) {
        this.#markActiveBenign(current.id);
      } else {
        await this.#attention(current.id, "delivery-unverified", { reason: "catch-up-no-echo" });
      }
    } else if (resolved.pane.agentStatus === "working") {
      this.#acknowledged.add(current.id);
    } else if (resolved.pane.agentStatus === "idle" || resolved.pane.agentStatus === "done") {
      await this.#attention(current.id, "result-missing", { status: resolved.pane.agentStatus });
    }
  }

  async #handleEvent(event: HerdrMonitorEvent): Promise<void> {
    if (!this.#running) return;
    if (event.type === "output-matched") {
      const dispatch = this.#dispatches().find((item) => item.targetPaneId === event.paneId);
      if (dispatch) await this.#processRead(dispatch, event.read);
      return;
    }
    if (event.type === "pane-closed") {
      const dispatch = this.#dispatches().find((item) => item.targetPaneId === event.paneId);
      if (dispatch) await this.#handlePossibleRouteChange(dispatch);
      return;
    }
    if (event.type === "pane-moved") {
      const dispatch = this.#dispatches().find(
        (item) => item.targetPaneId === event.previousPaneId || item.targetTerminalId === event.pane.terminalId,
      );
      if (dispatch) await this.#handlePossibleRouteChange(dispatch);
      return;
    }
    const dispatch = this.#dispatches().find((item) => item.targetPaneId === event.paneId);
    if (!dispatch) return;
    if (event.status === "working") {
      this.#acknowledged.add(dispatch.id);
      this.#clearAttentionBenign(dispatch.id, "unacknowledged");
      return;
    }
    if (event.status === "blocked") {
      const tail = await this.#herdr.readTail(dispatch.targetPaneId, 50);
      await this.#attention(dispatch.id, "blocked-runtime", { tail: tail.text, lines: 50 });
      return;
    }
    if (event.status === "idle" || event.status === "done") {
      const tail = await this.#herdr.readTail(dispatch.targetPaneId, 200);
      if (!(await this.#processRead(dispatch, tail))) {
        await this.#attention(dispatch.id, "result-missing", { status: event.status });
      }
    }
  }

  async #handlePossibleRouteChange(dispatch: StoredDispatch): Promise<void> {
    const resolved = await this.#resolve(dispatch);
    if (!resolved) {
      await this.#attention(dispatch.id, "target-lost", { terminalId: dispatch.targetTerminalId });
    }
  }

  async #handleConnectionState(state: HerdrSubscriptionState): Promise<void> {
    if (!this.#running) return;
    if (state.status === "disconnected") {
      for (const dispatch of this.#dispatches()) {
        await this.#attention(dispatch.id, "monitoring-paused", { reason: state.error.message });
      }
      return;
    }
    for (const dispatch of this.#dispatches()) {
      this.#clearAttentionBenign(dispatch.id, "monitoring-paused");
    }
    if (!this.#initializing) await this.#catchUpAll();
  }

  async #processRead(dispatch: StoredDispatch, read: HerdrPaneRead): Promise<boolean> {
    const current = this.#registry.getDispatch(dispatch.id);
    if (!current || current.lifecycle === "settled" || this.#isSettlementPaused(current.id)) return false;
    const scan = scanResultTail(read.text, current.id);
    for (const malformed of scan.malformed) {
      await this.#attention(current.id, "malformed-result", {
        raw: malformed.raw,
        reason: malformed.reason,
      });
    }
    if (!scan.valid) return false;
    const settlement = this.#registry.settle({
      dispatchId: current.id,
      outcome: scan.valid.result.outcome,
      sourceTerminalId: current.targetTerminalId,
      rawEnvelope: scan.valid.raw,
      sanitizedResult: scan.valid.result,
      kind: "result",
      settledAt: this.#clock.now(),
    });
    if (settlement.status === "settled") await this.#onSettled(current.id);
    return true;
  }

  async #resolve(dispatch: StoredDispatch): Promise<ResolvedHerdrTarget | undefined> {
    const resolved = await this.#herdr.resolveTerminal(dispatch.targetTerminalId);
    if (!resolved) return undefined;
    if (
      resolved.pane.terminalId !== dispatch.targetTerminalId ||
      resolved.pane.workspaceId !== dispatch.targetWorkspaceId
    ) {
      return undefined;
    }
    try {
      this.#registry.updateTargetRoute(dispatch.id, resolved.pane.paneId, this.#clock.now());
    } catch (error) {
      if (!(error instanceof RegistryStateError)) throw error;
      if (this.#registry.getDispatch(dispatch.id)?.lifecycle !== "settled") throw error;
    }
    return resolved;
  }

  #scheduleDispatchTimers(dispatch: StoredDispatch): void {
    if (dispatch.deadlineAt > this.#clock.now()) {
      this.#schedule(dispatch.deadlineAt - this.#clock.now(), async () => {
        const current = this.#registry.getDispatch(dispatch.id);
        if (current && current.lifecycle !== "settled") {
          await this.#attention(current.id, "overdue", { deadlineAt: current.deadlineAt });
        }
      });
    } else {
      void this.#attention(dispatch.id, "overdue", { deadlineAt: dispatch.deadlineAt });
    }
    if (dispatch.lifecycle === "active" && dispatch.activeAt !== undefined) {
      const due = dispatch.activeAt + this.#config.startupWindowMs;
      this.#schedule(Math.max(0, due - this.#clock.now()), async () => {
        const current = this.#registry.getDispatch(dispatch.id);
        if (!current || current.lifecycle !== "active" || this.#acknowledged.has(current.id)) return;
        const resolved = await this.#resolve(current);
        if (resolved?.pane.agentStatus === "working") {
          this.#acknowledged.add(current.id);
          return;
        }
        await this.#attention(current.id, "unacknowledged", {
          startupWindowMs: this.#config.startupWindowMs,
        });
      });
    }
  }

  #scheduleCwdPoll(): void {
    if (!this.#running) return;
    this.#schedule(this.#config.cwdPollMs, async () => {
      for (const dispatch of this.#dispatches()) await this.#pollCwd(dispatch);
      this.#scheduleCwdPoll();
    });
  }

  async #pollCwd(dispatch: StoredDispatch): Promise<void> {
    const resolved = await this.#resolve(dispatch);
    if (!resolved) {
      await this.#attention(dispatch.id, "target-lost", { terminalId: dispatch.targetTerminalId });
      return;
    }
    const expectedRoot = dispatch.worktreePath ?? dispatch.targetCwd;
    if (resolved.pane.cwd && isWithin(expectedRoot, resolved.pane.cwd)) {
      this.#cwdMismatches.delete(dispatch.id);
      return;
    }
    const samples = (this.#cwdMismatches.get(dispatch.id) ?? 0) + 1;
    this.#cwdMismatches.set(dispatch.id, samples);
    if (samples >= this.#config.cwdDriftSamples) {
      await this.#attention(dispatch.id, "target-moved", {
        expectedRoot,
        observedCwd: resolved.pane.cwd,
        samples,
      });
    }
  }

  #schedule(delayMs: number, callback: () => void | Promise<void>): void {
    let task: ScheduledTask;
    task = this.#clock.setTimeout(async () => {
      this.#timers.delete(task);
      if (this.#running) await callback();
    }, Math.max(0, Math.round(delayMs)));
    this.#timers.add(task);
  }

  async #attention(
    dispatchId: string,
    condition: AttentionCondition,
    details: unknown,
  ): Promise<void> {
    try {
      const result = this.#registry.addAttention(dispatchId, condition, details, this.#clock.now());
      if (result === "added") await this.#onAttention(dispatchId, condition, details);
    } catch (error) {
      if (!(error instanceof RegistryStateError)) throw error;
      if (this.#registry.getDispatch(dispatchId)?.lifecycle !== "settled") throw error;
    }
  }

  #clearAttentionBenign(dispatchId: string, condition: AttentionCondition): void {
    try {
      this.#registry.clearAttention(dispatchId, condition, this.#clock.now());
    } catch (error) {
      if (!(error instanceof RegistryStateError)) throw error;
      if (this.#registry.getDispatch(dispatchId)?.lifecycle !== "settled") throw error;
    }
  }

  #markActiveBenign(dispatchId: string): void {
    try {
      this.#registry.markActive(dispatchId, this.#clock.now());
    } catch (error) {
      if (!(error instanceof RegistryStateError)) throw error;
      if (this.#registry.getDispatch(dispatchId)?.lifecycle !== "settled") throw error;
    }
  }

  #isSettlementPaused(dispatchId: string): boolean {
    const conditions = new Set(this.#registry.listAttention(dispatchId).map((item) => item.condition));
    return conditions.has("target-lost") || conditions.has("target-moved");
  }

  #dispatches(): StoredDispatch[] {
    return [...this.#registry.listUnsettled(this.#originSessionId)];
  }
}

function dedupeTargets(targets: readonly HerdrMonitorTarget[]): HerdrMonitorTarget[] {
  const unique = new Map<string, HerdrMonitorTarget>();
  for (const target of targets) unique.set(`${target.paneId}\u0000${target.correlationId}`, { ...target });
  return [...unique.values()];
}

function isWithin(root: string, candidate: string): boolean {
  const difference = relative(resolve(root), resolve(candidate));
  return difference === "" || (!difference.startsWith("..") && !difference.startsWith("/"));
}

function required(value: string, label: string): string {
  if (!value) throw new TypeError(`${label} must not be empty`);
  return value;
}
