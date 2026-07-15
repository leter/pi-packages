export type DispatchMode = "non-mutating" | "write";
export type DispatchLifecycle = "delivering" | "active" | "settled";
export type FinalOutcome = "done" | "blocked" | "failed" | "cancelled";
export type AttentionCondition =
  | "delivery-unverified"
  | "unacknowledged"
  | "overdue"
  | "blocked-runtime"
  | "monitoring-paused"
  | "malformed-result"
  | "result-missing"
  | "target-lost"
  | "target-moved";

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
  updatedAt: number;
}

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
