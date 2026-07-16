import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";

import {
  openDispatchRegistry,
  RegistryUnavailableError,
  type DispatchRegistry,
} from "../../src/registry/registry.js";
import {
  REGISTRY_SCHEMA_V1,
  REGISTRY_SCHEMA_V2,
  REGISTRY_SCHEMA_VERSION,
} from "../../src/registry/schema.js";

const cleanupPaths: string[] = [];
const openRegistries: DispatchRegistry[] = [];

async function temporaryDatabasePath(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-dispatch-migration-"));
  cleanupPaths.push(directory);
  return { directory, path: join(directory, "registry.sqlite") };
}

function openRaw(path: string): DatabaseSync {
  return new DatabaseSync(path, { timeout: 100 });
}

afterEach(async () => {
  for (const registry of openRegistries.splice(0)) registry.close();
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Dispatch Registry migrations and fail-closed opening", () => {
  it("backs up an existing older database before migrating it", async () => {
    const location = await temporaryDatabasePath();
    const legacy = openRaw(location.path);
    legacy.exec("CREATE TABLE legacy_marker(value TEXT); PRAGMA user_version = 0;");
    legacy.close();

    const registry = await openDispatchRegistry(location.path, {
      now: () => new Date("2026-07-15T21:00:00.000Z"),
    });
    openRegistries.push(registry);

    expect(registry.health().schemaVersion).toBe(REGISTRY_SCHEMA_VERSION);
    const backups = (await readdir(location.directory)).filter((name) => name.includes("backup"));
    expect(backups).toEqual(["registry.sqlite.backup-2026-07-15T21-00-00.000Z"]);

    const backup = openRaw(join(location.directory, backups[0]!));
    expect((backup.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(0);
    expect(
      backup.prepare("SELECT name FROM sqlite_master WHERE name = 'legacy_marker'").get(),
    ).toBeDefined();
    backup.close();
  });

  it("migrates a version-1 Registry to automatic-default dispatch without losing dispatch tables", async () => {
    const location = await temporaryDatabasePath();
    const versionOne = openRaw(location.path);
    versionOne.exec(`${REGISTRY_SCHEMA_V1}\nPRAGMA user_version = 1;`);
    versionOne.close();

    const registry = await openDispatchRegistry(location.path, {
      now: () => new Date("2026-07-16T04:00:00.000Z"),
    });
    openRegistries.push(registry);

    expect(registry.health().schemaVersion).toBe(REGISTRY_SCHEMA_VERSION);
    const raw = openRaw(location.path);
    expect(
      raw.prepare("SELECT name FROM sqlite_master WHERE name = 'automation_grants'").get(),
    ).toBeUndefined();
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'dispatches'").get()).toBeDefined();
    raw.close();
    expect((await readdir(location.directory)).filter((name) => name.includes("backup"))).toEqual([
      "registry.sqlite.backup-2026-07-16T04-00-00.000Z",
    ]);
  });

  it("migrates version 2 by removing obsolete Automation Grants", async () => {
    const location = await temporaryDatabasePath();
    const versionTwo = openRaw(location.path);
    versionTwo.exec(`${REGISTRY_SCHEMA_V1}\n${REGISTRY_SCHEMA_V2}\nPRAGMA user_version = 2;`);
    versionTwo
      .prepare(
        `INSERT INTO automation_grants(
          id, origin_session_id, origin_workspace_id, targets_json, allow_write,
          max_dispatches, used_dispatches, expires_at, created_at, revoked_at
        ) VALUES (?, ?, ?, ?, 0, 5, 5, ?, ?, NULL)`,
      )
      .run(
        "hag_existing",
        "session-origin",
        "w-current",
        '[{"terminalId":"term-target","cwd":"/repo"}]',
        10_000,
        1_000,
      );
    versionTwo.close();

    const registry = await openDispatchRegistry(location.path, {
      now: () => new Date("2026-07-16T05:00:00.000Z"),
    });
    openRegistries.push(registry);

    expect(registry.health().schemaVersion).toBe(REGISTRY_SCHEMA_VERSION);
    const raw = openRaw(location.path);
    expect(
      raw.prepare("SELECT name FROM sqlite_master WHERE name = 'automation_grants'").get(),
    ).toBeUndefined();
    raw.close();
  });

  it("rolls back a failed migration and preserves both original state and backup", async () => {
    const location = await temporaryDatabasePath();
    const incompatible = openRaw(location.path);
    incompatible.exec("CREATE TABLE dispatches(id TEXT PRIMARY KEY); PRAGMA user_version = 0;");
    incompatible.close();

    await expect(
      openDispatchRegistry(location.path, {
        now: () => new Date("2026-07-15T21:05:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(RegistryUnavailableError);

    const unchanged = openRaw(location.path);
    expect((unchanged.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(0);
    expect(unchanged.prepare("PRAGMA table_info(dispatches)").all()).toHaveLength(1);
    unchanged.close();
    expect((await readdir(location.directory)).filter((name) => name.includes("backup"))).toEqual([
      "registry.sqlite.backup-2026-07-15T21-05-00.000Z",
    ]);
  });

  it("rejects a corrupt database without replacing or truncating it", async () => {
    const location = await temporaryDatabasePath();
    const corrupt = Buffer.from("not a sqlite database\n", "utf8");
    await writeFile(location.path, corrupt);

    await expect(openDispatchRegistry(location.path)).rejects.toBeInstanceOf(
      RegistryUnavailableError,
    );

    expect(await readFile(location.path)).toEqual(corrupt);
  });

  it("rejects a future schema without migrating it", async () => {
    const location = await temporaryDatabasePath();
    const future = openRaw(location.path);
    future.exec(`CREATE TABLE future_marker(value TEXT); PRAGMA user_version = ${REGISTRY_SCHEMA_VERSION + 1}`);
    future.close();

    await expect(openDispatchRegistry(location.path)).rejects.toBeInstanceOf(
      RegistryUnavailableError,
    );

    const unchanged = openRaw(location.path);
    expect((unchanged.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      REGISTRY_SCHEMA_VERSION + 1,
    );
    unchanged.close();
    expect((await readdir(location.directory)).filter((name) => name.includes("backup"))).toEqual([]);
  });
});
