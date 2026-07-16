import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DISPATCH_CONFIG } from "../../src/domain/config.js";
import type { ResolvedHerdrTarget } from "../../src/herdr/adapter.js";
import type { HerdrPaneRead } from "../../src/herdr/protocol.js";
import type {
  HerdrMonitorEvent,
  HerdrMonitorTarget,
  HerdrSubscriptionState,
} from "../../src/herdr/subscription.js";
import {
  OriginMonitor,
  type OriginMonitorHerdrPort,
} from "../../src/monitor/origin-monitor.js";
import { openDispatchRegistry, type DispatchRegistry } from "../../src/registry/registry.js";
import type { ConfirmDeliveryIntent } from "../../src/registry/types.js";
import { FakeMonitorClock } from "../support/fake-monitor-clock.js";

const roots: string[] = [];
const registries: DispatchRegistry[] = [];

afterEach(async () => {
  for (const registry of registries.splice(0)) registry.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const pane = {
  paneId: "p-target",
  terminalId: "term-target",
  workspaceId: "w-current",
  tabId: "t-current",
  focused: false,
  agentStatus: "working" as const,
  revision: 1,
  agent: "pi",
  cwd: "/repo/worktree",
};

class FakeMonitorHerdr implements OriginMonitorHerdrPort {
  resolved: ResolvedHerdrTarget | undefined = {
    pane,
    agent: { ...pane, name: "Pi", screenDetectionSkipped: true },
  };
  text = "";
  targets: HerdrMonitorTarget[] = [];
  readRequests: (50 | 200)[] = [];
  #event?: (event: HerdrMonitorEvent) => void | Promise<void>;
  #state?: (state: HerdrSubscriptionState) => void | Promise<void>;

  async resolveTerminal(): Promise<ResolvedHerdrTarget | undefined> {
    return this.resolved;
  }

  async readTail(paneId: string, lines: 50 | 200): Promise<HerdrPaneRead> {
    this.readRequests.push(lines);
    return {
      paneId,
      workspaceId: "w-current",
      tabId: "t-current",
      source: "recent_unwrapped",
      format: "text",
      text: this.text,
      revision: 2,
      truncated: false,
    };
  }

  async monitorTargets(
    targets: readonly HerdrMonitorTarget[],
    listener: (event: HerdrMonitorEvent) => void,
    stateListener?: (state: HerdrSubscriptionState) => void,
  ): Promise<void> {
    this.targets = [...targets];
    this.#event = listener;
    this.#state = stateListener;
    await this.emitState({ status: "connected" });
  }

  async emit(event: HerdrMonitorEvent): Promise<void> {
    await this.#event?.(event);
  }

  async emitState(state: HerdrSubscriptionState): Promise<void> {
    await this.#state?.(state);
  }
}

function intent(overrides: Partial<ConfirmDeliveryIntent> = {}): ConfirmDeliveryIntent {
  return {
    id: "hd_monitor",
    originSessionId: "session-origin",
    originWorkspaceId: "w-current",
    targetWorkspaceId: "w-current",
    targetTerminalId: "term-target",
    targetPaneId: "p-target",
    targetAgentLabel: "pi",
    targetCwd: "/repo/worktree",
    worktreePath: "/repo/worktree",
    mode: "write",
    task: "Implement",
    constraints: [],
    payload: "[HERDR DISPATCH]\nID: hd_monitor",
    payloadHash: "sha256:monitor",
    deadlineAt: 11_000,
    confirmedAt: 1_000,
    ...overrides,
  };
}

async function harness(
  lifecycle: "delivering" | "active" = "active",
  resumedAfterOriginGap = false,
  intentOverrides: Partial<ConfirmDeliveryIntent> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-monitor-"));
  roots.push(root);
  const registry = await openDispatchRegistry(join(root, "registry.sqlite"));
  registries.push(registry);
  registry.confirmDeliveryIntent(intent(intentOverrides));
  registry.recordAudit(
    "hd_monitor",
    "worktree-before-snapshot",
    { fingerprint: "before", entries: [] },
    1_000,
  );
  if (lifecycle === "active") registry.markActive("hd_monitor", 1_000);
  const herdr = new FakeMonitorHerdr();
  const clock = new FakeMonitorClock(1_000);
  const onSettled = vi.fn();
  const onAttention = vi.fn();
  const monitor = new OriginMonitor({
    registry,
    herdr,
    config: {
      ...DEFAULT_DISPATCH_CONFIG,
      startupWindowMs: 5_000,
      cwdPollMs: 5_000,
      cwdDriftSamples: 2,
    },
    originSessionId: "session-origin",
    clock,
    onSettled,
    onAttention,
    captureWorktreeSnapshot: async () => ({
      fingerprint: "after",
      entries: [" M src/a.ts"],
      diffStat: "1 file changed, 1 insertion(+)",
    }),
    resumedAfterOriginGap,
  });
  return { registry, herdr, clock, monitor, onSettled, onAttention };
}

describe("OriginMonitor", () => {
  it("does not run recovery catch-up during deliberate pre-delivery subscription reconfiguration", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-herdr-monitor-"));
    roots.push(root);
    const registry = await openDispatchRegistry(join(root, "registry.sqlite"));
    registries.push(registry);
    const herdr = new FakeMonitorHerdr();
    const monitor = new OriginMonitor({
      registry,
      herdr,
      config: DEFAULT_DISPATCH_CONFIG,
      originSessionId: "session-origin",
      clock: new FakeMonitorClock(1_000),
    });
    await monitor.start();
    await monitor.watchTargets([{ paneId: "p-target", correlationId: "hd_monitor" }]);
    registry.confirmDeliveryIntent(intent());

    await monitor.refresh();

    expect(registry.getDispatch("hd_monitor")?.lifecycle).toBe("delivering");
    expect(registry.listAttention("hd_monitor")).toEqual([]);
    monitor.stop();
  });

  it("recovers only exact-Origin durable records from bounded echo without resending", async () => {
    const { registry, herdr, monitor } = await harness("delivering");
    registry.confirmDeliveryIntent(
      intent({
        id: "hd_foreign_origin",
        originSessionId: "session-foreign",
        targetTerminalId: "term-foreign",
        targetPaneId: "p-foreign",
        mode: "non-mutating",
        worktreePath: undefined,
        payload: "ID: hd_foreign_origin",
      }),
    );
    herdr.text = "prompt │ ID: hd_monitor │";

    await monitor.start();

    expect(registry.getDispatch("hd_monitor")?.lifecycle).toBe("active");
    expect(herdr.readRequests).toEqual([200]);
    expect(herdr.targets).toEqual([{ paneId: "p-target", correlationId: "hd_monitor" }]);
    expect(registry.listAuditEvents("hd_monitor").map((event) => event.eventType)).toContain(
      "monitor-catch-up",
    );
    monitor.stop();
  });

  it("settles the first valid result from the confirmed terminal and releases reservations once", async () => {
    const { registry, herdr, monitor, onSettled } = await harness();
    herdr.text =
      'DISPATCH_RESULT {"id":"hd_monitor","outcome":"done","summary":"Complete","tests":["npm test"],"unknown":"raw"}';

    await monitor.start();

    expect(registry.getDispatch("hd_monitor")).toEqual(
      expect.objectContaining({ lifecycle: "settled", finalOutcome: "done" }),
    );
    expect(registry.getResult("hd_monitor")?.sanitizedResult).toEqual({
      id: "hd_monitor",
      outcome: "done",
      summary: "Complete",
      tests: ["npm test"],
    });
    expect(registry.listTargetOccupancy()).toEqual([]);
    expect(registry.listWriteLeases()).toEqual([]);
    expect(onSettled).toHaveBeenCalledOnce();
    expect(
      registry
        .listAuditEvents("hd_monitor")
        .find((event) => event.eventType === "worktree-after-snapshot")?.data,
    ).toEqual(
      expect.objectContaining({
        conclusion: "observed-changes",
        attribution: "not-attributed-to-target",
      }),
    );
    monitor.stop();
  });

  it("marks non-mutating worktree audit inconclusive when a known writer overlaps", async () => {
    const { registry, herdr, monitor } = await harness("active", false, { mode: "non-mutating" });
    registry.confirmDeliveryIntent(
      intent({
        id: "hd_writer",
        originSessionId: "session-writer",
        targetTerminalId: "term-writer",
        targetPaneId: "p-writer",
        mode: "write",
        payload: "writer",
      }),
    );
    herdr.text = 'DISPATCH_RESULT {"id":"hd_monitor","outcome":"done","summary":"Complete"}';

    await monitor.start();

    expect(
      registry
        .listAuditEvents("hd_monitor")
        .find((event) => event.eventType === "worktree-after-snapshot")?.data,
    ).toEqual(expect.objectContaining({ conclusion: "inconclusive-overlapping-writer" }));
    monitor.stop();
  });

  it("stores bounded malformed matching evidence without settling", async () => {
    const { registry, herdr, monitor } = await harness();
    herdr.text = 'DISPATCH_RESULT {"id":"hd_monitor","outcome":"done",broken}';

    await monitor.start();

    expect(registry.getDispatch("hd_monitor")?.lifecycle).toBe("active");
    expect(registry.listAttention("hd_monitor")).toEqual([
      expect.objectContaining({
        condition: "malformed-result",
        details: expect.objectContaining({ raw: expect.stringContaining("hd_monitor") }),
      }),
    ]);
    monitor.stop();
  });

  it("re-reads a partially rendered matching Result Envelope before marking it malformed", async () => {
    const { registry, herdr, clock, monitor } = await harness();
    await monitor.start();
    const partial = '• DISPATCH_RESULT\n  {"id":"hd_monitor","outcome":"done","summary":"Codex staged';

    await herdr.emit({
      type: "output-matched",
      paneId: "p-target",
      matchedLine: "• DISPATCH_RESULT",
      read: {
        paneId: "p-target",
        workspaceId: "w-current",
        tabId: "t-current",
        source: "recent_unwrapped",
        format: "text",
        text: partial,
        revision: 2,
        truncated: false,
      },
    });
    expect(registry.listAttention("hd_monitor")).toEqual([]);

    await clock.advance(4_999);
    expect(registry.getDispatch("hd_monitor")?.lifecycle).toBe("active");
    expect(registry.listAttention("hd_monitor")).toEqual([]);

    herdr.text = `${partial}\n  delivery verified"}`;
    await clock.advance(1);

    expect(registry.getDispatch("hd_monitor")).toMatchObject({
      lifecycle: "settled",
      finalOutcome: "done",
    });
    expect(registry.listAttention("hd_monitor")).toEqual([]);
    monitor.stop();
  });

  it("records a still-malformed streamed result after the bounded re-read window", async () => {
    const { registry, herdr, clock, monitor } = await harness();
    await monitor.start();
    const partial = 'DISPATCH_RESULT {"id":"hd_monitor","outcome":"done","summary":"unfinished';

    await herdr.emit({
      type: "output-matched",
      paneId: "p-target",
      matchedLine: partial,
      read: {
        paneId: "p-target",
        workspaceId: "w-current",
        tabId: "t-current",
        source: "recent_unwrapped",
        format: "text",
        text: partial,
        revision: 2,
        truncated: false,
      },
    });
    herdr.text = partial;
    await clock.advance(5_000);

    expect(registry.getDispatch("hd_monitor")?.lifecycle).toBe("active");
    expect(registry.listAttention("hd_monitor")).toEqual([
      expect.objectContaining({ condition: "malformed-result" }),
    ]);
    monitor.stop();
  });

  it("re-resolves a moved terminal and persists only its fresh pane route", async () => {
    const { registry, herdr, monitor } = await harness();
    await monitor.start();
    herdr.resolved = {
      pane: { ...pane, paneId: "p-moved" },
      agent: { ...pane, paneId: "p-moved", screenDetectionSkipped: true },
    };

    await herdr.emit({
      type: "pane-moved",
      previousPaneId: "p-target",
      previousWorkspaceId: "w-current",
      pane: { ...pane, paneId: "p-moved" },
    });

    expect(registry.getDispatch("hd_monitor")).toEqual(
      expect.objectContaining({ targetTerminalId: "term-target", targetPaneId: "p-moved" }),
    );
    monitor.stop();
  });

  it("uses fake time for startup, deadline, and two-sample cwd drift attention", async () => {
    const { registry, herdr, clock, monitor, onAttention } = await harness();
    herdr.resolved = {
      pane: { ...pane, agentStatus: "idle", cwd: "/somewhere/else" },
      agent: { ...pane, agentStatus: "idle", cwd: "/somewhere/else", screenDetectionSkipped: true },
    };
    // Keep catch-up from immediately treating idle as completion for this timer-focused case.
    herdr.resolved.pane.agentStatus = "unknown";
    herdr.resolved.agent!.agentStatus = "unknown";

    await monitor.start();
    await clock.advance(5_000);
    expect(registry.listAttention("hd_monitor").map((item) => item.condition)).toContain(
      "unacknowledged",
    );
    expect(registry.listAttention("hd_monitor").map((item) => item.condition)).not.toContain(
      "target-moved",
    );

    await clock.advance(5_000);
    expect(new Set(registry.listAttention("hd_monitor").map((item) => item.condition))).toEqual(
      new Set(["unacknowledged", "overdue", "target-moved"]),
    );
    expect(onAttention).toHaveBeenCalled();
    monitor.stop();
    expect(clock.pendingCount()).toBe(0);
  });

  it("handles blocked and idle-like status events through bounded reads", async () => {
    const { registry, herdr, monitor } = await harness();
    herdr.text = "blocked output";
    await monitor.start();

    await herdr.emit({
      type: "agent-status-changed",
      paneId: "p-target",
      workspaceId: "w-current",
      status: "blocked",
    });
    expect(registry.listAttention("hd_monitor").map((item) => item.condition)).toContain(
      "blocked-runtime",
    );
    expect(herdr.readRequests.at(-1)).toBe(50);

    await herdr.emit({
      type: "agent-status-changed",
      paneId: "p-target",
      workspaceId: "w-current",
      status: "done",
    });
    expect(registry.listAttention("hd_monitor").map((item) => item.condition)).toContain(
      "result-missing",
    );
    expect(herdr.readRequests.at(-1)).toBe(200);
    monitor.stop();
  });

  it("stores disconnect attention, clears it on reconnect, and performs bounded catch-up", async () => {
    const { registry, herdr, monitor } = await harness();
    await monitor.start();
    herdr.readRequests.length = 0;

    await herdr.emitState({ status: "disconnected", error: new Error("socket unavailable") });
    expect(registry.listAttention("hd_monitor").map((item) => item.condition)).toContain(
      "monitoring-paused",
    );

    await herdr.emitState({ status: "connected" });
    expect(registry.listAttention("hd_monitor").map((item) => item.condition)).not.toContain(
      "monitoring-paused",
    );
    expect(herdr.readRequests).toEqual([200]);
    monitor.stop();
  });

  it("records a derived Origin-closed gap on exact resume without inventing stored pause", async () => {
    const { registry, monitor } = await harness("active", true);

    await monitor.start();

    expect(registry.listAttention("hd_monitor").map((item) => item.condition)).not.toContain(
      "monitoring-paused",
    );
    expect(registry.listAuditEvents("hd_monitor")).toContainEqual(
      expect.objectContaining({
        eventType: "origin-monitor-resumed",
        data: { derivedOriginClosedGap: true },
      }),
    );
    monitor.stop();
  });

  it("marks a disappeared terminal target-lost without heuristic retargeting or release", async () => {
    const { registry, herdr, monitor } = await harness();
    herdr.resolved = undefined;

    await monitor.start();

    expect(registry.listAttention("hd_monitor").map((item) => item.condition)).toContain(
      "target-lost",
    );
    expect(registry.getDispatch("hd_monitor")?.lifecycle).toBe("active");
    expect(registry.listTargetOccupancy()).toHaveLength(1);
    monitor.stop();
  });
});
