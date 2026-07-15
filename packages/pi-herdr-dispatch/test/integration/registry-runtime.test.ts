import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RegistryRuntime } from "../../src/pi/registry-runtime.js";
import type { ConfirmDeliveryIntent } from "../../src/registry/types.js";

const cleanupPaths: string[] = [];
const runtimes: RegistryRuntime[] = [];

async function runtimePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-dispatch-runtime-"));
  cleanupPaths.push(directory);
  return join(directory, "registry.sqlite");
}

function writeIntent(): ConfirmDeliveryIntent {
  return {
    id: "hd_runtime",
    originSessionId: "session_origin",
    originWorkspaceId: "w1",
    targetWorkspaceId: "w1",
    targetTerminalId: "term_target",
    targetPaneId: "w1:p2",
    targetAgentLabel: "pi",
    targetCwd: "/repo/worktree",
    worktreePath: "/repo/worktree",
    mode: "write",
    task: "Implement",
    constraints: [],
    payload: "payload",
    payloadHash: "sha256:payload",
    deadlineAt: 2_000,
    confirmedAt: 1_000,
  };
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.stop();
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("session-scoped Registry runtime", () => {
  it("feeds durable write leases into the existing safety policy", async () => {
    const runtime = new RegistryRuntime(await runtimePath());
    runtimes.push(runtime);

    expect(runtime.leaseContext().leaseSnapshot.status).toBe("unavailable");
    expect(await runtime.start()).toBe(true);
    runtime.registry?.confirmDeliveryIntent(writeIntent());

    expect(runtime.leaseContext()).toEqual({
      actorTerminalId: undefined,
      leaseSnapshot: {
        status: "ready",
        leases: [
          {
            dispatchId: "hd_runtime",
            targetTerminalId: "term_target",
            worktreePath: "/repo/worktree",
          },
        ],
      },
    });

    runtime.stop();
    expect(runtime.leaseContext().leaseSnapshot.status).toBe("unavailable");
  });

  it("keeps the safety policy fail-closed when opening a corrupt Registry fails", async () => {
    const path = await runtimePath();
    await writeFile(path, "not sqlite");
    const runtime = new RegistryRuntime(path);
    runtimes.push(runtime);

    expect(await runtime.start()).toBe(false);
    const context = runtime.leaseContext();
    expect(context.leaseSnapshot.status).toBe("unavailable");
    if (context.leaseSnapshot.status === "unavailable") {
      expect(context.leaseSnapshot.reason).toContain("unavailable");
    }
  });
});
