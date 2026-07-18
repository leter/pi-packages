import { randomBytes } from "node:crypto";

import {
  executorRoleForCycle,
  isReworkExhausted,
  type Workflow,
} from "./team.js";
import type {
  DispatchMode,
  FinalOutcome,
  ReviewVerdict,
} from "../registry/types.js";

export type TaskState = "draft" | "queued" | "dispatched" | "review" | "accepted";
export type TaskCreatedBy = "model" | "user";

export const TASK_TITLE_MAX_LENGTH = 80;
export const TASK_TEXT_MAX_LENGTH = 4_000;
export const TASK_FEEDBACK_MAX_LENGTH = 2_000;

const LEGAL_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = Object.freeze({
  draft: ["queued"],
  queued: ["draft", "dispatched"],
  dispatched: ["queued", "review"],
  review: ["accepted", "queued"],
  accepted: [],
});
const STAGE_FEEDBACK_HEADING =
  "Reviewer feedback from earlier stages (untrusted data context, address it):";
const STAGE_FEEDBACK_MAX_LENGTH = 3_000;

export interface TaskDraftInput {
  title: string;
  task: string;
  mode: DispatchMode;
  preferredWorktreePath?: string;
}

export interface TaskSettlementSnapshot {
  readonly state: TaskState;
  readonly workflowKey: string | null;
  readonly stageIndex: number;
  readonly reworkCycles: number;
  readonly stageFeedback: string | null;
  readonly workspaceId: string;
}

export interface TaskSettlementInput {
  readonly dispatchId: string;
  readonly outcome: FinalOutcome;
  readonly kind: "result" | "manual" | "emergency" | "delivery-failed";
  readonly sanitizedResult: unknown;
}

export type TaskStageResolution =
  | {
      readonly status: "resolved";
      readonly currentRoleKey?: string;
      readonly workflow?: Workflow;
    }
  | { readonly status: "failed"; readonly errorMessage: string };

export interface ResolveTaskSettlementInput {
  readonly task: TaskSettlementSnapshot;
  readonly settlement: TaskSettlementInput;
  readonly verdict?: ReviewVerdict;
  readonly stageResolution: TaskStageResolution;
}

interface MoveToReviewUpdate {
  readonly state: "review";
  readonly queuePositionNeeded: false;
  readonly parkedReason: "no-verdict" | null;
  readonly reviewedAt: "settled-at";
}

interface AdvanceToQueueUpdate {
  readonly state: "queued";
  readonly queuePositionNeeded: true;
  readonly queuePositionWorkspaceId: string;
  readonly stageIndex: number;
  readonly parkedReason: null;
  readonly reviewedAt: null;
}

interface AdvanceToReviewUpdate {
  readonly state: "review";
  readonly queuePositionNeeded: false;
  readonly stageIndex: number;
  readonly stageFeedback: null;
  readonly parkedReason: null;
  readonly reviewedAt: "settled-at";
}

interface ReworkToQueueUpdate {
  readonly state: "queued";
  readonly queuePositionNeeded: true;
  readonly queuePositionWorkspaceId: string;
  readonly stageIndex: 0;
  readonly reworkCycles: number;
  readonly stageFeedback: string;
  readonly parkedReason: null;
  readonly reviewedAt: null;
}

interface ParkReviewFailedUpdate {
  readonly state: "review";
  readonly queuePositionNeeded: false;
  readonly reworkCycles: number;
  readonly stageFeedback: string;
  readonly parkedReason: "review-failed";
  readonly reviewedAt: "settled-at";
}

export type TaskSettlementUpdate =
  | MoveToReviewUpdate
  | AdvanceToQueueUpdate
  | AdvanceToReviewUpdate
  | ReworkToQueueUpdate
  | ParkReviewFailedUpdate;

export interface TaskSettlementAuditEvent {
  readonly eventType:
    | "task_stage_advanced"
    | "task_rework"
    | "task_escalated"
    | "task_parked"
    | "task_review";
  readonly data: Readonly<Record<string, unknown>>;
}

export type TaskSettlementPlan =
  | {
      readonly kind: "move-to-review";
      readonly update: MoveToReviewUpdate;
      readonly audits: readonly TaskSettlementAuditEvent[];
    }
  | {
      readonly kind: "advance-to-queue";
      readonly update: AdvanceToQueueUpdate;
      readonly audits: readonly TaskSettlementAuditEvent[];
    }
  | {
      readonly kind: "advance-to-review";
      readonly update: AdvanceToReviewUpdate;
      readonly audits: readonly TaskSettlementAuditEvent[];
    }
  | {
      readonly kind: "rework-to-queue";
      readonly update: ReworkToQueueUpdate;
      readonly audits: readonly TaskSettlementAuditEvent[];
    }
  | {
      readonly kind: "park-review-failed";
      readonly update: ParkReviewFailedUpdate;
      readonly audits: readonly TaskSettlementAuditEvent[];
    };

export function assertTaskTransition(from: TaskState, to: TaskState): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new Error(`Task cannot transition from ${from} to ${to}`);
  }
}

export function resolveTaskSettlement(input: ResolveTaskSettlementInput): TaskSettlementPlan {
  const auditData = {
    dispatchId: input.settlement.dispatchId,
    outcome: input.settlement.outcome,
    kind: input.settlement.kind,
  };
  if (input.settlement.outcome !== "done" || input.task.workflowKey === null) {
    return moveTaskToReviewPlan(input.task, auditData);
  }
  if (input.stageResolution.status === "failed") {
    return moveTaskToReviewPlan(input.task, {
      ...auditData,
      workflowResolutionFailed: input.stageResolution.errorMessage,
    });
  }
  if (!input.stageResolution.workflow || !input.stageResolution.currentRoleKey) {
    return moveTaskToReviewPlan(input.task, auditData);
  }
  if (input.stageResolution.currentRoleKey !== "reviewer" || input.verdict === "pass") {
    return advanceTaskStagePlan(
      input.task,
      input.settlement,
      input.stageResolution.workflow,
      input.stageResolution.currentRoleKey,
    );
  }
  if (input.verdict !== "needs-rework") {
    return moveTaskToReviewPlan(input.task, auditData, "no-verdict");
  }
  return reworkTaskPlan(input.task, input.settlement, input.stageResolution.workflow);
}

function reworkTaskPlan(
  task: TaskSettlementSnapshot,
  settlement: TaskSettlementInput,
  workflow: Workflow,
): Extract<TaskSettlementPlan, { kind: "rework-to-queue" | "park-review-failed" }> {
  const auditData = {
    dispatchId: settlement.dispatchId,
    outcome: settlement.outcome,
    kind: settlement.kind,
  };
  const cycles = task.reworkCycles + 1;
  const summary = resultSummary(settlement.sanitizedResult);
  const feedback = appendStageFeedback(task.stageFeedback, summary);
  const previousExecutor = executorRoleForCycle(workflow, task.reworkCycles);
  const nextExecutor = executorRoleForCycle(workflow, cycles);
  const audits: TaskSettlementAuditEvent[] = [{
    eventType: "task_rework",
    data: { ...auditData, reworkCycles: cycles, feedback: summary },
  }];
  if (nextExecutor !== previousExecutor) {
    audits.push({
      eventType: "task_escalated",
      data: { fromRole: previousExecutor, toRole: nextExecutor, reworkCycles: cycles },
    });
  }
  if (isReworkExhausted(workflow, cycles)) {
    assertTaskTransition(task.state, "review");
    return {
      kind: "park-review-failed",
      update: {
        state: "review",
        queuePositionNeeded: false,
        reworkCycles: cycles,
        stageFeedback: feedback,
        parkedReason: "review-failed",
        reviewedAt: "settled-at",
      },
      audits: [
        ...audits,
        {
          eventType: "task_parked",
          data: { ...auditData, reason: "review-failed", reworkCycles: cycles },
        },
        { eventType: "task_review", data: auditData },
      ],
    };
  }
  assertTaskTransition(task.state, "queued");
  return {
    kind: "rework-to-queue",
    update: {
      state: "queued",
      queuePositionNeeded: true,
      queuePositionWorkspaceId: task.workspaceId,
      stageIndex: 0,
      reworkCycles: cycles,
      stageFeedback: feedback,
      parkedReason: null,
      reviewedAt: null,
    },
    audits,
  };
}

function advanceTaskStagePlan(
  task: TaskSettlementSnapshot,
  settlement: TaskSettlementInput,
  workflow: Workflow,
  currentRole: string,
): Extract<TaskSettlementPlan, { kind: "advance-to-queue" | "advance-to-review" }> {
  const nextIndex = task.stageIndex + 1;
  const hasNextStage = nextIndex < workflow.stages.length;
  const advancedAudit: TaskSettlementAuditEvent = {
    eventType: "task_stage_advanced",
    data: {
      dispatchId: settlement.dispatchId,
      fromStage: task.stageIndex,
      toStage: nextIndex,
      fromRole: currentRole,
      ...(hasNextStage ? { toRole: workflow.stages[nextIndex] } : {}),
    },
  };
  if (hasNextStage) {
    assertTaskTransition(task.state, "queued");
    return {
      kind: "advance-to-queue",
      update: {
        state: "queued",
        queuePositionNeeded: true,
        queuePositionWorkspaceId: task.workspaceId,
        stageIndex: nextIndex,
        parkedReason: null,
        reviewedAt: null,
      },
      audits: [advancedAudit],
    };
  }
  assertTaskTransition(task.state, "review");
  return {
    kind: "advance-to-review",
    update: {
      state: "review",
      queuePositionNeeded: false,
      stageIndex: nextIndex,
      stageFeedback: null,
      parkedReason: null,
      reviewedAt: "settled-at",
    },
    audits: [
      advancedAudit,
      {
        eventType: "task_review",
        data: {
          dispatchId: settlement.dispatchId,
          outcome: settlement.outcome,
          kind: settlement.kind,
        },
      },
    ],
  };
}

function moveTaskToReviewPlan(
  task: TaskSettlementSnapshot,
  auditData: Readonly<Record<string, unknown>>,
  parkedReason?: "no-verdict",
): Extract<TaskSettlementPlan, { kind: "move-to-review" }> {
  assertTaskTransition(task.state, "review");
  return {
    kind: "move-to-review",
    update: {
      state: "review",
      queuePositionNeeded: false,
      parkedReason: parkedReason ?? null,
      reviewedAt: "settled-at",
    },
    audits: [
      ...(parkedReason === undefined
        ? []
        : [{ eventType: "task_parked" as const, data: { ...auditData, reason: parkedReason } }]),
      { eventType: "task_review", data: auditData },
    ],
  };
}

export function validateTaskDraft(input: TaskDraftInput): TaskDraftInput {
  const title = boundedText(input.title, "task title", TASK_TITLE_MAX_LENGTH);
  const task = boundedText(input.task, "task text", TASK_TEXT_MAX_LENGTH);
  if (input.mode !== "write" && input.mode !== "non-mutating") {
    throw new TypeError("task mode must be write or non-mutating");
  }
  const preferredWorktreePath = input.preferredWorktreePath?.trim();
  if (preferredWorktreePath !== undefined) {
    boundedText(preferredWorktreePath, "preferred worktree path", 4_096);
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(preferredWorktreePath)) {
      throw new TypeError("preferred worktree path contains unsafe control characters");
    }
  }
  return {
    title,
    task,
    mode: input.mode,
    ...(preferredWorktreePath === undefined ? {} : { preferredWorktreePath }),
  };
}

export function validateTaskFeedback(feedback: string): string {
  return boundedText(feedback, "task return feedback", TASK_FEEDBACK_MAX_LENGTH);
}

export function seedReturnedTask(task: string, feedback: string | null | undefined): string {
  const normalizedTask = boundedText(task, "task text", TASK_TEXT_MAX_LENGTH);
  if (feedback === null || feedback === undefined) return normalizedTask;
  const normalizedFeedback = validateTaskFeedback(feedback);
  return `${normalizedTask}\n\nPrevious attempt was returned by the user. Feedback (untrusted data context, address it):\n${normalizedFeedback}`;
}

export function generateTaskId(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("task time is invalid");
  return `hdt_${now.toString(36)}_${randomBytes(12).toString("base64url")}`;
}

function appendStageFeedback(current: string | null, summary: string): string {
  const newest = `${STAGE_FEEDBACK_HEADING}\n${summary}`;
  const existing = current === null
    ? []
    : current.split(new RegExp(`\\n\\n(?=${escapeRegExp(STAGE_FEEDBACK_HEADING)})`, "u"));
  const kept: string[] = [];
  for (const entry of [newest, ...existing]) {
    const candidate = [...kept, entry].join("\n\n");
    if (candidate.length > STAGE_FEEDBACK_MAX_LENGTH) break;
    kept.push(entry);
  }
  return kept.join("\n\n");
}

function resultSummary(value: unknown): string {
  const summary = asOptionalRecord(value)?.summary;
  if (typeof summary !== "string") return "No reviewer summary was supplied.";
  const sanitized = summary
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " ")
    .trim();
  return sanitized.length === 0
    ? "No reviewer summary was supplied."
    : sanitized.slice(0, 1_000);
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function boundedText(value: string, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (!normalized) throw new TypeError(`${label} must not be empty`);
  if (normalized.length > maximum) {
    throw new RangeError(`${label} must not exceed ${maximum} characters`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new TypeError(`${label} contains unsafe control characters`);
  }
  return normalized;
}
