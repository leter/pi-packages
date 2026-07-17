import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  openDispatchRegistry,
  RegistryStateError,
  type DispatchRegistry,
} from "../../src/registry/registry.js";
import {
  REGISTRY_SCHEMA_V1,
  REGISTRY_SCHEMA_V2,
  REGISTRY_SCHEMA_V3,
  REGISTRY_SCHEMA_V4,
  REGISTRY_SCHEMA_V5,
  REGISTRY_SCHEMA_V6,
  REGISTRY_SCHEMA_V7,
  REGISTRY_SCHEMA_VERSION,
} from "../../src/registry/schema.js";
import type { ConfirmDeliveryIntent } from "../../src/registry/types.js";

const cleanupPaths: string[] = [];
const registries: DispatchRegistry[] = [];

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-dispatch-auto-run-"));
  cleanupPaths.push(directory);
  return join(directory, "registry.sqlite");
}

async function openRegistry(): Promise<DispatchRegistry> {
  const registry = await openDispatchRegistry(await temporaryDatabasePath(), {
    busyTimeoutMs: 100,
  });
  registries.push(registry);
  return registry;
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
    mode: "non-mutating",
    task: "Review the change",
    constraints: ["Do not commit"],
    payload: "[HERDR DISPATCH]\nID: hd_001",
    payloadHash: "sha256:payload-001",
    deadlineAt: 2_000,
    confirmedAt: 1_000,
    ...overrides,
  };
}

afterEach(async () => {
  for (const registry of registries.splice(0)) registry.close();
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Auto Run session state", () => {
  it("arms, rearms, and disarms one exact Origin Session", async () => {
    const registry = await openRegistry();

    expect(registry.isAutoRunArmed("session_origin")).toBe(false);
    registry.armAutoRun("session_origin", 10, 2, 1_000);
    registry.armAutoRun("session_origin", 10, 2, 1_100);
    expect(registry.isAutoRunArmed("session_origin")).toBe(true);
    expect(registry.isAutoRunArmed("session_other")).toBe(false);

    registry.disarmAutoRun("session_origin", 1_200);
    registry.disarmAutoRun("session_origin", 1_300);
    expect(registry.isAutoRunArmed("session_origin")).toBe(false);

    const audits = registry
      .listAuditEvents()
      .filter((event) => event.eventType.startsWith("auto-run-"))
      .map((event) => event.eventType);
    expect(audits).toEqual(["auto-run-armed", "auto-run-armed", "auto-run-disarmed"]);
  });

  it("reports the arm timestamp so results settled before arming can be ignored", async () => {
    const registry = await openRegistry();

    expect(registry.autoRunArmedAt("session_origin")).toBeUndefined();
    registry.armAutoRun("session_origin", 10, 2, 1_700);
    // Re-arming resets both the timestamp and Run Quota.
    registry.armAutoRun("session_origin", 10, 2, 9_999);
    expect(registry.autoRunArmedAt("session_origin")).toBe(9_999);

    registry.disarmAutoRun("session_origin", 2_000);
    expect(registry.autoRunArmedAt("session_origin")).toBeUndefined();
  });

  it("survives reopening the same database like a resumed Origin Session", async () => {
    const path = await temporaryDatabasePath();
    const first = await openDispatchRegistry(path, { busyTimeoutMs: 100 });
    registries.push(first);
    first.armAutoRun("session_origin", 10, 2, 1_000);
    first.close();

    const resumed = await openDispatchRegistry(path, { busyTimeoutMs: 100 });
    registries.push(resumed);
    expect(resumed.isAutoRunArmed("session_origin")).toBe(true);
  });
});

describe("Auto Run Depth on dispatches", () => {
  it("defaults depth to 0 and wake to true", async () => {
    const registry = await openRegistry();
    registry.confirmDeliveryIntent(intent());

    const stored = registry.getDispatch("hd_001")!;
    expect(stored.autoRunDepth).toBe(0);
    expect(stored.wakeOnSettle).toBe(true);
  });

  it("stores an inherited depth and an explicit wake downgrade", async () => {
    const registry = await openRegistry();
    registry.confirmDeliveryIntent(intent({ autoRunDepth: 3, wakeOnSettle: false }));

    const stored = registry.getDispatch("hd_001")!;
    expect(stored.autoRunDepth).toBe(3);
    expect(stored.wakeOnSettle).toBe(false);
  });

  it("rejects a negative or fractional depth", async () => {
    const registry = await openRegistry();

    expect(() => registry.confirmDeliveryIntent(intent({ autoRunDepth: -1 }))).toThrow(
      RegistryStateError,
    );
    expect(() => registry.confirmDeliveryIntent(intent({ autoRunDepth: 1.5 }))).toThrow(
      RegistryStateError,
    );
    expect(registry.getDispatch("hd_001")).toBeUndefined();
  });
});

describe("schema v5 migration", () => {
  it("backfills existing dispatches as depth 0 with wake enabled and adds the session table", async () => {
    const path = await temporaryDatabasePath();
    const legacy = new DatabaseSync(path, { timeout: 100 });
    legacy.exec(
      `${REGISTRY_SCHEMA_V1}\n${REGISTRY_SCHEMA_V2}\n${REGISTRY_SCHEMA_V3}\n${REGISTRY_SCHEMA_V4}\nPRAGMA user_version = 4;`,
    );
    legacy
      .prepare(
        `INSERT INTO dispatches (
          id, origin_session_id, origin_workspace_id, target_workspace_id,
          target_terminal_id, target_pane_id, target_agent_label, target_cwd,
          mode, lifecycle, task, constraints_json, payload, payload_hash,
          deadline_at, created_at, confirmed_at, delivery_started_at, updated_at
        ) VALUES (
          'hd_pre_v5', 'session_origin', 'w1', 'w1',
          'term_target_1', 'w1:p2', 'pi', '/repo',
          'non-mutating', 'active', 'Review', '[]', 'payload', 'sha256:x',
          2000, 1000, 1000, 1000, 1000
        )`,
      )
      .run();
    legacy.close();

    const registry = await openDispatchRegistry(path, { busyTimeoutMs: 100 });
    registries.push(registry);

    expect(registry.health().schemaVersion).toBe(REGISTRY_SCHEMA_VERSION);
    const migrated = registry.getDispatch("hd_pre_v5")!;
    expect(migrated.autoRunDepth).toBe(0);
    expect(migrated.wakeOnSettle).toBe(true);
    expect(registry.isAutoRunArmed("session_origin")).toBe(false);
  });
});

describe("schema v6 Run Quota migration", () => {
  it("treats a migrated NULL quota as defaultRunQuota and re-arming resets usage", async () => {
    const path = await temporaryDatabasePath();
    const legacy = new DatabaseSync(path, { timeout: 100 });
    legacy.exec(
      `${REGISTRY_SCHEMA_V1}\n${REGISTRY_SCHEMA_V2}\n${REGISTRY_SCHEMA_V3}\n${REGISTRY_SCHEMA_V4}\n${REGISTRY_SCHEMA_V5}\nPRAGMA user_version = 5;`,
    );
    legacy.prepare(
      "INSERT INTO auto_run_sessions(origin_session_id, armed_at) VALUES (?, ?)",
    ).run("session_origin", 1_000);
    legacy.close();

    const registry = await openDispatchRegistry(path, { busyTimeoutMs: 100 });
    registries.push(registry);
    expect(registry.getRunQuotaState("session_origin", 12)).toEqual({
      armed: true,
      quota: 12,
      used: 0,
      remaining: 12,
      legacyDefaulted: true,
    });

    registry.armAutoRun("session_origin", 3, 2, 2_000);
    expect(registry.getRunQuotaState("session_origin", 12)).toEqual({
      armed: true,
      quota: 3,
      used: 0,
      remaining: 3,
      legacyDefaulted: false,
    });
  });
});

describe("schema v8 Launch Budget", () => {
  const launched = {
    defaultLaunchBudget: 2,
    role: "reviewer",
    agentType: "claude",
    paneId: "w1:p-reviewer",
    terminalId: "term-reviewer",
    paneName: "reviewer-auto-1",
  };

  it("stores the budget on arm, consumes with audit, and resets usage on rearm", async () => {
    const registry = await openRegistry();
    registry.armAutoRun("session_origin", 10, 1, 1_000);

    expect(registry.getLaunchBudgetState("session_origin", 2)).toEqual({
      armed: true,
      remaining: 1,
    });
    expect(registry.consumeLaunchBudget("session_origin", 1_100, launched)).toBe(0);
    expect(registry.getLaunchBudgetState("session_origin", 2)).toEqual({
      armed: true,
      remaining: 0,
    });
    expect(registry.listAuditEvents()).toContainEqual(expect.objectContaining({
      eventType: "readonly_launch",
      data: expect.objectContaining({
        role: "reviewer",
        agentType: "claude",
        paneId: "w1:p-reviewer",
        terminalId: "term-reviewer",
        paneName: "reviewer-auto-1",
      }),
    }));

    registry.armAutoRun("session_origin", 10, 3, 1_200);
    expect(registry.getLaunchBudgetState("session_origin", 2)).toEqual({
      armed: true,
      remaining: 3,
    });
  });

  it("refuses consumption while disarmed or exhausted", async () => {
    const registry = await openRegistry();
    expect(() => registry.consumeLaunchBudget("session_origin", 1_000, launched)).toThrow(
      /Auto Run is disarmed/u,
    );

    registry.armAutoRun("session_origin", 10, 0, 1_100);
    expect(() => registry.consumeLaunchBudget("session_origin", 1_200, launched)).toThrow(
      /Launch Budget exhausted/u,
    );
    expect(registry.listAuditEvents().filter((event) => event.eventType === "readonly_launch")).toEqual([]);
  });

  it("uses the configured default for a migrated NULL budget", async () => {
    const path = await temporaryDatabasePath();
    const legacy = new DatabaseSync(path, { timeout: 100 });
    legacy.exec(
      `${REGISTRY_SCHEMA_V1}\n${REGISTRY_SCHEMA_V2}\n${REGISTRY_SCHEMA_V3}\n${REGISTRY_SCHEMA_V4}\n${REGISTRY_SCHEMA_V5}\n${REGISTRY_SCHEMA_V6}\n${REGISTRY_SCHEMA_V7}\nPRAGMA user_version = 7;`,
    );
    legacy.prepare(
      "INSERT INTO auto_run_sessions(origin_session_id, armed_at, run_quota) VALUES (?, ?, ?)",
    ).run("session_origin", 1_000, 10);
    legacy.close();

    const registry = await openDispatchRegistry(path, { busyTimeoutMs: 100 });
    registries.push(registry);
    expect(registry.getLaunchBudgetState("session_origin", 4)).toEqual({
      armed: true,
      remaining: 4,
    });
    expect(registry.consumeLaunchBudget("session_origin", 1_100, {
      ...launched,
      defaultLaunchBudget: 4,
    })).toBe(3);
  });
});
