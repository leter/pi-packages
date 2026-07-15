import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  openDispatchRegistry,
  RegistryStateError,
  RegistryUnavailableError,
  type DispatchRegistry,
} from "../../src/registry/registry.js";
import type { ConfirmDeliveryIntent } from "../../src/registry/types.js";

const cleanupPaths: string[] = [];
const registries: DispatchRegistry[] = [];

async function openRegistry(busyTimeoutMs = 100): Promise<{ registry: DispatchRegistry; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-dispatch-lifecycle-"));
  cleanupPaths.push(directory);
  const path = join(directory, "registry.sqlite");
  const registry = await openDispatchRegistry(path, { busyTimeoutMs });
  registries.push(registry);
  return { registry, path };
}

function intent(): ConfirmDeliveryIntent {
  return {
    id: "hd_lifecycle",
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

describe("Registry lifecycle, attention, and audit", () => {
  it("compare-and-sets delivering to active exactly once", async () => {
    const { registry } = await openRegistry();
    registry.confirmDeliveryIntent(intent());

    expect(registry.markActive("hd_lifecycle", 1_100)).toBe("changed");
    expect(registry.markActive("hd_lifecycle", 1_200)).toBe("unchanged");
    expect(registry.getDispatch("hd_lifecycle")).toMatchObject({
      lifecycle: "active",
      activeAt: 1_100,
      updatedAt: 1_100,
    });
    expect(registry.listAuditEvents("hd_lifecycle").map((event) => event.eventType)).toEqual([
      "delivery-intent-confirmed",
      "dispatch-active",
    ]);
  });

  it("updates mutable pane routes without changing terminal identity and records monitor audit", async () => {
    const { registry } = await openRegistry();
    registry.confirmDeliveryIntent(intent());

    expect(registry.updateTargetRoute("hd_lifecycle", "p-moved", 1_050)).toBe("changed");
    expect(registry.updateTargetRoute("hd_lifecycle", "p-moved", 1_060)).toBe("unchanged");
    registry.recordAudit("hd_lifecycle", "monitor-catch-up", { lines: 200 }, 1_070);

    expect(registry.getDispatch("hd_lifecycle")).toEqual(
      expect.objectContaining({ targetTerminalId: "term_target", targetPaneId: "p-moved" }),
    );
    expect(registry.listAuditEvents("hd_lifecycle").map((event) => event.eventType)).toEqual([
      "delivery-intent-confirmed",
      "target-route-updated",
      "monitor-catch-up",
    ]);
  });

  it("stores coexisting Attention Conditions idempotently", async () => {
    const { registry } = await openRegistry();
    registry.confirmDeliveryIntent(intent());

    expect(
      registry.addAttention("hd_lifecycle", "delivery-unverified", { reason: "echo absent" }, 1_100),
    ).toBe("added");
    expect(
      registry.addAttention("hd_lifecycle", "delivery-unverified", { reason: "different" }, 1_200),
    ).toBe("unchanged");
    expect(registry.addAttention("hd_lifecycle", "overdue", {}, 2_001)).toBe("added");

    expect(registry.listAttention("hd_lifecycle")).toEqual([
      {
        condition: "delivery-unverified",
        details: { reason: "echo absent" },
        addedAt: 1_100,
      },
      { condition: "overdue", details: {}, addedAt: 2_001 },
    ]);
  });

  it("clears Attention Conditions without releasing reservations", async () => {
    const { registry } = await openRegistry();
    registry.confirmDeliveryIntent(intent());
    registry.addAttention("hd_lifecycle", "unacknowledged", {}, 1_100);

    expect(registry.clearAttention("hd_lifecycle", "unacknowledged", 1_200)).toBe("cleared");
    expect(registry.clearAttention("hd_lifecycle", "unacknowledged", 1_300)).toBe("unchanged");
    expect(registry.listAttention("hd_lifecycle")).toEqual([]);
    expect(registry.listTargetOccupancy()).toHaveLength(1);
    expect(registry.listWriteLeases()).toHaveLength(1);
  });

  it("rejects lifecycle and attention writes for an unknown dispatch", async () => {
    const { registry } = await openRegistry();

    expect(() => registry.markActive("missing", 1_000)).toThrowError(RegistryStateError);
    expect(() => registry.addAttention("missing", "overdue", {}, 1_000)).toThrowError(
      RegistryStateError,
    );
  });

  it("does not trip the structural mutation fuse when transient SQLITE_BUSY exhausts its timeout", async () => {
    const { registry, path } = await openRegistry(0);
    registry.confirmDeliveryIntent(intent());
    const blocker = new DatabaseSync(path, { timeout: 0 });
    blocker.exec("BEGIN IMMEDIATE");

    expect(() => registry.markActive("hd_lifecycle", 1_100)).toThrowError(
      RegistryUnavailableError,
    );
    blocker.exec("ROLLBACK");
    blocker.close();

    expect(registry.health().mutationsEnabled).toBe(true);
    expect(registry.getDispatch("hd_lifecycle")?.lifecycle).toBe("delivering");
    expect(registry.addAttention("hd_lifecycle", "overdue", {}, 2_100)).toBe("added");
  });
});
