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

async function registryPair(): Promise<[DispatchRegistry, DispatchRegistry]> {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-dispatch-settlement-"));
  cleanupPaths.push(directory);
  const path = join(directory, "registry.sqlite");
  const first = await openDispatchRegistry(path, { busyTimeoutMs: 100 });
  const second = await openDispatchRegistry(path, { busyTimeoutMs: 100 });
  registries.push(first, second);
  return [first, second];
}

function intent(): ConfirmDeliveryIntent {
  return {
    id: "hd_settle",
    originSessionId: "session_origin",
    originWorkspaceId: "w1",
    targetWorkspaceId: "w1",
    targetTerminalId: "term_target",
    targetPaneId: "w1:p2",
    targetAgentLabel: "pi",
    targetCwd: "/repo/worktree",
    worktreePath: "/repo/worktree",
    mode: "write",
    task: "Implement the change",
    constraints: ["Do not commit"],
    payload: "payload",
    payloadHash: "sha256:payload",
    deadlineAt: 2_000,
    confirmedAt: 1_000,
  };
}

afterEach(async () => {
  for (const registry of registries.splice(0)) registry.close();
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("first-wins settlement and active-branch claims", () => {
  it("atomically settles, stores the result, clears attention, and releases reservations", async () => {
    const [registry] = await registryPair();
    registry.confirmDeliveryIntent(intent());
    registry.markActive("hd_settle", 1_100);
    registry.addAttention("hd_settle", "overdue", {}, 2_001);

    expect(
      registry.settle({
        dispatchId: "hd_settle",
        outcome: "done",
        sourceTerminalId: "term_target",
        rawEnvelope: 'DISPATCH_RESULT {"id":"hd_settle","outcome":"done"}',
        sanitizedResult: { id: "hd_settle", outcome: "done", summary: "Complete" },
        kind: "result",
        settledAt: 2_100,
      }),
    ).toEqual({ status: "settled", outcome: "done" });

    expect(registry.getDispatch("hd_settle")).toMatchObject({
      lifecycle: "settled",
      finalOutcome: "done",
      settledAt: 2_100,
    });
    expect(registry.getResult("hd_settle")).toMatchObject({
      outcome: "done",
      sanitizedResult: { id: "hd_settle", outcome: "done", summary: "Complete" },
    });
    expect(registry.listTargetOccupancy()).toEqual([]);
    expect(registry.listWriteLeases()).toEqual([]);
    expect(registry.listAttention("hd_settle")).toEqual([]);
  });

  it("accepts settlement directly from durable delivering intent", async () => {
    const [registry] = await registryPair();
    registry.confirmDeliveryIntent(intent());

    expect(
      registry.settle({
        dispatchId: "hd_settle",
        outcome: "failed",
        sanitizedResult: { id: "hd_settle", outcome: "failed", summary: "Failed early" },
        kind: "manual",
        settledAt: 1_100,
      }),
    ).toEqual({ status: "settled", outcome: "failed" });
  });

  it("lets only the first conflicting settlement win across Registry connections", async () => {
    const [first, second] = await registryPair();
    first.confirmDeliveryIntent(intent());

    expect(
      first.settle({
        dispatchId: "hd_settle",
        outcome: "done",
        sanitizedResult: { id: "hd_settle", outcome: "done", summary: "First" },
        kind: "result",
        settledAt: 2_100,
      }),
    ).toEqual({ status: "settled", outcome: "done" });
    expect(
      second.settle({
        dispatchId: "hd_settle",
        outcome: "failed",
        sanitizedResult: { id: "hd_settle", outcome: "failed", summary: "Second" },
        kind: "emergency",
        settledAt: 2_101,
      }),
    ).toEqual({ status: "already-settled", outcome: "done" });

    expect(second.getResult("hd_settle")?.sanitizedResult).toMatchObject({ summary: "First" });
    expect(second.listAuditEvents("hd_settle").map((event) => event.eventType)).toContain(
      "settlement-duplicate",
    );
  });

  it("rolls back settlement when result data is not serializable", async () => {
    const [registry] = await registryPair();
    registry.confirmDeliveryIntent(intent());
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(() =>
      registry.settle({
        dispatchId: "hd_settle",
        outcome: "done",
        sanitizedResult: cyclic,
        kind: "result",
        settledAt: 2_100,
      }),
    ).toThrowError(RegistryStateError);
    expect(registry.getDispatch("hd_settle")?.lifecycle).toBe("delivering");
    expect(registry.listTargetOccupancy()).toHaveLength(1);
    expect(registry.listWriteLeases()).toHaveLength(1);
  });

  it("claims context delivery idempotently for the exact Origin Session and active branch", async () => {
    const [registry] = await registryPair();
    registry.confirmDeliveryIntent(intent());
    registry.settle({
      dispatchId: "hd_settle",
      outcome: "done",
      sanitizedResult: { id: "hd_settle", outcome: "done", summary: "Complete" },
      kind: "result",
      settledAt: 2_100,
    });

    expect(
      registry.claimContextDelivery({
        dispatchId: "hd_settle",
        originSessionId: "session_origin",
        branchLeafId: "leaf_a",
        claimedAt: 2_200,
      }),
    ).toBe("claimed");
    expect(
      registry.claimContextDelivery({
        dispatchId: "hd_settle",
        originSessionId: "session_origin",
        branchLeafId: "leaf_a",
        claimedAt: 2_201,
      }),
    ).toBe("already-claimed");

    expect(
      registry.claimContextDelivery({
        dispatchId: "hd_settle",
        originSessionId: "session_origin",
        branchLeafId: "leaf_b",
        claimedAt: 2_202,
      }),
    ).toBe("reassigned");
    expect(() =>
      registry.completeContextDelivery({
        dispatchId: "hd_settle",
        originSessionId: "session_origin",
        branchLeafId: "leaf_a",
        entryId: "entry_abandoned",
        completedAt: 2_203,
      }),
    ).toThrowError(RegistryStateError);
    expect(
      registry.completeContextDelivery({
        dispatchId: "hd_settle",
        originSessionId: "session_origin",
        branchLeafId: "leaf_b",
        entryId: "entry_result",
        completedAt: 2_203,
      }),
    ).toBe("completed");
    expect(
      registry.completeContextDelivery({
        dispatchId: "hd_settle",
        originSessionId: "session_origin",
        branchLeafId: "leaf_b",
        entryId: "entry_result",
        completedAt: 2_204,
      }),
    ).toBe("unchanged");
    expect(registry.getContextDelivery("hd_settle")).toMatchObject({
      branchLeafId: "leaf_b",
      deliveredEntryId: "entry_result",
      deliveredAt: 2_203,
    });
    expect(
      registry.claimContextDelivery({
        dispatchId: "hd_settle",
        originSessionId: "session_origin",
        branchLeafId: "leaf_c",
        claimedAt: 2_204,
      }),
    ).toBe("delivered");
  });

  it("rejects context claims from a fork or before settlement", async () => {
    const [registry] = await registryPair();
    registry.confirmDeliveryIntent(intent());

    expect(() =>
      registry.claimContextDelivery({
        dispatchId: "hd_settle",
        originSessionId: "session_fork",
        branchLeafId: "leaf_a",
        claimedAt: 1_100,
      }),
    ).toThrowError(RegistryStateError);
    expect(() =>
      registry.claimContextDelivery({
        dispatchId: "hd_settle",
        originSessionId: "session_origin",
        branchLeafId: "leaf_a",
        claimedAt: 1_100,
      }),
    ).toThrowError(RegistryStateError);
  });
});
