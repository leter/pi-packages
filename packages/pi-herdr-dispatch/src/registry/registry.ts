import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { migrateRegistry } from "./migrations.js";
import type {
  AttentionCondition,
  AttentionRecord,
  AuditEventRecord,
  ClaimContextDeliveryInput,
  CompleteContextDeliveryInput,
  ConfirmDeliveryIntent,
  ContextDeliveryRecord,
  DispatchResultRecord,
  DispatchLifecycle,
  DispatchMode,
  FinalOutcome,
  SettleDispatchInput,
  StoredDispatch,
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
  readonly code: "dispatch-exists" | "target-occupied" | "worktree-leased" | "workspace-limit" | "global-limit";
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

  confirmDeliveryIntent(intent: ConfirmDeliveryIntent): void {
    validateIntent(intent);
    const constraintsJson = serializeJson(intent.constraints, "dispatch constraints");
    const worktreePath = intent.worktreePath ? resolve(intent.worktreePath) : undefined;

    this.#mutate("confirm delivery intent", () => {
      const existingDispatch = this.#database
        .prepare("SELECT id FROM dispatches WHERE id = ?")
        .get(intent.id) as { id: string } | undefined;
      if (existingDispatch) {
        throw new RegistryConflictError("dispatch-exists", `Dispatch ${intent.id} already exists`, intent.id);
      }

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
            delivery_started_at, updated_at
          ) VALUES (
            :id, :originSessionId, :originSessionFile, :originWorkspaceId,
            :targetWorkspaceId, :targetTerminalId, :targetPaneId, :targetAgentLabel,
            :targetCwd, :worktreePath, :mode, 'delivering', :task, :constraintsJson,
            :payload, :payloadHash, :deadlineAt, :createdAt, :confirmedAt,
            :deliveryStartedAt, :updatedAt
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
          updatedAt: intent.confirmedAt,
        });

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
      }, intent.confirmedAt);
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

  purgeSettledBefore(cutoff: number, purgedAt: number): number {
    validateTimestamp(cutoff, "retention cutoff");
    validateTimestamp(purgedAt, "purgedAt");
    return this.#mutate("purge settled dispatches", () => {
      const result = this.#database
        .prepare(
          `DELETE FROM dispatches
           WHERE lifecycle = 'settled' AND settled_at IS NOT NULL AND settled_at < ?`,
        )
        .run(cutoff);
      const purged = changes(result.changes);
      if (purged > 0) {
        this.#appendAudit(null, "retention-purge", { cutoff, purged }, purgedAt);
      }
      return purged;
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
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
}

function validateTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) throw new RegistryStateError(`${name} must be a safe integer`);
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
