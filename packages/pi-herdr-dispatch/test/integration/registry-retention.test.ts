import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  openDispatchRegistry,
  RegistryStateError,
  type DispatchRegistry,
} from "../../src/registry/registry.js";
import type { ConfirmDeliveryIntent } from "../../src/registry/types.js";

const cleanupPaths: string[] = [];
const registries: DispatchRegistry[] = [];

async function openRegistry(): Promise<DispatchRegistry> {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-dispatch-retention-"));
  cleanupPaths.push(directory);
  const registry = await openDispatchRegistry(join(directory, "registry.sqlite"));
  registries.push(registry);
  return registry;
}

function intent(id: string, target: string, confirmedAt: number): ConfirmDeliveryIntent {
  return {
    id,
    originSessionId: "session_origin",
    originWorkspaceId: "w1",
    targetWorkspaceId: "w1",
    targetTerminalId: target,
    targetPaneId: `w1:${target}`,
    targetAgentLabel: "pi",
    targetCwd: `/repo/${id}`,
    mode: "non-mutating",
    task: "Review",
    constraints: [],
    payload: `payload:${id}`,
    payloadHash: `sha256:${id}`,
    deadlineAt: confirmedAt + 10_000,
    confirmedAt,
  };
}

afterEach(async () => {
  for (const registry of registries.splice(0)) registry.close();
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Registry retention", () => {
  it("purges only settled records older than the cutoff", async () => {
    const registry = await openRegistry();
    registry.confirmDeliveryIntent(intent("hd_old", "term_old", 1_000));
    registry.confirmDeliveryIntent(intent("hd_recent", "term_recent", 2_000));
    registry.confirmDeliveryIntent(intent("hd_active", "term_active", 3_000));
    registry.settle({
      dispatchId: "hd_old",
      outcome: "done",
      sanitizedResult: { summary: "old" },
      kind: "result",
      settledAt: 4_000,
    });
    registry.settle({
      dispatchId: "hd_recent",
      outcome: "done",
      sanitizedResult: { summary: "recent" },
      kind: "result",
      settledAt: 6_000,
    });

    expect(registry.purgeSettledBefore(5_000, 7_000)).toBe(1);

    expect(registry.getDispatch("hd_old")).toBeUndefined();
    expect(registry.getResult("hd_old")).toBeUndefined();
    expect(registry.listAuditEvents("hd_old")).toEqual([]);
    expect(registry.getDispatch("hd_recent")?.lifecycle).toBe("settled");
    expect(registry.getDispatch("hd_active")?.lifecycle).toBe("delivering");
    expect(registry.listUnsettled("session_origin").map((dispatch) => dispatch.id)).toEqual([
      "hd_active",
    ]);
    expect(registry.purgeSettledBefore(5_000, 7_001)).toBe(0);
  });

  it("never purges unsettled records regardless of age", async () => {
    const registry = await openRegistry();
    registry.confirmDeliveryIntent(intent("hd_active", "term_active", 1));

    expect(registry.purgeSettledBefore(Number.MAX_SAFE_INTEGER, 9_000)).toBe(0);
    expect(registry.getDispatch("hd_active")).toBeDefined();
    expect(registry.listTargetOccupancy()).toHaveLength(1);
  });

  it("rejects invalid retention timestamps without mutating", async () => {
    const registry = await openRegistry();
    registry.confirmDeliveryIntent(intent("hd_active", "term_active", 1));

    expect(() => registry.purgeSettledBefore(Number.NaN, 9_000)).toThrowError(
      RegistryStateError,
    );
    expect(registry.getDispatch("hd_active")).toBeDefined();
  });
});
