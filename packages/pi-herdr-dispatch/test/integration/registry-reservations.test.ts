import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  openDispatchRegistry,
  RegistryConflictError,
  RegistryStateError,
  type DispatchRegistry,
} from "../../src/registry/registry.js";
import type { ConfirmDeliveryIntent } from "../../src/registry/types.js";

const cleanupPaths: string[] = [];
const registries: DispatchRegistry[] = [];

async function registryPair(): Promise<[DispatchRegistry, DispatchRegistry]> {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-dispatch-reservations-"));
  cleanupPaths.push(directory);
  const path = join(directory, "registry.sqlite");
  const first = await openDispatchRegistry(path, { busyTimeoutMs: 100 });
  const second = await openDispatchRegistry(path, { busyTimeoutMs: 100 });
  registries.push(first, second);
  return [first, second];
}

function intent(overrides: Partial<ConfirmDeliveryIntent> = {}): ConfirmDeliveryIntent {
  return {
    id: "hd_001",
    originSessionId: "session_origin",
    originWorkspaceId: "w1",
    targetWorkspaceId: "w1",
    targetTerminalId: "term_target_1",
    targetPaneId: "w1:p2",
    targetAgentLabel: "pi",
    targetCwd: "/repo/worktree-a",
    worktreePath: "/repo/worktree-a",
    mode: "write",
    task: "Implement the change",
    constraints: ["Do not commit"],
    payload: "[HERDR DISPATCH]\nID: hd_001",
    payloadHash: "sha256:payload-001",
    deadlineAt: 2_000,
    confirmedAt: 1_000,
    maxActivePerTargetWorkspace: 4,
    maxActiveGlobal: 8,
    ...overrides,
  };
}

afterEach(async () => {
  for (const registry of registries.splice(0)) registry.close();
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("durable delivery intent and reservations", () => {
  it("atomically stores delivering intent, occupancy, write lease, and immutable payload", async () => {
    const [registry] = await registryPair();

    registry.confirmDeliveryIntent(intent());

    expect(registry.getDispatch("hd_001")).toMatchObject({
      id: "hd_001",
      lifecycle: "delivering",
      payload: "[HERDR DISPATCH]\nID: hd_001",
      payloadHash: "sha256:payload-001",
      constraints: ["Do not commit"],
      deliveryStartedAt: 1_000,
    });
    expect(registry.listTargetOccupancy()).toEqual([
      { targetTerminalId: "term_target_1", dispatchId: "hd_001", acquiredAt: 1_000 },
    ]);
    expect(registry.listWriteLeases()).toEqual([
      {
        worktreePath: "/repo/worktree-a",
        dispatchId: "hd_001",
        targetTerminalId: "term_target_1",
        acquiredAt: 1_000,
      },
    ]);
  });

  it("persists delivering intent and reservations across close and reopen", async () => {
    const [first, second] = await registryPair();
    first.confirmDeliveryIntent(intent());
    first.close();

    expect(second.getDispatch("hd_001")?.lifecycle).toBe("delivering");
    expect(second.listTargetOccupancy()).toHaveLength(1);
    expect(second.listWriteLeases()).toHaveLength(1);
  });

  it("allows only one Registry connection to occupy a target", async () => {
    const [first, second] = await registryPair();
    first.confirmDeliveryIntent(intent());

    expect(() =>
      second.confirmDeliveryIntent(
        intent({ id: "hd_002", payloadHash: "sha256:payload-002", targetCwd: "/repo/worktree-b", worktreePath: "/repo/worktree-b" }),
      ),
    ).toThrowError(RegistryConflictError);
    expect(second.getDispatch("hd_002")).toBeUndefined();
    expect(second.listTargetOccupancy()).toHaveLength(1);
  });

  it("rolls back dispatch and occupancy when a write lease conflicts", async () => {
    const [first, second] = await registryPair();
    first.confirmDeliveryIntent(intent());

    expect(() =>
      second.confirmDeliveryIntent(
        intent({
          id: "hd_002",
          payloadHash: "sha256:payload-002",
          targetTerminalId: "term_target_2",
          targetPaneId: "w1:p3",
        }),
      ),
    ).toThrowError(RegistryConflictError);
    expect(second.getDispatch("hd_002")).toBeUndefined();
    expect(second.listTargetOccupancy()).toEqual([
      { targetTerminalId: "term_target_1", dispatchId: "hd_001", acquiredAt: 1_000 },
    ]);
  });

  it("does not acquire a write lease for non-mutating work", async () => {
    const [registry] = await registryPair();

    registry.confirmDeliveryIntent(
      intent({ mode: "non-mutating", worktreePath: "/repo/worktree-a" }),
    );

    expect(registry.listWriteLeases()).toEqual([]);
  });

  it("enforces global and target-workspace concurrency inside the reservation transaction", async () => {
    const [registry] = await registryPair();
    registry.confirmDeliveryIntent(intent({ mode: "non-mutating" }));

    expect(() =>
      registry.confirmDeliveryIntent(
        intent({
          id: "hd_002",
          payloadHash: "sha256:payload-002",
          targetTerminalId: "term_target_2",
          targetPaneId: "w1:p3",
          mode: "non-mutating",
          maxActivePerTargetWorkspace: 1,
        }),
      ),
    ).toThrowError(RegistryConflictError);

    expect(() =>
      registry.confirmDeliveryIntent(
        intent({
          id: "hd_003",
          payloadHash: "sha256:payload-003",
          targetWorkspaceId: "w2",
          targetTerminalId: "term_target_3",
          targetPaneId: "w2:p1",
          mode: "non-mutating",
          maxActiveGlobal: 1,
        }),
      ),
    ).toThrowError(RegistryConflictError);
  });

  it("rejects invalid write intent before changing the Registry", async () => {
    const [registry] = await registryPair();

    expect(() =>
      registry.confirmDeliveryIntent(intent({ worktreePath: undefined })),
    ).toThrowError(RegistryStateError);
    expect(registry.getDispatch("hd_001")).toBeUndefined();
    expect(registry.listTargetOccupancy()).toEqual([]);
  });
});
