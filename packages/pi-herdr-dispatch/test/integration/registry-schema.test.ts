import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  openDispatchRegistry,
  REGISTRY_SCHEMA_VERSION,
  type DispatchRegistry,
} from "../../src/registry/registry.js";

const cleanupPaths: string[] = [];
const openRegistries: DispatchRegistry[] = [];

async function temporaryRegistryPath(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-dispatch-registry-"));
  cleanupPaths.push(directory);
  return { directory, path: join(directory, "state", "registry.sqlite") };
}

afterEach(async () => {
  for (const registry of openRegistries.splice(0)) registry.close();
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Dispatch Registry schema", () => {
  it("opens a file-backed versioned Registry with required SQLite safety settings", async () => {
    const location = await temporaryRegistryPath();
    const registry = await openDispatchRegistry(location.path, { busyTimeoutMs: 2750 });
    openRegistries.push(registry);

    expect(registry.health()).toEqual({
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      journalMode: "wal",
      foreignKeys: true,
      busyTimeoutMs: 2750,
      integrity: "ok",
      mutationsEnabled: true,
    });
    expect(registry.path).toBe(location.path);
  });

  it("creates private state directory and database permissions", async () => {
    const location = await temporaryRegistryPath();
    const registry = await openDispatchRegistry(location.path);
    openRegistries.push(registry);

    expect((await stat(join(location.directory, "state"))).mode & 0o777).toBe(0o700);
    expect((await stat(location.path)).mode & 0o777).toBe(0o600);
  });

  it("does not create a migration backup for a fresh Registry", async () => {
    const location = await temporaryRegistryPath();
    const registry = await openDispatchRegistry(location.path);
    openRegistries.push(registry);

    expect((await readdir(join(location.directory, "state"))).filter((name) => name.includes("backup"))).toEqual([]);
  });
});
