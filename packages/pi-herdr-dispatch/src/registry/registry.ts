import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { migrateRegistry } from "./migrations.js";
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

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
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
