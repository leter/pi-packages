import type { TaskCreatedBy, TaskState } from "../domain/task-board.js";

export type { TaskCreatedBy, TaskState } from "../domain/task-board.js";

export type DispatchMode = "non-mutating" | "write";
export type DispatchLifecycle = "delivering" | "active" | "settled";
export type FinalOutcome = "done" | "blocked" | "failed" | "cancelled";
export type ReviewVerdict = "pass" | "needs-rework";
export type TaskParkedReason = "no-verdict" | "review-failed";
export type AttentionCondition =
  | "delivery-unverified"
  | "unacknowledged"
  | "overdue"
  | "blocked-runtime"
  | "monitoring-paused"
  | "malformed-result"
  | "result-missing"
  | "target-lost";

export interface ConfirmDeliveryIntent {
  id: string;
  originSessionId: string;
  originSessionFile?: string;
  originWorkspaceId: string;
  targetWorkspaceId: string;
  targetTerminalId: string;
  targetPaneId: string;
  targetAgentLabel: string;
  targetCwd: string;
  worktreePath?: string;
  mode: DispatchMode;
  task: string;
  constraints: readonly string[];
  payload: string;
  payloadHash: string;
  deadlineAt: number;
  confirmedAt: number;
  maxActivePerTargetWorkspace?: number;
  maxActiveGlobal?: number;
  /** Auto Run relay counter: 0 for user-turn proposals, parent depth + 1 inside an Auto Run turn. */
  autoRunDepth?: number;
  /** False downgrades this dispatch so its settlement never triggers an Auto Run turn. */
  wakeOnSettle?: boolean;
  /** Binds this fresh dispatch to one approved Board Task. */
  taskId?: string;
  /** Used only for a migrated armed session whose persisted quota is NULL. */
  defaultRunQuota?: number;
}

export interface StoredDispatch {
  id: string;
  originSessionId: string;
  originSessionFile?: string;
  originWorkspaceId: string;
  targetWorkspaceId: string;
  targetTerminalId: string;
  targetPaneId: string;
  targetAgentLabel: string;
  targetCwd: string;
  worktreePath?: string;
  mode: DispatchMode;
  lifecycle: DispatchLifecycle;
  finalOutcome?: FinalOutcome;
  task: string;
  constraints: readonly string[];
  payload: string;
  payloadHash: string;
  deadlineAt: number;
  createdAt: number;
  confirmedAt: number;
  deliveryStartedAt: number;
  activeAt?: number;
  settledAt?: number;
  /** When the user opened this settled dispatch's result; unset = unseen. */
  resultSeenAt?: number;
  /** Auto Run relay counter guaranteeing every settlement-wake chain terminates. */
  autoRunDepth: number;
  /** Whether an armed Origin Session may be woken by this dispatch's settlement. */
  wakeOnSettle: boolean;
  updatedAt: number;
}

export interface CreateTaskInput {
  id?: string;
  workspaceId: string;
  title: string;
  task: string;
  mode: DispatchMode;
  preferredWorktreePath?: string;
  role?: string;
  workflow?: string;
  createdBy: TaskCreatedBy;
  createdAt: number;
}

export interface StoredTask {
  id: string;
  workspaceId: string;
  title: string;
  task: string;
  mode: DispatchMode;
  preferredWorktreePath?: string;
  state: TaskState;
  queuePosition?: number;
  boundDispatchId?: string;
  returnFeedback?: string;
  role?: string;
  workflow?: string;
  stageIndex: number;
  reworkCycles: number;
  stageFeedback?: string;
  parkedReason?: TaskParkedReason;
  createdBy: TaskCreatedBy;
  createdAt: number;
  approvedAt?: number;
  reviewedAt?: number;
  acceptedAt?: number;
  updatedAt: number;
}

export type RunQuotaState =
  | { armed: false; legacyDefaulted: false }
  | {
      armed: true;
      quota: number;
      used: number;
      remaining: number;
      legacyDefaulted: boolean;
    };

export interface TargetOccupancyRecord {
  targetTerminalId: string;
  dispatchId: string;
  acquiredAt: number;
}

export interface WriteLeaseRecord {
  worktreePath: string;
  dispatchId: string;
  targetTerminalId: string;
  acquiredAt: number;
}

export interface AttentionRecord {
  condition: AttentionCondition;
  details: unknown;
  addedAt: number;
}

export interface AuditEventRecord {
  id: number;
  dispatchId?: string;
  eventType: string;
  data: unknown;
  createdAt: number;
}

export interface SettleDispatchInput {
  dispatchId: string;
  outcome: FinalOutcome;
  sourceTerminalId?: string;
  rawEnvelope?: string;
  sanitizedResult: unknown;
  kind: "result" | "manual" | "emergency" | "delivery-failed";
  resolverSessionId?: string;
  settledAt: number;
}

export interface DispatchResultRecord {
  dispatchId: string;
  outcome: FinalOutcome;
  sourceTerminalId?: string;
  rawEnvelope?: string;
  sanitizedResult: unknown;
  verdict?: ReviewVerdict;
  acceptedAt: number;
}

export interface ClaimContextDeliveryInput {
  dispatchId: string;
  originSessionId: string;
  branchLeafId: string;
  claimedAt: number;
}

export interface CompleteContextDeliveryInput {
  dispatchId: string;
  originSessionId: string;
  branchLeafId: string;
  entryId: string;
  completedAt: number;
}

export interface ContextDeliveryRecord {
  dispatchId: string;
  originSessionId: string;
  branchLeafId: string;
  claimedAt: number;
  deliveredEntryId?: string;
  deliveredAt?: number;
}
