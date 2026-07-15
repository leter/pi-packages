import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { openDispatchRegistry, type DispatchRegistry } from "../../src/registry/registry.js";

const cleanupPaths: string[] = [];
const registries: DispatchRegistry[] = [];

const tsx = fileURLToPath(new URL("../../../../node_modules/.bin/tsx", import.meta.url));
const racer = fileURLToPath(new URL("../fixtures/registry-racer.ts", import.meta.url));

afterEach(async () => {
  for (const registry of registries.splice(0)) registry.close();
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("multi-process reservation race", () => {
  it("allows exactly one process to reserve the same target and worktree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-herdr-dispatch-process-race-"));
    cleanupPaths.push(directory);
    const databasePath = join(directory, "registry.sqlite");
    const goPath = join(directory, "go");
    const racers = ["hd_race_a", "hd_race_b"].map((dispatchId) => {
      const readyPath = join(directory, `${dispatchId}.ready`);
      return {
        readyPath,
        result: runRacer([databasePath, dispatchId, readyPath, goPath]),
      };
    });

    await waitUntil(() => racers.every(({ readyPath }) => existsSync(readyPath)));
    await writeFile(goPath, "go");
    const results = await Promise.all(racers.map(({ result }) => result));

    expect(results.map((result) => result.status).sort()).toEqual(["conflict", "won"]);
    const registry = await openDispatchRegistry(databasePath);
    registries.push(registry);
    expect(registry.listTargetOccupancy()).toHaveLength(1);
    expect(registry.listWriteLeases()).toHaveLength(1);
  });
});

function runRacer(args: readonly string[]): Promise<{ status: string; dispatchId: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsx, [racer, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`registry racer exited ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout) as { status: string; dispatchId: string });
    });
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for registry racers");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
