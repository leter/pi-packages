import { createHash, randomBytes } from "node:crypto";

import type { DispatchMode } from "../registry/types.js";

export type TargetStatusProvenance = "reported" | "screen-detected";

export interface ProposalTarget {
  terminalId: string;
  paneId: string;
  workspaceId: string;
  agentLabel: string;
  cwd: string;
  worktreePath?: string;
  status: "idle" | "done";
  statusProvenance: TargetStatusProvenance;
}

export interface DispatchProposalInput {
  target: ProposalTarget;
  mode: DispatchMode;
  task: string;
  deadlineMinutes: number;
  allowProjectDependencyInstall: boolean;
}

export interface DispatchProposal {
  readonly id: string;
  readonly target: Readonly<ProposalTarget>;
  readonly mode: DispatchMode;
  readonly task: string;
  readonly constraints: readonly string[];
  readonly allowProjectDependencyInstall: boolean;
  readonly advisoryWarning: string;
  readonly createdAt: number;
  readonly deadlineAt: number;
  readonly payload: string;
  readonly payloadHash: string;
}

export interface ProposalFactoryOptions {
  now?: number;
  correlationId?: string;
}

export const ADVISORY_SAFETY_WARNING =
  "Advisory safety only: the target Agent may ignore constraints. Input is sent to the currently focused prompt; stale-route risk cannot be eliminated, and ambiguous delivery is never resent automatically.";

const BASE_CONSTRAINTS = Object.freeze([
  "Do not delegate or spawn another agent.",
  "Stay in the confirmed directory/worktree.",
  "Follow the declared mutation mode.",
  "Do not commit, push, deploy, publish, mutate remote systems, or perform destructive cleanup.",
  "Global and system installs are forbidden.",
  "Project dependency installation is forbidden unless explicitly authorized above.",
]);

export function createDispatchProposal(
  input: DispatchProposalInput,
  options: ProposalFactoryOptions = {},
): DispatchProposal {
  validateTarget(input.target, input.mode);
  const task = normalizeTask(input.task);
  if (!Number.isSafeInteger(input.deadlineMinutes) || input.deadlineMinutes < 1 || input.deadlineMinutes > 1440) {
    throw new RangeError("deadlineMinutes must be an integer from 1 to 1440");
  }
  if (input.allowProjectDependencyInstall && input.mode !== "write") {
    throw new TypeError("project dependency installation requires a write proposal");
  }
  const createdAt = options.now ?? Date.now();
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new RangeError("proposal time is invalid");
  const id = options.correlationId ?? generateCorrelationId(createdAt);
  if (!/^hd_[A-Za-z0-9_-]{3,100}$/u.test(id)) throw new TypeError("invalid dispatch correlation ID");
  const deadlineAt = createdAt + input.deadlineMinutes * 60_000;
  if (!Number.isSafeInteger(deadlineAt)) throw new RangeError("proposal deadline is invalid");
  const target = Object.freeze({ ...input.target });
  const constraints = Object.freeze([...BASE_CONSTRAINTS]);
  const dependencyPermission = input.allowProjectDependencyInstall
    ? "explicitly authorized"
    : "forbidden";
  const payload = `[HERDR DISPATCH]
ID: ${id}
Mode: ${input.mode}
Target directory: ${target.cwd}
Deadline: ${new Date(deadlineAt).toISOString()}
Safety: advisory
Project dependency installation: ${dependencyPermission}

Task:
${task}

Constraints:
${constraints.map((constraint) => `- ${constraint}`).join("\n")}

Finish by printing exactly one single-line Result Envelope, not fenced in Markdown:
DISPATCH_RESULT {"id":"${id}","outcome":"done|blocked|failed|cancelled","summary":"..."}`;
  return Object.freeze({
    id,
    target,
    mode: input.mode,
    task,
    constraints,
    allowProjectDependencyInstall: input.allowProjectDependencyInstall,
    advisoryWarning: ADVISORY_SAFETY_WARNING,
    createdAt,
    deadlineAt,
    payload,
    payloadHash: createHash("sha256").update(payload, "utf8").digest("hex"),
  });
}

function generateCorrelationId(now: number): string {
  return `hd_${now.toString(36)}_${randomBytes(12).toString("base64url")}`;
}

function normalizeTask(value: string): string {
  if (typeof value !== "string") throw new TypeError("task must be a string");
  const task = value.replace(/\r\n?/gu, "\n").trim();
  if (!task) throw new TypeError("task must not be empty");
  if (task.length > 12_000) throw new RangeError("task must not exceed 12000 characters");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(task)) {
    throw new TypeError("task contains unsafe control characters");
  }
  return task;
}

function validateTarget(target: ProposalTarget, mode: DispatchMode): void {
  for (const [label, value] of [
    ["terminalId", target.terminalId],
    ["paneId", target.paneId],
    ["workspaceId", target.workspaceId],
    ["agentLabel", target.agentLabel],
    ["cwd", target.cwd],
  ] as const) {
    if (!value || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new TypeError(`target ${label} is empty or contains control characters`);
    }
  }
  if (target.status !== "idle" && target.status !== "done") {
    throw new TypeError("proposal target must be idle-like");
  }
  if (target.statusProvenance !== "reported" && target.statusProvenance !== "screen-detected") {
    throw new TypeError("proposal target status provenance is invalid");
  }
  if (mode === "write" && !target.worktreePath) {
    throw new TypeError("write proposal requires a canonical worktree path");
  }
  if (target.worktreePath && /[\u0000-\u001f\u007f]/u.test(target.worktreePath)) {
    throw new TypeError("worktree path contains control characters");
  }
}
