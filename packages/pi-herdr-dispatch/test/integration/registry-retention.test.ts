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

function intent(
  id: string,
  target: string,
  confirmedAt: number,
  overrides: Partial<ConfirmDeliveryIntent> = {},
): ConfirmDeliveryIntent {
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
    ...overrides,
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

describe("recent settled listing", () => {
  it("lists newest settled first, bounded, scoped to the origin session", async () => {
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
      outcome: "failed",
      sanitizedResult: { summary: "recent" },
      kind: "result",
      settledAt: 6_000,
    });

    expect(
      registry.listRecentSettled("session_origin", 5).map((dispatch) => dispatch.id),
    ).toEqual(["hd_recent", "hd_old"]);
    expect(
      registry.listRecentSettled("session_origin", 1).map((dispatch) => dispatch.id),
    ).toEqual(["hd_recent"]);
    expect(registry.listRecentSettled("session_other", 5)).toEqual([]);
    expect(() => registry.listRecentSettled("session_origin", 0)).toThrowError(RangeError);
    expect(() => registry.listRecentSettled("session_origin", 101)).toThrowError(RangeError);
  });

  it("lists recent settled history across origins in one workspace", async () => {
    const registry = await openRegistry();
    registry.confirmDeliveryIntent(intent("hd_own", "term_own", 1_000));
    registry.settle({
      dispatchId: "hd_own",
      outcome: "done",
      sanitizedResult: { summary: "own" },
      kind: "result",
      settledAt: 2_000,
    });
    registry.confirmDeliveryIntent(
      intent("hd_foreign", "term_foreign", 3_000, { originSessionId: "session_other" }),
    );
    registry.settle({
      dispatchId: "hd_foreign",
      outcome: "failed",
      sanitizedResult: { summary: "foreign" },
      kind: "result",
      settledAt: 4_000,
    });
    registry.confirmDeliveryIntent(
      intent("hd_elsewhere", "term_elsewhere", 5_000, {
        originSessionId: "session_other",
        originWorkspaceId: "w2",
        targetWorkspaceId: "w2",
      }),
    );
    registry.settle({
      dispatchId: "hd_elsewhere",
      outcome: "done",
      sanitizedResult: { summary: "elsewhere" },
      kind: "result",
      settledAt: 6_000,
    });

    expect(
      registry.listRecentSettledInWorkspace("w1", 5).map((dispatch) => dispatch.id),
    ).toEqual(["hd_foreign", "hd_own"]);
    expect(
      registry.listRecentSettledInWorkspace("w1", 1).map((dispatch) => dispatch.id),
    ).toEqual(["hd_foreign"]);
    expect(registry.listRecentSettledInWorkspace("w2", 5).map((dispatch) => dispatch.id)).toEqual([
      "hd_elsewhere",
    ]);
  });
});

describe("workspace dispatch lookup", () => {
  it("lists unsettled records across origins only in the target workspace", async () => {
    const registry = await openRegistry();
    registry.confirmDeliveryIntent(intent("hd_own", "term_own", 1_000));
    registry.confirmDeliveryIntent(
      intent("hd_foreign", "term_foreign", 2_000, { originSessionId: "session_other" }),
    );
    registry.confirmDeliveryIntent(
      intent("hd_elsewhere", "term_elsewhere", 3_000, {
        originSessionId: "session_other",
        originWorkspaceId: "w2",
        targetWorkspaceId: "w2",
      }),
    );

    expect(registry.listUnsettledInWorkspace("w1").map((dispatch) => dispatch.id)).toEqual([
      "hd_own",
      "hd_foreign",
    ]);
    expect(registry.listUnsettledInWorkspace("w2").map((dispatch) => dispatch.id)).toEqual([
      "hd_elsewhere",
    ]);
  });

  it("matches a literal prefix across retained lifecycle states and within one workspace", async () => {
    const registry = await openRegistry();
    registry.confirmDeliveryIntent(intent("hd_shared_active", "term_active", 1_000));
    registry.confirmDeliveryIntent(intent("hd_shared_done", "term_done", 2_000));
    registry.confirmDeliveryIntent(
      intent("hd_shared_elsewhere", "term_elsewhere", 3_000, {
        originWorkspaceId: "w2",
        targetWorkspaceId: "w2",
      }),
    );
    registry.settle({
      dispatchId: "hd_shared_done",
      outcome: "done",
      sanitizedResult: { summary: "done" },
      kind: "result",
      settledAt: 4_000,
    });

    expect(registry.listByIdPrefix("w1", "hd_shared_").map((dispatch) => dispatch.id)).toEqual([
      "hd_shared_active",
      "hd_shared_done",
    ]);
    expect(registry.listByIdPrefix("w1", "hd_shared_active").map((dispatch) => dispatch.id)).toEqual([
      "hd_shared_active",
    ]);
    expect(registry.listByIdPrefix("w1", "hd_missing")).toEqual([]);
    expect(() => registry.listByIdPrefix("w1", "hd_%")).toThrow(TypeError);
  });
});
