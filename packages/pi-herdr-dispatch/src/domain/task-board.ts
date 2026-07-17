import { randomBytes } from "node:crypto";

import type { DispatchMode } from "../registry/types.js";

export type TaskState = "draft" | "queued" | "dispatched" | "review" | "accepted";
export type TaskCreatedBy = "model" | "user";

export const TASK_TITLE_MAX_LENGTH = 80;
export const TASK_TEXT_MAX_LENGTH = 4_000;
export const TASK_FEEDBACK_MAX_LENGTH = 2_000;

const LEGAL_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = Object.freeze({
  draft: ["queued"],
  queued: ["dispatched"],
  dispatched: ["review"],
  review: ["accepted", "queued"],
  accepted: [],
});

export interface TaskDraftInput {
  title: string;
  task: string;
  mode: DispatchMode;
  preferredWorktreePath?: string;
}

export function assertTaskTransition(from: TaskState, to: TaskState): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new Error(`Task cannot transition from ${from} to ${to}`);
  }
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
