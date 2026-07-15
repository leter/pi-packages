import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { migrateRegistry } from "./migrations.js";
import type {
  ConfirmDeliveryIntent,
  DispatchLifecycle,
  DispatchMode,
  FinalOutcome,
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
          constraintsJson: JSON.stringify(intent.constraints),
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
    database.exec("PRAGMA journal_mode = WAL");
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

function normalizeBusyTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 60_000) {
    throw new RegistryUnavailableError("Registry busy timeout must be an integer from 0 to 60000 ms");
  }
  return value;
}
