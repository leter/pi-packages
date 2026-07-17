import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import {
  assertTaskTransition,
  generateTaskId,
  seedReturnedTask,
  validateTaskDraft,
  validateTaskFeedback,
} from "../domain/task-board.js";
import { migrateRegistry } from "./migrations.js";
import type {
  AttentionCondition,
  AttentionRecord,
  AuditEventRecord,
  ClaimContextDeliveryInput,
  CompleteContextDeliveryInput,
  ConfirmDeliveryIntent,
  CreateTaskInput,
  ContextDeliveryRecord,
  DispatchResultRecord,
  DispatchLifecycle,
  DispatchMode,
  FinalOutcome,
  SettleDispatchInput,
  StoredDispatch,
  StoredTask,
  RunQuotaState,
  TargetOccupancyRecord,
  WriteLeaseRecord,
} from "./types.js";
export { REGISTRY_SCHEMA_VERSION } from "./schema.js";

const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export interface OpenRegistryOptions {
  busyTimeoutMs?: number;
  now?: () => Date;
}

export interface RegistryHealth {
  schemaVersion: number;
  journalMode: string;
  foreignKeys: boolean;
  busyTimeoutMs: number;
  integrity: string;
  mutationsEnabled: boolean;
}

export class RegistryUnavailableError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "RegistryUnavailableError";
    this.cause = cause;
  }
}

export class RegistryConflictError extends Error {
  readonly code:
    | "dispatch-exists"
    | "target-occupied"
    | "worktree-leased"
    | "worktree-held"
    | "workspace-limit"
    | "global-limit";
  readonly conflictingDispatchId?: string;

  constructor(
    code: RegistryConflictError["code"],
    message: string,
    conflictingDispatchId?: string,
  ) {
    super(message);
    this.name = "RegistryConflictError";
    this.code = code;
    this.conflictingDispatchId = conflictingDispatchId;
  }
}

export class RegistryStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryStateError";
  }
}

export class DispatchRegistry {
  readonly path: string;
  readonly #database: DatabaseSync;
  #closed = false;
  #mutationsDisabledReason?: string;

  constructor(path: string, database: DatabaseSync) {
    this.path = path;
    this.#database = database;
  }

  health(): RegistryHealth {
    this.#assertOpen();
    const schemaVersion = pragmaNumber(this.#database, "user_version");
    const busyTimeoutMs = pragmaNumber(this.#database, "busy_timeout", "timeout");
    const foreignKeys = pragmaNumber(this.#database, "foreign_keys") === 1;
    const journalMode = pragmaString(this.#database, "journal_mode").toLowerCase();
    const integrity = pragmaString(this.#database, "integrity_check");
    return {
      schemaVersion,
      journalMode,
      foreignKeys,
      busyTimeoutMs,
      integrity,
      mutationsEnabled: this.#mutationsDisabledReason === undefined,
    };
  }

  confirmDeliveryIntent(intent: ConfirmDeliveryIntent): number | undefined {
    validateIntent(intent);
    const constraintsJson = serializeJson(intent.constraints, "dispatch constraints");
    const worktreePath = intent.worktreePath ? resolve(intent.worktreePath) : undefined;

    return this.#mutate("confirm delivery intent", () => {
      const existingDispatch = this.#database
        .prepare("SELECT id FROM dispatches WHERE id = ?")
        .get(intent.id) as { id: string } | undefined;
      if (existingDispatch) {
        throw new RegistryConflictError("dispatch-exists", `Dispatch ${intent.id} already exists`, intent.id);
      }

      const boundTask = intent.taskId === undefined
        ? undefined
        : this.#taskForBinding(intent.taskId, intent);
      const remainingRunQuota = boundTask ? this.#consumeRunQuota(intent) : undefined;

      this.#assertConcurrency(intent);

      const occupied = this.#database
        .prepare("SELECT dispatch_id FROM target_occupancy WHERE target_terminal_id = ?")
        .get(intent.targetTerminalId) as { dispatch_id: string } | undefined;
      if (occupied) {
        throw new RegistryConflictError(
          "target-occupied",
          `Target ${intent.targetTerminalId} is occupied by ${occupied.dispatch_id}`,
          occupied.dispatch_id,
        );
      }

      if (intent.mode === "write") {
        const leased = this.#database
          .prepare("SELECT dispatch_id FROM worktree_write_leases WHERE worktree_path = ?")
          .get(worktreePath!) as { dispatch_id: string } | undefined;
        if (leased) {
          throw new RegistryConflictError(
            "worktree-leased",
            `Worktree ${worktreePath} is leased by ${leased.dispatch_id}`,
            leased.dispatch_id,
          );
        }
      }

      this.#database
        .prepare(
          `INSERT INTO dispatches (
            id, origin_session_id, origin_session_file, origin_workspace_id,
            target_workspace_id, target_terminal_id, target_pane_id, target_agent_label,
            target_cwd, worktree_path, mode, lifecycle, task, constraints_json,
            payload, payload_hash, deadline_at, created_at, confirmed_at,
            delivery_started_at, auto_run_depth, wake_on_settle, updated_at
          ) VALUES (
            :id, :originSessionId, :originSessionFile, :originWorkspaceId,
            :targetWorkspaceId, :targetTerminalId, :targetPaneId, :targetAgentLabel,
            :targetCwd, :worktreePath, :mode, 'delivering', :task, :constraintsJson,
            :payload, :payloadHash, :deadlineAt, :createdAt, :confirmedAt,
            :deliveryStartedAt, :autoRunDepth, :wakeOnSettle, :updatedAt
          )`,
        )
        .run({
          id: intent.id,
          originSessionId: intent.originSessionId,
          originSessionFile: intent.originSessionFile ?? null,
          originWorkspaceId: intent.originWorkspaceId,
          targetWorkspaceId: intent.targetWorkspaceId,
          targetTerminalId: intent.targetTerminalId,
          targetPaneId: intent.targetPaneId,
          targetAgentLabel: intent.targetAgentLabel,
          targetCwd: intent.targetCwd,
          worktreePath: worktreePath ?? null,
          mode: intent.mode,
          task: intent.task,
          constraintsJson,
          payload: intent.payload,
          payloadHash: intent.payloadHash,
          deadlineAt: intent.deadlineAt,
          createdAt: intent.confirmedAt,
          confirmedAt: intent.confirmedAt,
          deliveryStartedAt: intent.confirmedAt,
          autoRunDepth: boundTask ? 0 : (intent.autoRunDepth ?? 0),
          wakeOnSettle: intent.wakeOnSettle === false ? 0 : 1,
          updatedAt: intent.confirmedAt,
        });

      if (boundTask) {
        assertTaskTransition(boundTask.state, "dispatched");
        this.#database
          .prepare(
            `UPDATE tasks
             SET state = 'dispatched', bound_dispatch_id = ?, return_feedback = NULL,
                 reviewed_at = NULL, updated_at = ?
             WHERE id = ? AND state = 'queued'`,
          )
          .run(intent.id, intent.confirmedAt, boundTask.id);
        this.#appendTaskAudit(
          boundTask.id,
          "task_bound",
          { dispatchId: intent.id, previousDispatchId: boundTask.bound_dispatch_id },
          intent.confirmedAt,
        );
      }

      this.#database
        .prepare(
          "INSERT INTO target_occupancy(target_terminal_id, dispatch_id, acquired_at) VALUES (?, ?, ?)",
        )
        .run(intent.targetTerminalId, intent.id, intent.confirmedAt);

      if (intent.mode === "write") {
        this.#database
          .prepare(
            `INSERT INTO worktree_write_leases(
              worktree_path, dispatch_id, target_terminal_id, acquired_at
            ) VALUES (?, ?, ?, ?)`,
          )
          .run(worktreePath!, intent.id, intent.targetTerminalId, intent.confirmedAt);
      }

      this.#appendAudit(intent.id, "delivery-intent-confirmed", {
        payloadHash: intent.payloadHash,
        mode: intent.mode,
        authorization: { kind: "automatic-default" },
      }, intent.confirmedAt);
      return remainingRunQuota;
    });
  }

  createTask(input: CreateTaskInput): StoredTask {
    const validated = validateTaskDraft(input);
    if (!input.workspaceId) throw new TypeError("workspaceId must not be empty");
    if (input.createdBy !== "model" && input.createdBy !== "user") {
      throw new TypeError("createdBy must be model or user");
    }
    validateTimestamp(input.createdAt, "createdAt");
    const id = input.id ?? generateTaskId(input.createdAt);
    if (!/^hdt_[A-Za-z0-9_-]{1,100}$/u.test(id)) throw new TypeError("invalid task ID");
    const preferredWorktreePath = validated.preferredWorktreePath
      ? resolve(validated.preferredWorktreePath)
      : undefined;
    return this.#mutate("create task draft", () => {
      this.#database
        .prepare(
          `INSERT INTO tasks(
            id, workspace_id, title, task, mode, preferred_worktree_path, state,
            created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
        )
        .run(
          id,
          input.workspaceId,
          validated.title,
          validated.task,
          validated.mode,
          preferredWorktreePath ?? null,
          input.createdBy,
          input.createdAt,
          input.createdAt,
        );
      this.#appendTaskAudit(id, "task_drafted", { createdBy: input.createdBy }, input.createdAt);
      return this.#taskById(id)!;
    });
  }

  listTasks(workspaceId: string): readonly StoredTask[] {
    if (!workspaceId) throw new TypeError("workspaceId must not be empty");
    return this.#read("list board tasks", () =>
      (this.#database
        .prepare(
          `SELECT * FROM tasks WHERE workspace_id = ?
           ORDER BY CASE state
             WHEN 'draft' THEN 0 WHEN 'queued' THEN 1 WHEN 'dispatched' THEN 2
             WHEN 'review' THEN 3 ELSE 4 END,
             CASE WHEN queue_position IS NULL THEN created_at ELSE queue_position END, id`,
        )
        .all(workspaceId) as unknown as TaskRow[]).map(mapTask),
    );
  }

  getTask(taskId: string): StoredTask | undefined {
    validateTaskIds([taskId]);
    return this.#read("read board task", () => this.#taskById(taskId));
  }

  approveTasks(taskIds: readonly string[], workspaceId: string, approvedAt: number): number {
    validateTaskIds(taskIds);
    if (!workspaceId) throw new TypeError("workspaceId must not be empty");
    validateTimestamp(approvedAt, "approvedAt");
    const ids = [...new Set(taskIds)];
    if (ids.length === 0) return 0;
    return this.#mutate("approve task drafts", () => {
      const tasks = ids.map((id) => this.#requireTaskState(id, workspaceId, "draft"));
      let queuePosition = count(
        this.#database.prepare(
          "SELECT COALESCE(MAX(queue_position), 0) AS count FROM tasks WHERE workspace_id = ?",
        ),
        workspaceId,
      );
      const update = this.#database.prepare(
        `UPDATE tasks SET state = 'queued', queue_position = ?, approved_at = ?, updated_at = ?
         WHERE id = ? AND state = 'draft'`,
      );
      for (const task of tasks) {
        assertTaskTransition(task.state, "queued");
        queuePosition += 1;
        update.run(queuePosition, approvedAt, approvedAt, task.id);
        this.#appendTaskAudit(task.id, "task_approved", { queuePosition }, approvedAt);
      }
      return tasks.length;
    });
  }

  demoteTask(taskId: string, workspaceId: string, demotedAt: number): void {
    validateTaskIds([taskId]);
    if (!workspaceId) throw new TypeError("workspaceId must not be empty");
    validateTimestamp(demotedAt, "demotedAt");
    this.#mutate("demote queued task to draft", () => {
      const task = this.#requireTaskState(taskId, workspaceId, "queued");
      assertTaskTransition(task.state, "draft");
      this.#database
        .prepare(
          `UPDATE tasks SET state = 'draft', queue_position = NULL, approved_at = NULL,
             updated_at = ? WHERE id = ? AND state = 'queued'`,
        )
        .run(demotedAt, taskId);
      this.#appendTaskAudit(taskId, "task_demoted", {}, demotedAt);
    });
  }

  acceptTasks(taskIds: readonly string[], workspaceId: string, acceptedAt: number): number {
    validateTaskIds(taskIds);
    if (!workspaceId) throw new TypeError("workspaceId must not be empty");
    validateTimestamp(acceptedAt, "acceptedAt");
    const ids = [...new Set(taskIds)];
    if (ids.length === 0) return 0;
    return this.#mutate("accept reviewed tasks", () => {
      const tasks = ids.map((id) => this.#requireTaskState(id, workspaceId, "review"));
      const update = this.#database.prepare(
        `UPDATE tasks SET state = 'accepted', accepted_at = ?, updated_at = ?
         WHERE id = ? AND state = 'review'`,
      );
      for (const task of tasks) {
        assertTaskTransition(task.state, "accepted");
        update.run(acceptedAt, acceptedAt, task.id);
        this.#appendTaskAudit(task.id, "task_accepted", {}, acceptedAt);
      }
      return tasks.length;
    });
  }

  returnTask(taskId: string, feedback: string, workspaceId: string, returnedAt: number): void {
    validateTaskIds([taskId]);
    if (!workspaceId) throw new TypeError("workspaceId must not be empty");
    validateTimestamp(returnedAt, "returnedAt");
    const validatedFeedback = validateTaskFeedback(feedback);
    this.#mutate("return reviewed task", () => {
      const task = this.#requireTaskState(taskId, workspaceId, "review");
      assertTaskTransition(task.state, "queued");
      const previous = task.bound_dispatch_id
        ? this.#database
            .prepare("SELECT worktree_path FROM dispatches WHERE id = ?")
            .get(task.bound_dispatch_id) as { worktree_path: string | null } | undefined
        : undefined;
      const queuePosition = count(
        this.#database.prepare(
          "SELECT COALESCE(MAX(queue_position), 0) AS count FROM tasks WHERE workspace_id = ?",
        ),
        workspaceId,
      ) + 1;
      this.#database
        .prepare(
          `UPDATE tasks SET state = 'queued', queue_position = ?, return_feedback = ?,
             preferred_worktree_path = COALESCE(?, preferred_worktree_path), updated_at = ?
           WHERE id = ? AND state = 'review'`,
        )
        .run(queuePosition, validatedFeedback, previous?.worktree_path ?? null, returnedAt, taskId);
      this.#appendTaskAudit(taskId, "task_returned", { feedback: validatedFeedback }, returnedAt);
    });
  }

  deleteDraft(taskId: string, workspaceId: string, deletedAt: number): void {
    validateTaskIds([taskId]);
    if (!workspaceId) throw new TypeError("workspaceId must not be empty");
    validateTimestamp(deletedAt, "deletedAt");
    this.#mutate("delete task draft", () => {
      this.#requireTaskState(taskId, workspaceId, "draft");
      this.#database.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
      this.#appendTaskAudit(taskId, "task_draft_deleted", {}, deletedAt);
    });
  }

  getDispatch(dispatchId: string): StoredDispatch | undefined {
    return this.#read("read dispatch", () => {
      const row = this.#database.prepare("SELECT * FROM dispatches WHERE id = ?").get(dispatchId) as
        | DispatchRow
        | undefined;
      return row ? mapDispatch(row) : undefined;
    });
  }

  listTargetOccupancy(): readonly TargetOccupancyRecord[] {
    return this.#read("list target occupancy", () =>
      (this.#database
        .prepare(
          `SELECT target_terminal_id, dispatch_id, acquired_at
           FROM target_occupancy ORDER BY target_terminal_id`,
        )
        .all() as unknown as OccupancyRow[]).map((row) => ({
        targetTerminalId: row.target_terminal_id,
        dispatchId: row.dispatch_id,
        acquiredAt: row.acquired_at,
      })),
    );
  }

  listWriteLeases(): readonly WriteLeaseRecord[] {
    return this.#read("list write leases", () =>
      (this.#database
        .prepare(
          `SELECT worktree_path, dispatch_id, target_terminal_id, acquired_at
           FROM worktree_write_leases ORDER BY worktree_path`,
        )
        .all() as unknown as WriteLeaseRow[]).map((row) => ({
        worktreePath: row.worktree_path,
        dispatchId: row.dispatch_id,
        targetTerminalId: row.target_terminal_id,
        acquiredAt: row.acquired_at,
      })),
    );
  }

  updateTargetRoute(
    dispatchId: string,
    paneId: string,
    updatedAt: number,
  ): "changed" | "unchanged" {
    if (!paneId) throw new TypeError("paneId must not be empty");
    validateTimestamp(updatedAt, "updatedAt");
    return this.#mutate("update target route", () => {
      this.#assertUnsettled(dispatchId);
      const current = this.#database
        .prepare("SELECT target_pane_id FROM dispatches WHERE id = ?")
        .get(dispatchId) as { target_pane_id: string };
      if (current.target_pane_id === paneId) return "unchanged";
      this.#database
        .prepare("UPDATE dispatches SET target_pane_id = ?, updated_at = ? WHERE id = ?")
        .run(paneId, updatedAt, dispatchId);
      this.#appendAudit(
        dispatchId,
        "target-route-updated",
        { previousPaneId: current.target_pane_id, paneId },
        updatedAt,
      );
      return "changed";
    });
  }

  recordAudit(dispatchId: string, eventType: string, data: unknown, createdAt: number): void {
    if (!/^[a-z0-9-]{1,80}$/u.test(eventType)) throw new TypeError("invalid audit event type");
    validateTimestamp(createdAt, "createdAt");
    const dataJson = serializeJson(data, "audit data");
    this.#mutate("record audit event", () => {
      this.#dispatchLifecycle(dispatchId);
      this.#database
        .prepare(
          "INSERT INTO audit_events(dispatch_id, event_type, data_json, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(dispatchId, eventType, dataJson, createdAt);
    });
  }

  markActive(dispatchId: string, activeAt: number): "changed" | "unchanged" {
    validateTimestamp(activeAt, "activeAt");
    return this.#mutate("mark dispatch active", () => {
      const result = this.#database
        .prepare(
          `UPDATE dispatches
           SET lifecycle = 'active', active_at = ?, updated_at = ?
           WHERE id = ? AND lifecycle = 'delivering'`,
        )
        .run(activeAt, activeAt, dispatchId);
      if (changes(result.changes) === 1) {
        this.#appendAudit(dispatchId, "dispatch-active", {}, activeAt);
        return "changed";
      }

      const lifecycle = this.#dispatchLifecycle(dispatchId);
      if (lifecycle === "active") return "unchanged";
      throw new RegistryStateError(`Dispatch ${dispatchId} cannot become active from ${lifecycle}`);
    });
  }

  addAttention(
    dispatchId: string,
    condition: AttentionCondition,
    details: unknown,
    addedAt: number,
  ): "added" | "unchanged" {
    validateTimestamp(addedAt, "addedAt");
    const detailsJson = serializeJson(details, "attention details");
    return this.#mutate("add dispatch attention", () => {
      this.#assertUnsettled(dispatchId);
      const result = this.#database
        .prepare(
          `INSERT OR IGNORE INTO dispatch_attention(
            dispatch_id, condition, details_json, added_at
          ) VALUES (?, ?, ?, ?)`,
        )
        .run(dispatchId, condition, detailsJson, addedAt);
      if (changes(result.changes) === 0) return "unchanged";
      this.#appendAudit(dispatchId, "attention-added", { condition, details }, addedAt);
      return "added";
    });
  }

  clearAttention(
    dispatchId: string,
    condition: AttentionCondition,
    clearedAt: number,
  ): "cleared" | "unchanged" {
    validateTimestamp(clearedAt, "clearedAt");
    return this.#mutate("clear dispatch attention", () => {
      this.#assertUnsettled(dispatchId);
      const result = this.#database
        .prepare("DELETE FROM dispatch_attention WHERE dispatch_id = ? AND condition = ?")
        .run(dispatchId, condition);
      if (changes(result.changes) === 0) return "unchanged";
      this.#appendAudit(dispatchId, "attention-cleared", { condition }, clearedAt);
      return "cleared";
    });
  }

  listAttention(dispatchId: string): readonly AttentionRecord[] {
    return this.#read("list dispatch attention", () =>
      (this.#database
        .prepare(
          `SELECT condition, details_json, added_at
           FROM dispatch_attention WHERE dispatch_id = ? ORDER BY added_at, condition`,
        )
        .all(dispatchId) as unknown as AttentionRow[]).map((row) => ({
        condition: row.condition,
        details: parseJson(row.details_json, "attention details"),
        addedAt: row.added_at,
      })),
    );
  }

  listAuditEvents(dispatchId?: string): readonly AuditEventRecord[] {
    return this.#read("list audit events", () => {
      const rows = (dispatchId
        ? this.#database
            .prepare(
              `SELECT id, dispatch_id, event_type, data_json, created_at
               FROM audit_events WHERE dispatch_id = ? ORDER BY id`,
            )
            .all(dispatchId)
        : this.#database
            .prepare(
              "SELECT id, dispatch_id, event_type, data_json, created_at FROM audit_events ORDER BY id",
            )
            .all()) as unknown as AuditRow[];
      return rows.map((row) => ({
        id: row.id,
        ...(row.dispatch_id ? { dispatchId: row.dispatch_id } : {}),
        eventType: row.event_type,
        data: parseJson(row.data_json, "audit data"),
        createdAt: row.created_at,
      }));
    });
  }

  settle(
    input: SettleDispatchInput,
  ): { status: "settled" | "already-settled"; outcome: FinalOutcome } {
    validateTimestamp(input.settledAt, "settledAt");
    const sanitizedJson = serializeJson(input.sanitizedResult, "sanitized result");

    return this.#mutate("settle dispatch", () => {
      const dispatch = this.#database
        .prepare("SELECT lifecycle, final_outcome FROM dispatches WHERE id = ?")
        .get(input.dispatchId) as
        | { lifecycle: DispatchLifecycle; final_outcome: FinalOutcome | null }
        | undefined;
      if (!dispatch) throw new RegistryStateError(`Dispatch ${input.dispatchId} does not exist`);

      if (dispatch.lifecycle === "settled") {
        this.#appendAudit(
          input.dispatchId,
          "settlement-duplicate",
          {
            attemptedOutcome: input.outcome,
            existingOutcome: dispatch.final_outcome,
            kind: input.kind,
          },
          input.settledAt,
        );
        return { status: "already-settled", outcome: dispatch.final_outcome! };
      }

      this.#database
        .prepare(
          `INSERT INTO dispatch_results(
            dispatch_id, outcome, source_terminal_id, raw_envelope, sanitized_json, accepted_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.dispatchId,
          input.outcome,
          input.sourceTerminalId ?? null,
          input.rawEnvelope ?? null,
          sanitizedJson,
          input.settledAt,
        );

      const updated = this.#database
        .prepare(
          `UPDATE dispatches
           SET lifecycle = 'settled', final_outcome = ?, settled_at = ?, updated_at = ?
           WHERE id = ? AND lifecycle IN ('delivering', 'active')`,
        )
        .run(input.outcome, input.settledAt, input.settledAt, input.dispatchId);
      if (changes(updated.changes) !== 1) {
        throw new Error(`Dispatch ${input.dispatchId} settlement compare-and-set failed`);
      }

      this.#database.prepare("DELETE FROM dispatch_attention WHERE dispatch_id = ?").run(input.dispatchId);
      this.#database.prepare("DELETE FROM target_occupancy WHERE dispatch_id = ?").run(input.dispatchId);
      this.#database
        .prepare("DELETE FROM worktree_write_leases WHERE dispatch_id = ?")
        .run(input.dispatchId);
      const task = this.#database
        .prepare(
          `SELECT id, state FROM tasks
           WHERE bound_dispatch_id = ? AND state = 'dispatched'`,
        )
        .get(input.dispatchId) as { id: string; state: "dispatched" } | undefined;
      if (task) {
        assertTaskTransition(task.state, "review");
        this.#database
          .prepare(
            `UPDATE tasks SET state = 'review', reviewed_at = ?, updated_at = ?
             WHERE id = ? AND state = 'dispatched'`,
          )
          .run(input.settledAt, input.settledAt, task.id);
        this.#appendTaskAudit(
          task.id,
          "task_review",
          { dispatchId: input.dispatchId, outcome: input.outcome, kind: input.kind },
          input.settledAt,
        );
      }
      this.#appendAudit(
        input.dispatchId,
        "dispatch-settled",
        {
          outcome: input.outcome,
          kind: input.kind,
          ...(input.resolverSessionId === undefined
            ? {}
            : { resolverSessionId: input.resolverSessionId }),
        },
        input.settledAt,
      );
      return { status: "settled", outcome: input.outcome };
    });
  }

  getResult(dispatchId: string): DispatchResultRecord | undefined {
    return this.#read("read dispatch result", () => {
      const row = this.#database
        .prepare("SELECT * FROM dispatch_results WHERE dispatch_id = ?")
        .get(dispatchId) as ResultRow | undefined;
      return row ? mapResult(row) : undefined;
    });
  }

  claimContextDelivery(
    input: ClaimContextDeliveryInput,
  ): "claimed" | "already-claimed" | "reassigned" | "delivered" {
    validateTimestamp(input.claimedAt, "claimedAt");
    return this.#mutate("claim context delivery", () => {
      const dispatch = this.#database
        .prepare("SELECT lifecycle, origin_session_id FROM dispatches WHERE id = ?")
        .get(input.dispatchId) as
        | { lifecycle: DispatchLifecycle; origin_session_id: string }
        | undefined;
      if (!dispatch) throw new RegistryStateError(`Dispatch ${input.dispatchId} does not exist`);
      if (dispatch.origin_session_id !== input.originSessionId) {
        throw new RegistryStateError(`Session ${input.originSessionId} is not the Origin Session`);
      }
      if (dispatch.lifecycle !== "settled") {
        throw new RegistryStateError(`Dispatch ${input.dispatchId} is not settled`);
      }

      const existing = this.#contextDeliveryRow(input.dispatchId);
      if (!existing) {
        this.#database
          .prepare(
            `INSERT INTO context_delivery_claims(
              dispatch_id, origin_session_id, branch_leaf_id, claimed_at
            ) VALUES (?, ?, ?, ?)`,
          )
          .run(input.dispatchId, input.originSessionId, input.branchLeafId, input.claimedAt);
        this.#appendAudit(
          input.dispatchId,
          "context-delivery-claimed",
          { branchLeafId: input.branchLeafId },
          input.claimedAt,
        );
        return "claimed";
      }
      if (existing.delivered_at !== null) return "delivered";
      if (existing.branch_leaf_id === input.branchLeafId) return "already-claimed";

      this.#database
        .prepare(
          `UPDATE context_delivery_claims
           SET branch_leaf_id = ?, claimed_at = ?
           WHERE dispatch_id = ? AND delivered_at IS NULL`,
        )
        .run(input.branchLeafId, input.claimedAt, input.dispatchId);
      this.#appendAudit(
        input.dispatchId,
        "context-delivery-reassigned",
        { previousBranchLeafId: existing.branch_leaf_id, branchLeafId: input.branchLeafId },
        input.claimedAt,
      );
      return "reassigned";
    });
  }

  completeContextDelivery(
    input: CompleteContextDeliveryInput,
  ): "completed" | "unchanged" {
    validateTimestamp(input.completedAt, "completedAt");
    return this.#mutate("complete context delivery", () => {
      const existing = this.#contextDeliveryRow(input.dispatchId);
      if (!existing) throw new RegistryStateError(`Dispatch ${input.dispatchId} has no context claim`);
      if (existing.origin_session_id !== input.originSessionId) {
        throw new RegistryStateError(`Session ${input.originSessionId} does not own the context claim`);
      }
      if (existing.delivered_at !== null) {
        if (
          existing.branch_leaf_id === input.branchLeafId &&
          existing.delivered_entry_id === input.entryId
        ) {
          return "unchanged";
        }
        throw new RegistryStateError(`Dispatch ${input.dispatchId} context is already delivered`);
      }
      if (existing.branch_leaf_id !== input.branchLeafId) {
        throw new RegistryStateError("Active branch changed before context delivery completed");
      }

      this.#database
        .prepare(
          `UPDATE context_delivery_claims
           SET delivered_entry_id = ?, delivered_at = ?
           WHERE dispatch_id = ? AND delivered_at IS NULL`,
        )
        .run(input.entryId, input.completedAt, input.dispatchId);
      this.#appendAudit(
        input.dispatchId,
        "context-delivery-completed",
        { branchLeafId: input.branchLeafId, entryId: input.entryId },
        input.completedAt,
      );
      return "completed";
    });
  }

  getContextDelivery(dispatchId: string): ContextDeliveryRecord | undefined {
    return this.#read("read context delivery", () => {
      const row = this.#contextDeliveryRow(dispatchId);
      return row ? mapContextDelivery(row) : undefined;
    });
  }

  listPendingContextDelivery(originSessionId: string): readonly StoredDispatch[] {
    if (!originSessionId) throw new TypeError("originSessionId must not be empty");
    return this.#read("list pending context delivery", () =>
      (this.#database
        .prepare(
          `SELECT d.* FROM dispatches d
           LEFT JOIN context_delivery_claims c ON c.dispatch_id = d.id
           WHERE d.lifecycle = 'settled'
             AND d.origin_session_id = ?
             AND (c.dispatch_id IS NULL OR c.delivered_at IS NULL)
           ORDER BY d.settled_at, d.id`,
        )
        .all(originSessionId) as unknown as DispatchRow[]).map(mapDispatch),
    );
  }

  listUnsettled(originSessionId?: string): readonly StoredDispatch[] {
    return this.#read("list unsettled dispatches", () => {
      const rows = (originSessionId
        ? this.#database
            .prepare(
              `SELECT * FROM dispatches
               WHERE lifecycle != 'settled' AND origin_session_id = ? ORDER BY created_at, id`,
            )
            .all(originSessionId)
        : this.#database
            .prepare(
              "SELECT * FROM dispatches WHERE lifecycle != 'settled' ORDER BY created_at, id",
            )
            .all()) as unknown as DispatchRow[];
      return rows.map(mapDispatch);
    });
  }

  /**
   * Hold the Registry write lock while one synchronous Git cleanup runs.
   * A concurrent delivery intent must finish before the check or wait until
   * cleanup completes, so the checked worktree cannot become held mid-remove.
   */
  withWorktreeCleanupGuard<T>(worktreePath: string, cleanup: () => T): T {
    this.#assertOpen();
    if (this.#mutationsDisabledReason) {
      throw new RegistryUnavailableError(
        `Dispatch Registry mutations are disabled: ${this.#mutationsDisabledReason}`,
      );
    }
    const canonicalPath = resolve(worktreePath);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const held = this.#database
        .prepare(
          `SELECT id FROM dispatches
           WHERE lifecycle != 'settled' AND worktree_path = ?
           ORDER BY created_at, id LIMIT 1`,
        )
        .get(canonicalPath) as { id: string } | undefined;
      if (held) {
        throw new RegistryConflictError(
          "worktree-held",
          `Worktree ${canonicalPath} is held by unsettled dispatch ${held.id}`,
          held.id,
        );
      }
      const result = cleanup();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      rollback(this.#database);
      if (error instanceof RegistryConflictError || error instanceof RegistryStateError) throw error;
      if (isSqliteBusy(error)) {
        throw new RegistryUnavailableError(
          "Dispatch Registry worktree cleanup could not acquire its transaction before busy_timeout",
          error,
        );
      }
      throw error;
    }
  }

  listUnsettledInWorkspace(targetWorkspaceId: string): readonly StoredDispatch[] {
    if (!targetWorkspaceId) throw new TypeError("targetWorkspaceId must not be empty");
    return this.#read("list unsettled dispatches in workspace", () =>
      (this.#database
        .prepare(
          `SELECT * FROM dispatches
           WHERE lifecycle != 'settled' AND target_workspace_id = ?
           ORDER BY created_at, id`,
        )
        .all(targetWorkspaceId) as unknown as DispatchRow[]).map(mapDispatch),
    );
  }

  listByIdPrefix(targetWorkspaceId: string, prefix: string): readonly StoredDispatch[] {
    if (!targetWorkspaceId) throw new TypeError("targetWorkspaceId must not be empty");
    if (!/^hd_[A-Za-z0-9_-]+$/u.test(prefix)) throw new TypeError("invalid dispatch ID prefix");
    return this.#read("list dispatches by ID prefix", () =>
      (this.#database
        .prepare(
          `SELECT * FROM dispatches
           WHERE target_workspace_id = ? AND substr(id, 1, length(?)) = ?
           ORDER BY created_at, id`,
        )
        .all(targetWorkspaceId, prefix, prefix) as unknown as DispatchRow[]).map(mapDispatch),
    );
  }

  /** Settled dispatches whose result the user has not opened yet, newest first. */
  listUnseenSettled(targetWorkspaceId: string): readonly StoredDispatch[] {
    if (!targetWorkspaceId) throw new TypeError("targetWorkspaceId must not be empty");
    return this.#read("list unseen settled dispatches", () => {
      const rows = this.#database
        .prepare(
          `SELECT * FROM dispatches
           WHERE lifecycle = 'settled' AND result_seen_at IS NULL AND target_workspace_id = ?
           ORDER BY settled_at DESC, id DESC`,
        )
        .all(targetWorkspaceId) as unknown as DispatchRow[];
      return rows.map(mapDispatch);
    });
  }

  /** Marks a settled dispatch's result as seen; presentation metadata only. */
  markResultSeen(dispatchId: string, seenAt: number): void {
    validateTimestamp(seenAt, "seenAt");
    this.#mutate("mark dispatch result seen", () => {
      this.#database
        .prepare(
          `UPDATE dispatches SET result_seen_at = ?, updated_at = ?
           WHERE id = ? AND lifecycle = 'settled' AND result_seen_at IS NULL`,
        )
        .run(seenAt, seenAt, dispatchId);
    });
  }

  /** Marks the displayed Unseen Settlements in one Workspace Scope as seen, atomically. */
  markWorkspaceResultsSeen(
    targetWorkspaceId: string,
    dispatchIds: readonly string[],
    seenAt: number,
  ): number {
    if (!targetWorkspaceId) throw new TypeError("targetWorkspaceId must not be empty");
    if (dispatchIds.some((id) => !/^hd_[A-Za-z0-9_-]+$/u.test(id))) {
      throw new TypeError("invalid dispatch ID");
    }
    validateTimestamp(seenAt, "seenAt");
    const uniqueIds = [...new Set(dispatchIds)];
    if (uniqueIds.length === 0) return 0;
    return this.#mutate("mark workspace dispatch results seen", () => {
      const update = this.#database.prepare(
        `UPDATE dispatches SET result_seen_at = ?, updated_at = ?
         WHERE target_workspace_id = ? AND id = ?
           AND lifecycle = 'settled' AND result_seen_at IS NULL`,
      );
      let marked = 0;
      for (const dispatchId of uniqueIds) {
        marked += changes(update.run(seenAt, seenAt, targetWorkspaceId, dispatchId).changes);
      }
      return marked;
    });
  }

  listRecentSettled(originSessionId: string, limit: number): readonly StoredDispatch[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("recent settled limit must be from 1 to 100");
    }
    return this.#read("list recent settled dispatches", () => {
      const rows = this.#database
        .prepare(
          `SELECT * FROM dispatches
           WHERE lifecycle = 'settled' AND origin_session_id = ?
           ORDER BY settled_at DESC, id DESC LIMIT ?`,
        )
        .all(originSessionId, limit) as unknown as DispatchRow[];
      return rows.map(mapDispatch);
    });
  }

  listRecentSettledInWorkspace(
    targetWorkspaceId: string,
    limit: number,
  ): readonly StoredDispatch[] {
    if (!targetWorkspaceId) throw new TypeError("targetWorkspaceId must not be empty");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("recent settled limit must be from 1 to 100");
    }
    return this.#read("list recent settled dispatches in workspace", () => {
      const rows = this.#database
        .prepare(
          `SELECT * FROM dispatches
           WHERE lifecycle = 'settled' AND target_workspace_id = ?
           ORDER BY settled_at DESC, id DESC LIMIT ?`,
        )
        .all(targetWorkspaceId, limit) as unknown as DispatchRow[];
      return rows.map(mapDispatch);
    });
  }

  /** Arms Auto Run for one exact Origin Session; re-arming resets the Board Run Quota. */
  armAutoRun(originSessionId: string, quota: number, armedAt: number): void {
    if (!originSessionId) throw new TypeError("originSessionId must not be empty");
    validateRunQuota(quota);
    validateTimestamp(armedAt, "armedAt");
    this.#mutate("arm auto run", () => {
      this.#database
        .prepare(
          `INSERT INTO auto_run_sessions(origin_session_id, armed_at, run_quota, run_quota_used)
           VALUES (?, ?, ?, 0)
           ON CONFLICT(origin_session_id) DO UPDATE SET
             armed_at = excluded.armed_at,
             run_quota = excluded.run_quota,
             run_quota_used = 0`,
        )
        .run(originSessionId, armedAt, quota);
      this.#appendAudit(null, "auto-run-armed", { originSessionId, quota }, armedAt);
    });
  }

  /** Disarms Auto Run: later settlements stop triggering turns; an already-enqueued wake may still fire once. */
  disarmAutoRun(originSessionId: string, disarmedAt: number): void {
    if (!originSessionId) throw new TypeError("originSessionId must not be empty");
    validateTimestamp(disarmedAt, "disarmedAt");
    this.#mutate("disarm auto run", () => {
      const deleted = this.#database
        .prepare("DELETE FROM auto_run_sessions WHERE origin_session_id = ?")
        .run(originSessionId);
      if (changes(deleted.changes) === 1) {
        this.#appendAudit(null, "auto-run-disarmed", { originSessionId }, disarmedAt);
      }
    });
  }

  isAutoRunArmed(originSessionId: string): boolean {
    return this.autoRunArmedAt(originSessionId) !== undefined;
  }

  /** When Auto Run was armed for this session, or undefined if disarmed. */
  autoRunArmedAt(originSessionId: string): number | undefined {
    if (!originSessionId) throw new TypeError("originSessionId must not be empty");
    return this.#read("read auto run state", () => {
      const row = this.#database
        .prepare("SELECT armed_at FROM auto_run_sessions WHERE origin_session_id = ?")
        .get(originSessionId) as { armed_at?: number } | undefined;
      return row?.armed_at;
    });
  }

  getRunQuotaState(originSessionId: string, defaultRunQuota: number): RunQuotaState {
    if (!originSessionId) throw new TypeError("originSessionId must not be empty");
    validateRunQuota(defaultRunQuota);
    return this.#read("read auto run quota state", () => {
      const row = this.#database
        .prepare(
          `SELECT run_quota, run_quota_used
           FROM auto_run_sessions WHERE origin_session_id = ?`,
        )
        .get(originSessionId) as
        | { run_quota: number | null; run_quota_used: number }
        | undefined;
      if (!row) {
        return {
          armed: false,
          legacyDefaulted: false,
        };
      }
      const quota = row.run_quota ?? defaultRunQuota;
      return {
        armed: true,
        quota,
        used: row.run_quota_used,
        remaining: Math.max(0, quota - row.run_quota_used),
        legacyDefaulted: row.run_quota === null,
      };
    });
  }

  purgeSettledBefore(cutoff: number, purgedAt: number): number {
    validateTimestamp(cutoff, "retention cutoff");
    validateTimestamp(purgedAt, "purgedAt");
    return this.#mutate("purge settled dispatches", () => {
      const purgedTasks = changes(
        this.#database
          .prepare(
            `DELETE FROM tasks
             WHERE state = 'accepted' AND accepted_at IS NOT NULL AND accepted_at < ?`,
          )
          .run(cutoff).changes,
      );
      const result = this.#database
        .prepare(
          `DELETE FROM dispatches
           WHERE lifecycle = 'settled' AND settled_at IS NOT NULL AND settled_at < ?
             AND NOT EXISTS (SELECT 1 FROM tasks WHERE bound_dispatch_id = dispatches.id)`,
        )
        .run(cutoff);
      const purged = changes(result.changes);
      if (purged > 0 || purgedTasks > 0) {
        this.#appendAudit(null, "retention-purge", { cutoff, purged, purgedTasks }, purgedAt);
      }
      return purged;
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #taskForBinding(taskId: string, intent: ConfirmDeliveryIntent): TaskRow {
    const task = this.#database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | TaskRow
      | undefined;
    if (!task) throw new RegistryStateError(`Task ${taskId} does not exist`);
    if (task.workspace_id !== intent.targetWorkspaceId) {
      throw new RegistryStateError(`Task ${taskId} belongs to a different workspace`);
    }
    if (task.state !== "queued") {
      throw new RegistryStateError(`Task ${taskId} is ${task.state}, not queued`);
    }
    if (task.mode !== intent.mode) {
      throw new RegistryStateError(`Task ${taskId} mode does not match the dispatch`);
    }
    const seededTask = seedReturnedTask(task.task, task.return_feedback);
    if (seededTask !== intent.task) {
      throw new RegistryStateError(`Task ${taskId} text does not match its approved Board Task`);
    }
    return task;
  }

  #consumeRunQuota(intent: ConfirmDeliveryIntent): number | undefined {
    const row = this.#database
      .prepare(
        `SELECT run_quota, run_quota_used FROM auto_run_sessions
         WHERE origin_session_id = ?`,
      )
      .get(intent.originSessionId) as
      | { run_quota: number | null; run_quota_used: number }
      | undefined;
    if (!row) return undefined;
    const defaultRunQuota = intent.defaultRunQuota;
    if (defaultRunQuota === undefined) {
      throw new RegistryStateError("task-bound dispatch requires defaultRunQuota");
    }
    validateRunQuota(defaultRunQuota);
    const quota = row.run_quota ?? defaultRunQuota;
    if (row.run_quota_used >= quota) {
      throw new RegistryStateError("Task Board Run Quota exhausted");
    }
    this.#database
      .prepare(
        `UPDATE auto_run_sessions SET run_quota_used = run_quota_used + 1
         WHERE origin_session_id = ?`,
      )
      .run(intent.originSessionId);
    return quota - row.run_quota_used - 1;
  }

  #taskById(taskId: string): StoredTask | undefined {
    const row = this.#database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | TaskRow
      | undefined;
    return row ? mapTask(row) : undefined;
  }

  #requireTaskState(
    taskId: string,
    workspaceId: string,
    state: TaskRow["state"],
  ): TaskRow {
    const task = this.#database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | TaskRow
      | undefined;
    if (!task) throw new RegistryStateError(`Task ${taskId} does not exist`);
    if (task.workspace_id !== workspaceId) {
      throw new RegistryStateError(`Task ${taskId} belongs to a different workspace`);
    }
    if (task.state !== state) {
      throw new RegistryStateError(`Task ${taskId} is ${task.state}, not ${state}`);
    }
    return task;
  }

  #appendTaskAudit(taskId: string, eventType: string, data: unknown, createdAt: number): void {
    this.#appendAudit(null, eventType, { taskId, ...asRecord(data) }, createdAt);
  }

  #assertConcurrency(intent: ConfirmDeliveryIntent): void {
    if (intent.maxActiveGlobal !== undefined) {
      const active = count(
        this.#database.prepare(
          "SELECT COUNT(*) AS count FROM dispatches WHERE lifecycle IN ('delivering', 'active')",
        ),
      );
      if (active >= intent.maxActiveGlobal) {
        throw new RegistryConflictError("global-limit", "Global active dispatch limit reached");
      }
    }

    if (intent.maxActivePerTargetWorkspace !== undefined) {
      const active = count(
        this.#database.prepare(
          `SELECT COUNT(*) AS count FROM dispatches
           WHERE target_workspace_id = ? AND lifecycle IN ('delivering', 'active')`,
        ),
        intent.targetWorkspaceId,
      );
      if (active >= intent.maxActivePerTargetWorkspace) {
        throw new RegistryConflictError(
          "workspace-limit",
          `Active dispatch limit reached for workspace ${intent.targetWorkspaceId}`,
        );
      }
    }
  }

  #contextDeliveryRow(dispatchId: string): ContextClaimRow | undefined {
    return this.#database
      .prepare("SELECT * FROM context_delivery_claims WHERE dispatch_id = ?")
      .get(dispatchId) as ContextClaimRow | undefined;
  }

  #dispatchLifecycle(dispatchId: string): DispatchLifecycle {
    const row = this.#database
      .prepare("SELECT lifecycle FROM dispatches WHERE id = ?")
      .get(dispatchId) as { lifecycle: DispatchLifecycle } | undefined;
    if (!row) throw new RegistryStateError(`Dispatch ${dispatchId} does not exist`);
    return row.lifecycle;
  }

  #assertUnsettled(dispatchId: string): void {
    const lifecycle = this.#dispatchLifecycle(dispatchId);
    if (lifecycle === "settled") throw new RegistryStateError(`Dispatch ${dispatchId} is settled`);
  }

  #appendAudit(
    dispatchId: string | null,
    eventType: string,
    data: unknown,
    createdAt: number,
  ): void {
    this.#database
      .prepare(
        "INSERT INTO audit_events(dispatch_id, event_type, data_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(dispatchId, eventType, JSON.stringify(data), createdAt);
  }

  #mutate<T>(operation: string, action: () => T): T {
    this.#assertOpen();
    if (this.#mutationsDisabledReason) {
      throw new RegistryUnavailableError(
        `Dispatch Registry mutations are disabled: ${this.#mutationsDisabledReason}`,
      );
    }

    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const result = action();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      rollback(this.#database);
      if (error instanceof RegistryConflictError || error instanceof RegistryStateError) throw error;
      if (isSqliteBusy(error)) {
        throw new RegistryUnavailableError(
          `Dispatch Registry ${operation} could not acquire its transaction before busy_timeout`,
          error,
        );
      }
      this.#mutationsDisabledReason = `${operation} failed`;
      throw new RegistryUnavailableError(`Dispatch Registry ${operation} failed`, error);
    }
  }

  #read<T>(operation: string, action: () => T): T {
    this.#assertOpen();
    try {
      return action();
    } catch (error) {
      if (error instanceof RegistryConflictError || error instanceof RegistryStateError) throw error;
      throw new RegistryUnavailableError(`Dispatch Registry could not ${operation}`, error);
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new RegistryUnavailableError("Dispatch Registry is closed");
  }
}

export async function openDispatchRegistry(
  databasePath: string,
  options: OpenRegistryOptions = {},
): Promise<DispatchRegistry> {
  const path = resolve(databasePath);
  const directory = dirname(path);
  const busyTimeoutMs = normalizeBusyTimeout(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
  const existedBefore = existsSync(path) && statSync(path).size > 0;

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      timeout: busyTimeoutMs,
    });
    chmodSync(path, 0o600);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    await retrySqliteBusy(() => database!.exec("PRAGMA journal_mode = WAL"), busyTimeoutMs);
    assertIntegrity(database);
    await migrateRegistry(database, {
      databasePath: path,
      existingDatabase: existedBefore,
      now: options.now ?? (() => new Date()),
    });
    assertIntegrity(database);
    return new DispatchRegistry(path, database);
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the opening/migration error.
    }
    throw new RegistryUnavailableError(`Dispatch Registry unavailable at ${path}`, error);
  }
}

interface DispatchRow {
  id: string;
  origin_session_id: string;
  origin_session_file: string | null;
  origin_workspace_id: string;
  target_workspace_id: string;
  target_terminal_id: string;
  target_pane_id: string;
  target_agent_label: string;
  target_cwd: string;
  worktree_path: string | null;
  mode: DispatchMode;
  lifecycle: DispatchLifecycle;
  final_outcome: FinalOutcome | null;
  task: string;
  constraints_json: string;
  payload: string;
  payload_hash: string;
  deadline_at: number;
  created_at: number;
  confirmed_at: number;
  delivery_started_at: number;
  active_at: number | null;
  settled_at: number | null;
  result_seen_at: number | null;
  auto_run_depth: number;
  wake_on_settle: number;
  updated_at: number;
}

interface TaskRow {
  id: string;
  workspace_id: string;
  title: string;
  task: string;
  mode: DispatchMode;
  preferred_worktree_path: string | null;
  state: "draft" | "queued" | "dispatched" | "review" | "accepted";
  queue_position: number | null;
  bound_dispatch_id: string | null;
  return_feedback: string | null;
  created_by: "model" | "user";
  created_at: number;
  approved_at: number | null;
  reviewed_at: number | null;
  accepted_at: number | null;
  updated_at: number;
}

interface OccupancyRow {
  target_terminal_id: string;
  dispatch_id: string;
  acquired_at: number;
}

interface WriteLeaseRow {
  worktree_path: string;
  dispatch_id: string;
  target_terminal_id: string;
  acquired_at: number;
}

interface AttentionRow {
  condition: AttentionCondition;
  details_json: string;
  added_at: number;
}

interface AuditRow {
  id: number;
  dispatch_id: string | null;
  event_type: string;
  data_json: string;
  created_at: number;
}

interface ResultRow {
  dispatch_id: string;
  outcome: FinalOutcome;
  source_terminal_id: string | null;
  raw_envelope: string | null;
  sanitized_json: string;
  accepted_at: number;
}

interface ContextClaimRow {
  dispatch_id: string;
  origin_session_id: string;
  branch_leaf_id: string;
  claimed_at: number;
  delivered_entry_id: string | null;
  delivered_at: number | null;
}

function mapResult(row: ResultRow): DispatchResultRecord {
  return {
    dispatchId: row.dispatch_id,
    outcome: row.outcome,
    ...(row.source_terminal_id ? { sourceTerminalId: row.source_terminal_id } : {}),
    ...(row.raw_envelope ? { rawEnvelope: row.raw_envelope } : {}),
    sanitizedResult: parseJson(row.sanitized_json, "sanitized result"),
    acceptedAt: row.accepted_at,
  };
}

function mapTask(row: TaskRow): StoredTask {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    task: row.task,
    mode: row.mode,
    ...(row.preferred_worktree_path === null
      ? {}
      : { preferredWorktreePath: row.preferred_worktree_path }),
    state: row.state,
    ...(row.queue_position === null ? {} : { queuePosition: row.queue_position }),
    ...(row.bound_dispatch_id === null ? {} : { boundDispatchId: row.bound_dispatch_id }),
    ...(row.return_feedback === null ? {} : { returnFeedback: row.return_feedback }),
    createdBy: row.created_by,
    createdAt: row.created_at,
    ...(row.approved_at === null ? {} : { approvedAt: row.approved_at }),
    ...(row.reviewed_at === null ? {} : { reviewedAt: row.reviewed_at }),
    ...(row.accepted_at === null ? {} : { acceptedAt: row.accepted_at }),
    updatedAt: row.updated_at,
  };
}

function mapContextDelivery(row: ContextClaimRow): ContextDeliveryRecord {
  return {
    dispatchId: row.dispatch_id,
    originSessionId: row.origin_session_id,
    branchLeafId: row.branch_leaf_id,
    claimedAt: row.claimed_at,
    ...(row.delivered_entry_id ? { deliveredEntryId: row.delivered_entry_id } : {}),
    ...(row.delivered_at !== null ? { deliveredAt: row.delivered_at } : {}),
  };
}

function mapDispatch(row: DispatchRow): StoredDispatch {
  const constraints = JSON.parse(row.constraints_json) as unknown;
  if (!Array.isArray(constraints) || !constraints.every((item) => typeof item === "string")) {
    throw new Error(`Dispatch ${row.id} has invalid constraints`);
  }

  return {
    id: row.id,
    originSessionId: row.origin_session_id,
    ...(row.origin_session_file ? { originSessionFile: row.origin_session_file } : {}),
    originWorkspaceId: row.origin_workspace_id,
    targetWorkspaceId: row.target_workspace_id,
    targetTerminalId: row.target_terminal_id,
    targetPaneId: row.target_pane_id,
    targetAgentLabel: row.target_agent_label,
    targetCwd: row.target_cwd,
    ...(row.worktree_path ? { worktreePath: row.worktree_path } : {}),
    mode: row.mode,
    lifecycle: row.lifecycle,
    ...(row.final_outcome ? { finalOutcome: row.final_outcome } : {}),
    task: row.task,
    constraints,
    payload: row.payload,
    payloadHash: row.payload_hash,
    deadlineAt: row.deadline_at,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
    deliveryStartedAt: row.delivery_started_at,
    ...(row.active_at !== null ? { activeAt: row.active_at } : {}),
    ...(row.settled_at !== null ? { settledAt: row.settled_at } : {}),
    ...(row.result_seen_at !== null && row.result_seen_at !== undefined
      ? { resultSeenAt: row.result_seen_at }
      : {}),
    autoRunDepth: row.auto_run_depth,
    wakeOnSettle: row.wake_on_settle !== 0,
    updatedAt: row.updated_at,
  };
}

function validateIntent(intent: ConfirmDeliveryIntent): void {
  for (const [name, value] of Object.entries({
    id: intent.id,
    originSessionId: intent.originSessionId,
    originWorkspaceId: intent.originWorkspaceId,
    targetWorkspaceId: intent.targetWorkspaceId,
    targetTerminalId: intent.targetTerminalId,
    targetPaneId: intent.targetPaneId,
    targetAgentLabel: intent.targetAgentLabel,
    targetCwd: intent.targetCwd,
    task: intent.task,
    payload: intent.payload,
    payloadHash: intent.payloadHash,
  })) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new RegistryStateError(`${name} is required`);
    }
  }
  if (!Array.isArray(intent.constraints) || !intent.constraints.every((item) => typeof item === "string")) {
    throw new RegistryStateError("dispatch constraints must be an array of strings");
  }
  if (intent.mode === "write" && !intent.worktreePath) {
    throw new RegistryStateError("write dispatch requires a canonical worktree path");
  }
  if (!Number.isSafeInteger(intent.confirmedAt) || !Number.isSafeInteger(intent.deadlineAt)) {
    throw new RegistryStateError("dispatch timestamps must be safe integers");
  }
  for (const [name, limit] of Object.entries({
    maxActiveGlobal: intent.maxActiveGlobal,
    maxActivePerTargetWorkspace: intent.maxActivePerTargetWorkspace,
  })) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new RegistryStateError(`${name} must be a positive integer`);
    }
  }
  if (
    intent.autoRunDepth !== undefined &&
    (!Number.isSafeInteger(intent.autoRunDepth) || intent.autoRunDepth < 0)
  ) {
    throw new RegistryStateError("autoRunDepth must be a non-negative integer");
  }
}

function validateTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) throw new RegistryStateError(`${name} must be a safe integer`);
}

function validateTaskIds(taskIds: readonly string[]): void {
  if (!Array.isArray(taskIds) || taskIds.some((id) => !/^hdt_[A-Za-z0-9_-]{1,100}$/u.test(id))) {
    throw new TypeError("invalid task ID");
  }
}

function validateRunQuota(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw new RangeError("run quota must be from 1 to 50");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}

function serializeJson(value: unknown, name: string): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("undefined is not JSON");
    return serialized;
  } catch (error) {
    throw new RegistryStateError(`${name} must be JSON-serializable: ${String(error)}`);
  }
}

function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`Registry ${name} is invalid: ${String(error)}`);
  }
}

function changes(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function count(statement: StatementSync, ...params: (string | number)[]): number {
  const row = statement.get(...params) as { count?: number } | undefined;
  if (!row || typeof row.count !== "number") throw new Error("Registry count query failed");
  return row.count;
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}

function assertIntegrity(database: DatabaseSync): void {
  const integrity = pragmaString(database, "integrity_check");
  if (integrity !== "ok") throw new Error(`Registry integrity check failed: ${integrity}`);
}

function pragmaNumber(database: DatabaseSync, pragma: string, resultKey = pragma): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  const value = row?.[resultKey];
  if (typeof value !== "number") throw new Error(`PRAGMA ${pragma} did not return a number`);
  return value;
}

function pragmaString(database: DatabaseSync, pragma: string): string {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  const value = row?.[pragma];
  if (typeof value !== "string") throw new Error(`PRAGMA ${pragma} did not return a string`);
  return value;
}

async function retrySqliteBusy(action: () => void, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      action();
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, timeoutMs))));
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  const errcode =
    typeof error === "object" && error !== null && "errcode" in error
      ? error.errcode
      : undefined;
  return (
    errcode === 5 ||
    errcode === 6 ||
    (error instanceof Error && /database is (?:busy|locked)/iu.test(error.message))
  );
}

function normalizeBusyTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 60_000) {
    throw new RegistryUnavailableError("Registry busy timeout must be an integer from 0 to 60000 ms");
  }
  return value;
}
