import { MAX_INSPECTION_LINES, type DispatchConfig } from "../domain/config.js";
import { resolveCanonicalWorktree } from "../domain/worktree.js";
import {
  captureWorktreeSnapshot,
  type WorktreeSnapshot,
} from "../domain/worktree-audit.js";
import type {
  CurrentWorkspaceSnapshot,
  ResolvedHerdrTarget,
} from "../herdr/adapter.js";
import type {
  HerdrDeliveryRequest,
  HerdrDeliveryResult,
  HerdrEchoVerificationOptions,
} from "../herdr/delivery.js";
import type { HerdrPaneRead } from "../herdr/protocol.js";
import type {
  HerdrMonitorEvent,
  HerdrMonitorTarget,
  HerdrSubscriptionState,
} from "../herdr/subscription.js";
import {
  RegistryConflictError,
  type DispatchRegistry,
  RegistryStateError,
} from "../registry/registry.js";
import type {
  DispatchLifecycle,
  DispatchMode,
  FinalOutcome,
  StoredDispatch,
} from "../registry/types.js";
import { hasReportedProvenance } from "./agent-launch.js";
import {
  createDispatchProposal,
  normalizeDispatchTask,
  type DispatchProposal,
  type DispatchProposalInput,
  type ProposalTarget,
} from "./proposal.js";

export interface HerdrDispatchPort {
  currentWorkspaceSnapshot(): Promise<CurrentWorkspaceSnapshot>;
  resolveTerminal(terminalId: string): Promise<ResolvedHerdrTarget | undefined>;
  monitorTargets(
    targets: readonly HerdrMonitorTarget[],
    listener: (event: HerdrMonitorEvent) => void,
    stateListener?: (state: HerdrSubscriptionState) => void,
  ): Promise<void>;
  deliverAndVerify(
    request: HerdrDeliveryRequest,
    echoOptions?: HerdrEchoVerificationOptions,
  ): Promise<HerdrDeliveryResult>;
  readTail(paneId: string, lines: 50 | 200): Promise<HerdrPaneRead>;
}

export interface CreateProposalRequest {
  target: string;
  mode: DispatchMode;
  task: string;
  deadlineMinutes?: number;
  allowProjectDependencyInstall?: boolean;
  /** False downgrades this dispatch so its settlement never triggers an Auto Run turn. */
  wakeOnSettle?: boolean;
  /** Exact approved Board Task to bind in the durable-intent transaction. */
  taskId?: string;
}

export interface OriginIdentity {
  sessionId: string;
  sessionFile?: string;
}

export type ConfirmationResult =
  | { status: "active"; dispatchId: string; echoVerified: true; remainingQuota?: number }
  | {
      status: "delivery-unverified";
      dispatchId: string;
      lifecycle: "delivering";
      remainingQuota?: number;
    }
  | { status: "failed"; dispatchId: string; reason: string; remainingQuota?: number }
  | { status: "already-settled"; dispatchId: string; outcome: string; remainingQuota?: number };

export interface DispatchApplicationOptions {
  config: DispatchConfig;
  registry: DispatchRegistry;
  herdr: HerdrDispatchPort;
  workspaceId: string;
  originTerminalId: string;
  now?: () => number;
  nextCorrelationId?: () => string;
  resolveWorktree?: (cwd: string) => Promise<string>;
  prepareMonitoring?: (targets: readonly HerdrMonitorTarget[]) => Promise<void>;
  onIntentRecorded?: () => void | Promise<void>;
  captureWorktreeSnapshot?: (worktreePath: string) => Promise<WorktreeSnapshot>;
  onSettled?: (dispatchId: string, outcome: FinalOutcome) => void;
  /** Auto Run Depth for proposals confirmed right now: 0 in a user turn, parent depth + 1 in an Auto Run turn. */
  currentAutoRunDepth?: () => number;
}

export class ProposalTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalTargetError";
  }
}

export class StaleProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleProposalError";
  }
}

export class DispatchApplication {
  readonly #config: DispatchConfig;
  readonly #registry: DispatchRegistry;
  readonly #herdr: HerdrDispatchPort;
  readonly #workspaceId: string;
  readonly #originTerminalId: string;
  readonly #now: () => number;
  readonly #nextCorrelationId?: () => string;
  readonly #resolveWorktree: (cwd: string) => Promise<string>;
  readonly #prepareMonitoring: (targets: readonly HerdrMonitorTarget[]) => Promise<void>;
  readonly #onIntentRecorded: () => void | Promise<void>;
  readonly #captureWorktreeSnapshot: (worktreePath: string) => Promise<WorktreeSnapshot>;
  readonly #onSettled: (dispatchId: string, outcome: FinalOutcome) => void;
  readonly #currentAutoRunDepth: () => number;
  readonly #proposals = new Map<string, DispatchProposal>();

  constructor(options: DispatchApplicationOptions) {
    this.#config = options.config;
    this.#registry = options.registry;
    this.#herdr = options.herdr;
    this.#workspaceId = required(options.workspaceId, "workspaceId");
    this.#originTerminalId = required(options.originTerminalId, "originTerminalId");
    this.#now = options.now ?? Date.now;
    this.#nextCorrelationId = options.nextCorrelationId;
    this.#resolveWorktree = options.resolveWorktree ?? resolveCanonicalWorktree;
    this.#prepareMonitoring =
      options.prepareMonitoring ??
      ((targets) => this.#herdr.monitorTargets(targets, () => undefined));
    this.#onIntentRecorded = options.onIntentRecorded ?? (() => undefined);
    this.#captureWorktreeSnapshot = options.captureWorktreeSnapshot ?? captureWorktreeSnapshot;
    this.#onSettled = options.onSettled ?? (() => undefined);
    this.#currentAutoRunDepth = options.currentAutoRunDepth ?? (() => 0);
  }

  get defaultDeadlineMinutes(): number {
    return this.#config.defaultDeadlineMinutes;
  }

  async sharesCanonicalWorktree(worktreePath: string, cwd: string): Promise<boolean> {
    return worktreePath === await this.#resolveWorktree(cwd);
  }

  async assertCanCreateTarget(
    request: Omit<CreateProposalRequest, "target"> & { cwd: string },
  ): Promise<void> {
    this.assertCanCreateCapacity(request);
    if (request.mode !== "write") return;
    const worktreePath = await this.#resolveWorktree(request.cwd);
    this.#assertWorktreeLeaseAvailable(worktreePath);
  }

  assertCanCreateTargetAtWorktree(
    request: Omit<CreateProposalRequest, "target">,
    worktreePath: string,
  ): void {
    this.assertCanCreateCapacity(request);
    if (request.mode === "write") this.#assertWorktreeLeaseAvailable(worktreePath);
  }

  #assertWorktreeLeaseAvailable(worktreePath: string): void {
    const lease = this.#registry
      .listWriteLeases()
      .find((candidate) => candidate.worktreePath === worktreePath);
    if (lease) {
      throw new RegistryConflictError(
        "worktree-leased",
        `Worktree ${worktreePath} is leased by ${lease.dispatchId}`,
        lease.dispatchId,
      );
    }
  }

  assertCanCreateCapacity(
    request: Omit<CreateProposalRequest, "target">,
  ): void {
    normalizeDispatchTask(request.task);
    if (request.mode !== "write" && request.mode !== "non-mutating") {
      throw new TypeError("mode must be write or non-mutating");
    }
    if (request.allowProjectDependencyInstall && request.mode !== "write") {
      throw new TypeError("project dependency installation requires a write proposal");
    }
    const deadlineMinutes = request.deadlineMinutes ?? this.#config.defaultDeadlineMinutes;
    if (
      !Number.isSafeInteger(deadlineMinutes) ||
      deadlineMinutes < this.#config.minDeadlineMinutes ||
      deadlineMinutes > this.#config.maxDeadlineMinutes
    ) {
      throw new RangeError(
        `deadlineMinutes must be from ${this.#config.minDeadlineMinutes} to ${this.#config.maxDeadlineMinutes}`,
      );
    }
    if (this.#registry.listUnsettled().length >= this.#config.maxActiveGlobal) {
      throw new RegistryConflictError("global-limit", "Global active dispatch limit reached");
    }
    if (
      this.#registry.listUnsettledInWorkspace(this.#workspaceId).length >=
      this.#config.maxActivePerTargetWorkspace
    ) {
      throw new RegistryConflictError(
        "workspace-limit",
        `Active dispatch limit reached for workspace ${this.#workspaceId}`,
      );
    }
  }

  async listEligibleAgents(): Promise<readonly ProposalTarget[]> {
    const snapshot = await this.#herdr.currentWorkspaceSnapshot();
    if (snapshot.workspace.workspaceId !== this.#workspaceId) {
      throw new ProposalTargetError("Herdr returned a different workspace scope");
    }
    const occupied = new Set(
      this.#registry.listTargetOccupancy().map((record) => record.targetTerminalId),
    );
    const eligible = snapshot.agents
      .filter(
        (agent) =>
          agent.terminalId !== this.#originTerminalId &&
          (agent.agentStatus === "idle" || agent.agentStatus === "done") &&
          !occupied.has(agent.terminalId) &&
          agent.cwd !== undefined,
      )
    return Promise.all(
      eligible.map(async (agent) => {
        let worktreePath: string | undefined;
        try {
          worktreePath = await this.#resolveWorktree(agent.cwd!);
        } catch {
          // Non-Git Eligible Agents remain valid for non-mutating work.
        }
        const agentLabel = agent.agent ?? agent.name ?? agent.label ?? "unknown";
        return Object.freeze({
          terminalId: agent.terminalId,
          paneId: agent.paneId,
          workspaceId: agent.workspaceId,
          agentLabel,
          ...(agent.name === undefined ? {} : { displayName: agent.name }),
          cwd: agent.cwd!,
          ...(worktreePath === undefined ? {} : { worktreePath }),
          status: agent.agentStatus as "idle" | "done",
          statusProvenance: hasReportedProvenance(agent, agentLabel)
            ? "reported"
            : "screen-detected",
        });
      }),
    );
  }

  async createProposal(request: CreateProposalRequest): Promise<DispatchProposal> {
    const boardTask = request.taskId === undefined
      ? undefined
      : this.#registry.getTask(request.taskId);
    let preparedBoardTask:
      | { task: string; roleKey?: string; reviewerStage: boolean; stageMode: DispatchMode }
      | undefined;
    if (request.taskId !== undefined) {
      if (!boardTask) throw new ProposalTargetError(`Task ${safeText(request.taskId)} was not found`);
      if (boardTask.workspaceId !== this.#workspaceId) {
        throw new ProposalTargetError(
          `Task ${safeText(request.taskId)} is ${boardTask.state} in a foreign workspace`,
        );
      }
      if (boardTask.state !== "queued") {
        throw new ProposalTargetError(`Task ${safeText(request.taskId)} is ${boardTask.state}, not queued`);
      }
      try {
        preparedBoardTask = this.#registry.prepareTaskDispatch(request.taskId);
      } catch (error) {
        throw new ProposalTargetError(errorMessage(error));
      }
      if (preparedBoardTask.stageMode !== request.mode) {
        throw new ProposalTargetError(
          `Task ${safeText(request.taskId)} current stage requires mode ${preparedBoardTask.stageMode}`,
        );
      }
    }
    const eligible = await this.listEligibleAgents();
    const matches = eligible.filter(
      (target) =>
        target.terminalId === request.target ||
        target.agentLabel === request.target ||
        target.displayName === request.target,
    );
    if (matches.length !== 1) {
      throw new ProposalTargetError(
        matches.length === 0
          ? `Target ${safeText(request.target)} is not an Eligible Agent`
          : `Target ${safeText(request.target)} is ambiguous; use terminal ID`,
      );
    }
    const target = { ...matches[0]! };
    if (request.mode === "write") {
      target.worktreePath = await this.#resolveWorktree(target.cwd);
    } else {
      try {
        target.worktreePath = await this.#resolveWorktree(target.cwd);
      } catch {
        // Non-Git non-mutating targets remain instruction-only.
      }
    }
    const deadlineMinutes = request.deadlineMinutes ?? this.#config.defaultDeadlineMinutes;
    if (
      !Number.isSafeInteger(deadlineMinutes) ||
      deadlineMinutes < this.#config.minDeadlineMinutes ||
      deadlineMinutes > this.#config.maxDeadlineMinutes
    ) {
      throw new RangeError(
        `deadlineMinutes must be from ${this.#config.minDeadlineMinutes} to ${this.#config.maxDeadlineMinutes}`,
      );
    }
    const factoryInput: DispatchProposalInput = {
      target,
      mode: request.mode,
      task: preparedBoardTask?.task ?? request.task,
      deadlineMinutes,
      allowProjectDependencyInstall: request.allowProjectDependencyInstall ?? false,
      wakeOnSettle: request.wakeOnSettle ?? true,
      ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
      ...(preparedBoardTask?.reviewerStage === true ? { reviewerStage: true } : {}),
    };
    const now = this.#now();
    const proposal = createDispatchProposal(factoryInput, {
      now,
      ...(this.#nextCorrelationId === undefined
        ? {}
        : { correlationId: this.#nextCorrelationId() }),
    });
    this.#proposals.set(proposal.id, proposal);
    return proposal;
  }

  cancelProposal(proposal: DispatchProposal): void {
    if (this.#proposals.get(proposal.id) === proposal) this.#proposals.delete(proposal.id);
  }

  async reviseProposal(
    proposal: DispatchProposal,
    request: Omit<CreateProposalRequest, "target">,
  ): Promise<DispatchProposal> {
    this.#consumeProposal(proposal);
    return this.createProposal({ ...request, target: proposal.target.terminalId });
  }

  async confirmProposal(
    proposal: DispatchProposal,
    origin: OriginIdentity,
  ): Promise<ConfirmationResult> {
    this.#consumeProposal(proposal);
    const resolved = await this.#revalidate(proposal);
    const existingTargets = this.#registry.listUnsettled(origin.sessionId).map((dispatch) => ({
      paneId: dispatch.targetPaneId,
      correlationId: dispatch.id,
    }));
    await this.#prepareMonitoring([
      ...existingTargets,
      { paneId: resolved.pane.paneId, correlationId: proposal.id },
    ]);

    const beforeSnapshot = proposal.target.worktreePath
      ? await this.#captureWorktreeSnapshot(proposal.target.worktreePath)
      : undefined;
    const confirmedAt = this.#now();
    const remainingRunQuota = this.#registry.confirmDeliveryIntent({
      id: proposal.id,
      originSessionId: required(origin.sessionId, "origin session ID"),
      ...(origin.sessionFile === undefined ? {} : { originSessionFile: origin.sessionFile }),
      originWorkspaceId: this.#workspaceId,
      targetWorkspaceId: this.#workspaceId,
      targetTerminalId: proposal.target.terminalId,
      targetPaneId: resolved.pane.paneId,
      targetAgentLabel: proposal.target.agentLabel,
      targetCwd: proposal.target.cwd,
      ...(proposal.target.worktreePath === undefined
        ? {}
        : { worktreePath: proposal.target.worktreePath }),
      mode: proposal.mode,
      task: proposal.task,
      constraints: proposal.constraints,
      payload: proposal.payload,
      payloadHash: proposal.payloadHash,
      deadlineAt: proposal.deadlineAt,
      confirmedAt,
      maxActivePerTargetWorkspace: this.#config.maxActivePerTargetWorkspace,
      maxActiveGlobal: this.#config.maxActiveGlobal,
      autoRunDepth: this.#currentAutoRunDepth(),
      wakeOnSettle: proposal.wakeOnSettle,
      ...(proposal.taskId === undefined
        ? {}
        : { taskId: proposal.taskId, defaultRunQuota: this.#config.defaultRunQuota }),
    });
    if (beforeSnapshot) {
      this.#registry.recordAudit(
        proposal.id,
        "worktree-before-snapshot",
        beforeSnapshot,
        confirmedAt,
      );
    }
    try {
      await this.#onIntentRecorded();
    } catch (error) {
      const settlement = this.#registry.settle({
        dispatchId: proposal.id,
        outcome: "failed",
        sanitizedResult: {
          id: proposal.id,
          outcome: "failed",
          summary: `Origin monitoring could not start before delivery: ${errorMessage(error).slice(0, 500)}`,
        },
        kind: "delivery-failed",
        settledAt: this.#now(),
      });
      if (settlement.status === "settled") this.#onSettled(proposal.id, settlement.outcome);
      return this.#withRemainingQuota({
        status: "failed",
        dispatchId: proposal.id,
        reason: "monitoring-unavailable",
      }, remainingRunQuota);
    }

    let delivery: HerdrDeliveryResult;
    try {
      delivery = await this.#herdr.deliverAndVerify(
        {
          target: {
            terminalId: proposal.target.terminalId,
            expectedAgent: proposal.target.agentLabel,
            expectedCwd: proposal.target.cwd,
          },
          correlationId: proposal.id,
          text: proposal.payload,
        },
        { echoWindowMs: this.#config.startupWindowMs },
      );
    } catch (error) {
      const settled = this.#addDeliveryAttentionOrReadSettlement(
        proposal.id,
        { reason: "adapter-error", detail: errorMessage(error) },
        this.#now(),
      );
      if (settled) return this.#withRemainingQuota(settled, remainingRunQuota);
      return this.#withRemainingQuota({
        status: "delivery-unverified",
        dispatchId: proposal.id,
        lifecycle: "delivering",
      }, remainingRunQuota);
    }
    const recorded = this.#recordDelivery(proposal, delivery);
    try {
      await this.#onIntentRecorded();
    } catch (error) {
      this.#registry.recordAudit(
        proposal.id,
        "monitor-refresh-failed",
        { error: errorMessage(error).slice(0, 500) },
        this.#now(),
      );
    }
    return this.#withRemainingQuota(recorded, remainingRunQuota);
  }

  listTasks() {
    return this.#registry.listTasks(this.#workspaceId);
  }

  createTask(input: Omit<Parameters<DispatchRegistry["createTask"]>[0], "workspaceId">) {
    return this.#registry.createTask({ ...input, workspaceId: this.#workspaceId });
  }

  approveTasks(taskIds: readonly string[], approvedAt: number): number {
    return this.#registry.approveTasks(taskIds, this.#workspaceId, approvedAt);
  }

  demoteTask(taskId: string, demotedAt: number): void {
    this.#registry.demoteTask(taskId, this.#workspaceId, demotedAt);
  }

  acceptTasks(taskIds: readonly string[], acceptedAt: number): number {
    return this.#registry.acceptTasks(taskIds, this.#workspaceId, acceptedAt);
  }

  returnTask(taskId: string, feedback: string, returnedAt: number): void {
    this.#registry.returnTask(taskId, feedback, this.#workspaceId, returnedAt);
  }

  deleteDraft(taskId: string, deletedAt: number): void {
    this.#registry.deleteDraft(taskId, this.#workspaceId, deletedAt);
  }

  getDispatch(dispatchId: string): StoredDispatch | undefined {
    const dispatch = this.#registry.getDispatch(dispatchId);
    return dispatch?.targetWorkspaceId === this.#workspaceId ? dispatch : undefined;
  }

  listUnsettled(originSessionId?: string): readonly StoredDispatch[] {
    return this.#registry.listUnsettled(originSessionId);
  }

  listUnsettledInWorkspace(): readonly StoredDispatch[] {
    return this.#registry.listUnsettledInWorkspace(this.#workspaceId);
  }

  listByIdPrefix(prefix: string): readonly StoredDispatch[] {
    return this.#registry.listByIdPrefix(this.#workspaceId, prefix);
  }

  listAttention(dispatchId: string) {
    return this.#registry.listAttention(dispatchId);
  }

  listRecentSettledInWorkspace(limit: number): readonly StoredDispatch[] {
    return this.#registry.listRecentSettledInWorkspace(this.#workspaceId, limit);
  }

  /** Whether a terminal still exists in the current workspace (regardless of eligibility). */
  async agentTerminalExists(terminalId: string): Promise<boolean> {
    const snapshot = await this.#herdr.currentWorkspaceSnapshot();
    return snapshot.agents.some((agent) => agent.terminalId === terminalId);
  }

  getResult(dispatchId: string) {
    return this.#registry.getResult(dispatchId);
  }

  listUnseenSettled(): readonly StoredDispatch[] {
    return this.#registry.listUnseenSettled(this.#workspaceId);
  }

  markResultSeen(dispatchId: string, seenAt: number): void {
    this.#registry.markResultSeen(dispatchId, seenAt);
  }

  markResultsSeen(dispatchIds: readonly string[], seenAt: number): number {
    return this.#registry.markWorkspaceResultsSeen(this.#workspaceId, dispatchIds, seenAt);
  }

  async inspectAgent(target: string, requestedLines: number): Promise<{ target: ProposalTarget; text: string }> {
    if (!Number.isSafeInteger(requestedLines) || requestedLines < 1 || requestedLines > MAX_INSPECTION_LINES) {
      throw new RangeError(`inspection lines must be from 1 to ${MAX_INSPECTION_LINES}`);
    }
    const snapshot = await this.#herdr.currentWorkspaceSnapshot();
    const candidates = snapshot.agents.filter(
      (agent) =>
        agent.terminalId !== this.#originTerminalId &&
        (agent.terminalId === target || agent.agent === target || agent.name === target),
    );
    if (candidates.length !== 1) throw new ProposalTargetError("inspection target is missing or ambiguous");
    const candidate = candidates[0]!;
    if (!candidate.cwd) throw new ProposalTargetError("inspection target has no confirmed cwd");
    const read = await this.#herdr.readTail(candidate.paneId, requestedLines <= 50 ? 50 : 200);
    const lines = read.text.split(/\r?\n/u);
    const agentLabel = candidate.agent ?? candidate.name ?? candidate.label ?? "unknown";
    return {
      target: {
        terminalId: candidate.terminalId,
        paneId: candidate.paneId,
        workspaceId: candidate.workspaceId,
        agentLabel,
        ...(candidate.name === undefined ? {} : { displayName: candidate.name }),
        cwd: candidate.cwd,
        status:
          candidate.agentStatus === "done" ? "done" : "idle",
        statusProvenance: hasReportedProvenance(candidate, agentLabel)
          ? "reported"
          : "screen-detected",
      },
      text: lines.slice(-requestedLines).join("\n"),
    };
  }

  async #revalidate(proposal: DispatchProposal): Promise<ResolvedHerdrTarget> {
    const occupied = this.#registry
      .listTargetOccupancy()
      .some((record) => record.targetTerminalId === proposal.target.terminalId);
    if (occupied) throw new StaleProposalError("proposal target became occupied");
    const resolved = await this.#herdr.resolveTerminal(proposal.target.terminalId);
    if (!resolved) throw new StaleProposalError("proposal target was lost");
    const actualAgent = resolved.agent?.agent ?? resolved.pane.agent ?? resolved.agent?.name ??
      resolved.agent?.label ?? resolved.pane.label;
    const provenance = actualAgent !== undefined && hasReportedProvenance(
      {
        screenDetectionSkipped: resolved.agent?.screenDetectionSkipped === true,
        agentSession: resolved.agent?.agentSession ?? resolved.pane.agentSession,
      },
      actualAgent,
    )
      ? "reported"
      : "screen-detected";
    if (
      resolved.pane.workspaceId !== proposal.target.workspaceId ||
      resolved.pane.cwd !== proposal.target.cwd ||
      actualAgent !== proposal.target.agentLabel ||
      provenance !== proposal.target.statusProvenance ||
      (resolved.pane.agentStatus !== "idle" && resolved.pane.agentStatus !== "done")
    ) {
      throw new StaleProposalError("proposal target identity, status, provenance, workspace, or cwd changed");
    }
    if (proposal.mode === "write") {
      const currentWorktree = await this.#resolveWorktree(resolved.pane.cwd);
      if (currentWorktree !== proposal.target.worktreePath) {
        throw new StaleProposalError("proposal worktree identity changed");
      }
      const leased = this.#registry
        .listWriteLeases()
        .some((lease) => lease.worktreePath === currentWorktree);
      if (leased) throw new StaleProposalError("proposal worktree became leased");
    }
    return resolved;
  }

  #withRemainingQuota(
    result: ConfirmationResult,
    remainingQuota: number | undefined,
  ): ConfirmationResult {
    return remainingQuota === undefined ? result : { ...result, remainingQuota };
  }

  #consumeProposal(proposal: DispatchProposal): void {
    if (this.#proposals.get(proposal.id) !== proposal) {
      throw new StaleProposalError("proposal is stale, revised, cancelled, or already consumed");
    }
    this.#proposals.delete(proposal.id);
  }

  #recordDelivery(
    proposal: DispatchProposal,
    delivery: HerdrDeliveryResult,
  ): ConfirmationResult {
    const now = this.#now();
    if (delivery.status === "not-sent") {
      const settlement = this.#registry.settle({
        dispatchId: proposal.id,
        outcome: "failed",
        sanitizedResult: {
          id: proposal.id,
          outcome: "failed",
          summary: `Delivery was rejected before input acceptance: ${delivery.reason}`,
        },
        kind: "delivery-failed",
        settledAt: now,
      });
      if (settlement.status === "settled") this.#onSettled(proposal.id, settlement.outcome);
      return { status: "failed", dispatchId: proposal.id, reason: delivery.reason };
    }
    if (delivery.status === "verified") {
      const settled = this.#markActiveOrReadSettlement(proposal.id, now);
      if (settled) return settled;
      return { status: "active", dispatchId: proposal.id, echoVerified: true };
    }

    const dispatch = this.#registry.getDispatch(proposal.id);
    if (dispatch?.lifecycle === "settled") {
      return {
        status: "already-settled",
        dispatchId: proposal.id,
        outcome: dispatch.finalOutcome ?? "unknown",
      };
    }
    const settled = this.#addDeliveryAttentionOrReadSettlement(
      proposal.id,
      { reason: delivery.reason, detail: delivery.detail },
      now,
    );
    if (settled) return settled;
    return { status: "delivery-unverified", dispatchId: proposal.id, lifecycle: "delivering" };
  }

  #addDeliveryAttentionOrReadSettlement(
    dispatchId: string,
    details: unknown,
    addedAt: number,
  ): Extract<ConfirmationResult, { status: "already-settled" }> | undefined {
    try {
      this.#registry.addAttention(dispatchId, "delivery-unverified", details, addedAt);
      return undefined;
    } catch (error) {
      if (!(error instanceof RegistryStateError)) throw error;
      const dispatch = this.#registry.getDispatch(dispatchId);
      if (dispatch?.lifecycle !== "settled") throw error;
      return {
        status: "already-settled",
        dispatchId,
        outcome: dispatch.finalOutcome ?? "unknown",
      };
    }
  }

  #markActiveOrReadSettlement(
    dispatchId: string,
    activeAt: number,
  ): Extract<ConfirmationResult, { status: "already-settled" }> | undefined {
    try {
      this.#registry.markActive(dispatchId, activeAt);
      return undefined;
    } catch (error) {
      if (!(error instanceof RegistryStateError)) throw error;
      const dispatch = this.#registry.getDispatch(dispatchId);
      if (dispatch?.lifecycle !== "settled") throw error;
      return {
        status: "already-settled",
        dispatchId,
        outcome: dispatch.finalOutcome ?? "unknown",
      };
    }
  }
}

function required(value: string, label: string): string {
  if (!value) throw new TypeError(`${label} must not be empty`);
  return value;
}

function safeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 160);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { RegistryConflictError };
export type { DispatchLifecycle };
