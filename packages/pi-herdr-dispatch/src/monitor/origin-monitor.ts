import { relative, resolve } from "node:path";

import type { DispatchConfig } from "../domain/config.js";
import { scanResultTail } from "../domain/result-envelope.js";
import {
  captureWorktreeSnapshot,
  type WorktreeSnapshot,
} from "../domain/worktree-audit.js";
import { hasDeliveryEcho } from "../herdr/delivery.js";
import type { ResolvedHerdrTarget } from "../herdr/adapter.js";
import type { HerdrAgentStatus, HerdrPaneRead } from "../herdr/protocol.js";
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

const RESULT_RECHECK_DELAYS_MS = [100, 400, 1_000, 2_000, 4_000, 8_000, 15_000] as const;

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
  captureWorktreeSnapshot?: (worktreePath: string) => Promise<WorktreeSnapshot>;
  onChanged?: () => void;
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
  readonly #captureWorktreeSnapshot: (worktreePath: string) => Promise<WorktreeSnapshot>;
  readonly #onChanged: () => void;
  readonly #timers = new Set<ScheduledTask>();
  readonly #acknowledged = new Set<string>();
  readonly #resultRechecks = new Map<string, number>();
  #targets: HerdrMonitorTarget[] = [];
  #running = false;
  #initializing = false;
  #reconfiguring = false;

  constructor(options: OriginMonitorOptions) {
    this.#registry = options.registry;
    this.#herdr = options.herdr;
    this.#config = options.config;
    this.#originSessionId = required(options.originSessionId, "originSessionId");
    this.#clock = options.clock ?? systemMonitorClock;
    this.#onSettled = options.onSettled ?? (() => undefined);
    this.#onAttention = options.onAttention ?? (() => undefined);
    this.#resumedAfterOriginGap = options.resumedAfterOriginGap ?? false;
    this.#captureWorktreeSnapshot = options.captureWorktreeSnapshot ?? captureWorktreeSnapshot;
    this.#onChanged = options.onChanged ?? (() => undefined);
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
    await this.#catchUpAll();
    await this.refresh();
    this.#initializing = false;
    this.#scheduleLivenessPoll();
  }

  async refresh(): Promise<void> {
    if (!this.#running) return;
    const dispatches = this.#dispatches();
    await this.watchTargets(
      dispatches
        .filter((dispatch) => !this.#isSettlementPaused(dispatch.id))
        .map((dispatch) => ({
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
    this.#reconfiguring = true;
    try {
      await this.#herdr.monitorTargets(
        this.#targets,
        (event) => this.#handleEvent(event),
        (state) => this.#handleConnectionState(state),
      );
    } finally {
      this.#reconfiguring = false;
    }
  }

  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    for (const timer of this.#timers) this.#clock.clearTimeout(timer);
    this.#timers.clear();
    this.#acknowledged.clear();
    this.#resultRechecks.clear();
    this.#targets = [];
  }

  async #catchUpAll(): Promise<void> {
    for (const dispatch of this.#dispatches()) await this.#catchUp(dispatch);
  }

  async #catchUp(
    dispatch: StoredDispatch,
    resolvedTarget?: ResolvedHerdrTarget,
  ): Promise<void> {
    const resolved = resolvedTarget ?? await this.#resolve(dispatch);
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
      this.#clearAttentionBenign(current.id, "unacknowledged");
    } else if (resolved.pane.agentStatus === "idle" || resolved.pane.agentStatus === "done") {
      await this.#attention(current.id, "result-missing", { status: resolved.pane.agentStatus });
    }
  }

  async #handleEvent(event: HerdrMonitorEvent): Promise<void> {
    if (!this.#running) return;
    if (event.type === "output-matched") {
      const dispatch = this.#dispatches().find((item) => item.targetPaneId === event.paneId);
      if (dispatch) {
        const resolved = await this.#resolve(dispatch);
        if (resolved?.pane.paneId === event.paneId && event.read.paneId === event.paneId) {
          const settled = await this.#processRead(dispatch, event.read, false);
          if (!settled) this.#beginResultRecheck(dispatch.id);
        }
      } else {
        await this.#recoverUnmatchedStatusEvent(event.paneId);
      }
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
    if (!dispatch) {
      await this.#recoverUnmatchedStatusEvent(event.paneId, event.status);
      return;
    }
    await this.#handleStatusEvent(dispatch, event.status);
  }

  async #handleStatusEvent(dispatch: StoredDispatch, status: HerdrAgentStatus): Promise<void> {
    if (status === "working") {
      this.#acknowledged.add(dispatch.id);
      this.#clearAttentionBenign(dispatch.id, "unacknowledged");
      return;
    }
    if (status === "blocked") {
      const tail = await this.#herdr.readTail(dispatch.targetPaneId, 50);
      await this.#attention(dispatch.id, "blocked-runtime", { tail: tail.text, lines: 50 });
      return;
    }
    if (status === "idle" || status === "done") {
      const tail = await this.#herdr.readTail(dispatch.targetPaneId, 200);
      if (!(await this.#processRead(dispatch, tail))) {
        await this.#attention(dispatch.id, "result-missing", { status });
      }
    }
  }

  async #handlePossibleRouteChange(dispatch: StoredDispatch): Promise<void> {
    const subscribedPaneId = this.#targets.find(
      (target) => target.correlationId === dispatch.id,
    )?.paneId;
    const resolved = await this.#resolve(dispatch);
    if (!resolved) {
      await this.#attention(dispatch.id, "target-lost", { terminalId: dispatch.targetTerminalId });
      return;
    }
    if (dispatch.targetPaneId === resolved.pane.paneId && subscribedPaneId === resolved.pane.paneId) return;
    const current = this.#registry.getDispatch(dispatch.id);
    if (!current || current.lifecycle === "settled") return;
    await this.#catchUp(current, resolved);
    await this.refresh();
  }

  async #recoverUnmatchedStatusEvent(
    paneId: string,
    status?: HerdrAgentStatus,
  ): Promise<void> {
    const target = this.#targets.find((candidate) => candidate.paneId === paneId);
    if (!target) return;
    const dispatch = this.#registry.getDispatch(target.correlationId);
    if (!dispatch || dispatch.lifecycle === "settled") return;
    await this.#handlePossibleRouteChange(dispatch);
    if (status === undefined) return;
    const current = this.#registry.getDispatch(dispatch.id);
    if (!current || current.lifecycle === "settled" || this.#isSettlementPaused(current.id)) return;
    await this.#handleStatusEvent(current, status);
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
    if (!this.#initializing && !this.#reconfiguring) await this.#catchUpAll();
  }

  async #processRead(
    dispatch: StoredDispatch,
    read: HerdrPaneRead,
    recordMalformed = true,
  ): Promise<boolean> {
    const current = this.#registry.getDispatch(dispatch.id);
    if (!current || current.lifecycle === "settled" || this.#isSettlementPaused(current.id)) return false;
    const scan = scanResultTail(read.text, current.id);
    if (recordMalformed) {
      for (const malformed of scan.malformed) {
        await this.#attention(current.id, "malformed-result", {
          raw: malformed.raw,
          reason: malformed.reason,
        });
      }
    }
    if (!scan.valid) return false;
    await this.#auditWorktree(current);
    const settlement = this.#registry.settle({
      dispatchId: current.id,
      outcome: scan.valid.result.outcome,
      sourceTerminalId: current.targetTerminalId,
      rawEnvelope: scan.valid.raw,
      sanitizedResult: scan.valid.result,
      kind: "result",
      settledAt: this.#clock.now(),
    });
    if (settlement.status === "settled") {
      this.#onChanged();
      try {
        await this.#onSettled(current.id);
      } catch (error) {
        this.#registry.recordAudit(
          current.id,
          "context-delivery-pending",
          { error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) },
          this.#clock.now(),
        );
      }
    }
    return true;
  }

  async #auditWorktree(dispatch: StoredDispatch): Promise<void> {
    if (!dispatch.worktreePath) return;
    const beforeEvent = this.#registry
      .listAuditEvents(dispatch.id)
      .find((event) => event.eventType === "worktree-before-snapshot");
    const before = parseWorktreeSnapshot(beforeEvent?.data);
    try {
      const after = await this.#captureWorktreeSnapshot(dispatch.worktreePath);
      const overlappingWriter = this.#registry
        .listWriteLeases()
        .some(
          (lease) =>
            lease.worktreePath === dispatch.worktreePath && lease.dispatchId !== dispatch.id,
        );
      const conclusion = overlappingWriter
        ? "inconclusive-overlapping-writer"
        : !before
          ? "inconclusive-missing-baseline"
          : before.fingerprint === after.fingerprint
            ? "unchanged"
            : "observed-changes";
      this.#registry.recordAudit(
        dispatch.id,
        "worktree-after-snapshot",
        {
          conclusion,
          beforeFingerprint: before?.fingerprint,
          afterFingerprint: after.fingerprint,
          changedEntries: after.entries,
          diffStat: after.diffStat,
          attribution: "not-attributed-to-target",
        },
        this.#clock.now(),
      );
    } catch (error) {
      this.#registry.recordAudit(
        dispatch.id,
        "worktree-after-snapshot",
        {
          conclusion: "inconclusive-snapshot-error",
          error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
          attribution: "not-attributed-to-target",
        },
        this.#clock.now(),
      );
    }
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

  #beginResultRecheck(dispatchId: string): void {
    if (this.#resultRechecks.has(dispatchId)) return;
    this.#resultRechecks.set(dispatchId, this.#clock.now());
    this.#scheduleResultRecheckAttempt(dispatchId, 0);
  }

  #scheduleResultRecheckAttempt(dispatchId: string, attempt: number): void {
    const startedAt = this.#resultRechecks.get(dispatchId);
    if (startedAt === undefined) return;
    const remainingMs = this.#config.startupWindowMs - (this.#clock.now() - startedAt);
    if (remainingMs <= 0) {
      this.#resultRechecks.delete(dispatchId);
      return;
    }
    const requestedDelay = RESULT_RECHECK_DELAYS_MS[attempt] ?? remainingMs;
    const delay = Math.min(requestedDelay, remainingMs);
    this.#schedule(delay, async () => {
      const dispatch = this.#registry.getDispatch(dispatchId);
      if (!dispatch || dispatch.lifecycle === "settled") {
        this.#resultRechecks.delete(dispatchId);
        return;
      }
      const finalAttempt = this.#clock.now() - startedAt >= this.#config.startupWindowMs;
      try {
        const resolved = await this.#resolve(dispatch);
        if (resolved) {
          const read = await this.#herdr.readTail(resolved.pane.paneId, 200);
          if (await this.#processRead(dispatch, read, finalAttempt)) {
            this.#resultRechecks.delete(dispatchId);
            return;
          }
        }
      } catch {
        // Subscription state handles transport attention. Keep this bounded retry
        // alive while its startup window remains so a transient read failure does
        // not permanently miss the completed Result Envelope.
      }
      if (finalAttempt) {
        this.#resultRechecks.delete(dispatchId);
        return;
      }
      this.#scheduleResultRecheckAttempt(dispatchId, attempt + 1);
    });
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

  #scheduleLivenessPoll(): void {
    if (!this.#running) return;
    this.#schedule(this.#config.livenessPollMs, async () => {
      for (const dispatch of this.#dispatches()) await this.#pollLiveness(dispatch);
      this.#scheduleLivenessPoll();
    });
  }

  async #pollLiveness(dispatch: StoredDispatch): Promise<void> {
    const resolved = await this.#resolve(dispatch);
    if (!resolved) {
      await this.#attention(dispatch.id, "target-lost", { terminalId: dispatch.targetTerminalId });
      return;
    }
    if (resolved.pane.agentStatus === "working") {
      this.#acknowledged.add(dispatch.id);
      this.#clearAttentionBenign(dispatch.id, "unacknowledged");
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
      if (result === "added") {
        this.#onChanged();
        await this.#onAttention(dispatchId, condition, details);
      }
    } catch (error) {
      if (!(error instanceof RegistryStateError)) throw error;
      if (this.#registry.getDispatch(dispatchId)?.lifecycle !== "settled") throw error;
    }
  }

  #clearAttentionBenign(dispatchId: string, condition: AttentionCondition): void {
    try {
      const result = this.#registry.clearAttention(dispatchId, condition, this.#clock.now());
      if (result === "cleared") this.#onChanged();
    } catch (error) {
      if (!(error instanceof RegistryStateError)) throw error;
      if (this.#registry.getDispatch(dispatchId)?.lifecycle !== "settled") throw error;
    }
  }

  #markActiveBenign(dispatchId: string): void {
    try {
      const result = this.#registry.markActive(dispatchId, this.#clock.now());
      if (result === "changed") this.#onChanged();
    } catch (error) {
      if (!(error instanceof RegistryStateError)) throw error;
      if (this.#registry.getDispatch(dispatchId)?.lifecycle !== "settled") throw error;
    }
  }

  #isSettlementPaused(dispatchId: string): boolean {
    const conditions = new Set(this.#registry.listAttention(dispatchId).map((item) => item.condition));
    return conditions.has("target-lost");
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

function parseWorktreeSnapshot(value: unknown): WorktreeSnapshot | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.fingerprint !== "string" || !Array.isArray(candidate.entries)) return undefined;
  if (!candidate.entries.every((entry) => typeof entry === "string")) return undefined;
  return {
    fingerprint: candidate.fingerprint,
    entries: candidate.entries as string[],
    diffStat: typeof candidate.diffStat === "string" ? candidate.diffStat : "",
  };
}

function required(value: string, label: string): string {
  if (!value) throw new TypeError(`${label} must not be empty`);
  return value;
}
