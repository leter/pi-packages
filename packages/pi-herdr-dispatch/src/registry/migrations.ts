import { chmodSync } from "node:fs";
import { backup, type DatabaseSync } from "node:sqlite";

import {
  REGISTRY_SCHEMA_V1,
  REGISTRY_SCHEMA_V2,
  REGISTRY_SCHEMA_V3,
  REGISTRY_SCHEMA_V4,
  REGISTRY_SCHEMA_V5,
  REGISTRY_SCHEMA_V6,
  REGISTRY_SCHEMA_V7,
  REGISTRY_SCHEMA_VERSION,
} from "./schema.js";

export interface MigrationOptions {
  databasePath: string;
  existingDatabase: boolean;
  now(): Date;
}

export interface MigrationResult {
  fromVersion: number;
  toVersion: number;
  backupPath?: string;
}

export async function migrateRegistry(
  database: DatabaseSync,
  options: MigrationOptions,
): Promise<MigrationResult> {
  const fromVersion = readSchemaVersion(database);
  if (fromVersion > REGISTRY_SCHEMA_VERSION) {
    throw new Error(
      `Registry schema ${fromVersion} is newer than supported schema ${REGISTRY_SCHEMA_VERSION}`,
    );
  }
  if (fromVersion === REGISTRY_SCHEMA_VERSION) {
    return { fromVersion, toVersion: fromVersion };
  }

  const backupPath = options.existingDatabase
    ? await createMigrationBackup(database, options.databasePath, options.now())
    : undefined;

  database.exec("BEGIN IMMEDIATE");
  try {
    const lockedVersion = readSchemaVersion(database);
    if (lockedVersion > REGISTRY_SCHEMA_VERSION) {
      throw new Error(
        `Registry schema ${lockedVersion} is newer than supported schema ${REGISTRY_SCHEMA_VERSION}`,
      );
    }
    if (lockedVersion < REGISTRY_SCHEMA_VERSION) {
      if (lockedVersion === 0) database.exec(REGISTRY_SCHEMA_V1);
      if (lockedVersion < 2) database.exec(REGISTRY_SCHEMA_V2);
      if (lockedVersion < 3) database.exec(REGISTRY_SCHEMA_V3);
      if (lockedVersion < 4) database.exec(REGISTRY_SCHEMA_V4);
      if (lockedVersion < 5) database.exec(REGISTRY_SCHEMA_V5);
      if (lockedVersion < 6) database.exec(REGISTRY_SCHEMA_V6);
      if (lockedVersion < 7) database.exec(REGISTRY_SCHEMA_V7);
      database.exec(`PRAGMA user_version = ${REGISTRY_SCHEMA_VERSION}`);
    }
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  }

  return { fromVersion, toVersion: REGISTRY_SCHEMA_VERSION, backupPath };
}

export function readSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  if (!row || typeof row.user_version !== "number") {
    throw new Error("Registry did not return a numeric schema version");
  }
  return row.user_version;
}

async function createMigrationBackup(
  database: DatabaseSync,
  databasePath: string,
  now: Date,
): Promise<string> {
  const timestamp = now.toISOString().replaceAll(":", "-");
  const backupPath = `${databasePath}.backup-${timestamp}`;
  await backup(database, backupPath);
  chmodSync(backupPath, 0o600);
  return backupPath;
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the original migration error. Closing the connection performs any remaining rollback.
  }
}
