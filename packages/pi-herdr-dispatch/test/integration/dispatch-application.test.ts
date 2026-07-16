import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DispatchApplication,
  StaleProposalError,
  type HerdrDispatchPort,
} from "../../src/dispatch/application.js";
import { DEFAULT_DISPATCH_CONFIG } from "../../src/domain/config.js";
import type { HerdrDeliveryResult } from "../../src/herdr/delivery.js";
import type {
  CurrentWorkspaceSnapshot,
  ResolvedHerdrTarget,
} from "../../src/herdr/adapter.js";
import type { HerdrMonitorEvent, HerdrMonitorTarget } from "../../src/herdr/subscription.js";
import { openDispatchRegistry, type DispatchRegistry } from "../../src/registry/registry.js";

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
  agentStatus: "done" as const,
  revision: 1,
  agent: "pi",
  cwd: "/repo/worktree",
};
const agent = {
  ...pane,
  name: "Pi target",
  screenDetectionSkipped: false,
};

class FakeHerdr implements HerdrDispatchPort {
  delivery: HerdrDeliveryResult = {
    status: "verified",
    pane,
    echo: {
      paneId: pane.paneId,
      workspaceId: pane.workspaceId,
      tabId: pane.tabId,
      source: "recent_unwrapped",
      format: "text",
      text: "ID: hd_test",
      revision: 2,
      truncated: false,
    },
  };
  resolved: ResolvedHerdrTarget | undefined = { pane, agent };
  beforeDelivery?: () => void;
  deliveryError?: Error;
  monitored: HerdrMonitorTarget[] = [];
  readLines?: 50 | 200;

  async currentWorkspaceSnapshot(): Promise<CurrentWorkspaceSnapshot> {
    return {
      workspace: { workspaceId: "w-current", label: "Current", focused: true },
      panes: [pane],
      agents: [agent],
      serverVersion: "0.7.3",
      protocol: 16,
    };
  }

  async resolveTerminal(): Promise<ResolvedHerdrTarget | undefined> {
    return this.resolved;
  }

  async monitorTargets(
    targets: readonly HerdrMonitorTarget[],
    _listener: (event: HerdrMonitorEvent) => void,
  ): Promise<void> {
    this.monitored = [...targets];
  }

  async deliverAndVerify(): Promise<HerdrDeliveryResult> {
    this.beforeDelivery?.();
    if (this.deliveryError) throw this.deliveryError;
    return this.delivery;
  }

  async readTail(_paneId: string, lines: 50 | 200) {
    this.readLines = lines;
    return {
      paneId: pane.paneId,
      workspaceId: pane.workspaceId,
      tabId: pane.tabId,
      source: "recent_unwrapped" as const,
      format: "text" as const,
      text: Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n"),
      revision: 3,
      truncated: false,
    };
  }
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-application-"));
  roots.push(root);
  const registry = await openDispatchRegistry(join(root, "registry.sqlite"));
  registries.push(registry);
  const herdr = new FakeHerdr();
  let now = 1_750_000_000_000;
  let sequence = 0;
  const application = new DispatchApplication({
    config: { ...DEFAULT_DISPATCH_CONFIG, startupWindowMs: 5_000 },
    registry,
    herdr,
    workspaceId: "w-current",
    originTerminalId: "term-origin",
    now: () => now,
    nextCorrelationId: () => `hd_test_${++sequence}`,
    resolveWorktree: async () => "/canonical/worktree",
    captureWorktreeSnapshot: async () => ({ fingerprint: "before", entries: [], diffStat: "" }),
  });
  return {
    application,
    registry,
    herdr,
    advance(ms = 1) {
      now += ms;
    },
  };
}

const origin = {
  sessionId: "session-origin",
  sessionFile: "/sessions/origin.jsonl",
};

describe("DispatchApplication", () => {
  it("creates proposals only for current-workspace idle-like unoccupied non-self Agents", async () => {
    const { application } = await harness();

    const eligible = await application.listEligibleAgents();
    expect(eligible).toEqual([
      expect.objectContaining({
        terminalId: "term-target",
        status: "done",
        statusProvenance: "screen-detected",
      }),
    ]);

    const proposal = await application.createProposal({
      target: "Pi target",
      mode: "non-mutating",
      task: "Inspect the parser.",
      deadlineMinutes: 15,
      allowProjectDependencyInstall: false,
    });
    expect(proposal.target.terminalId).toBe("term-target");
    expect(proposal.payload).toContain("ID: hd_test_1");
  });

  it("persists delivering intent and reservations before one verified delivery becomes active", async () => {
    const { application, registry, herdr } = await harness();
    const proposal = await application.createProposal({
      target: "term-target",
      mode: "non-mutating",
      task: "Inspect the parser.",
      deadlineMinutes: 15,
      allowProjectDependencyInstall: false,
    });
    herdr.beforeDelivery = () => {
      expect(registry.getDispatch(proposal.id)?.lifecycle).toBe("delivering");
      expect(registry.listTargetOccupancy()).toEqual([
        expect.objectContaining({ dispatchId: proposal.id, targetTerminalId: "term-target" }),
      ]);
    };

    await expect(application.confirmProposal(proposal, origin)).resolves.toEqual({
      status: "active",
      dispatchId: proposal.id,
      echoVerified: true,
    });
    expect(registry.getDispatch(proposal.id)?.lifecycle).toBe("active");
    expect(registry.listAuditEvents(proposal.id)).toContainEqual(
      expect.objectContaining({
        eventType: "delivery-intent-confirmed",
        data: expect.objectContaining({ authorization: { kind: "automatic-default" } }),
      }),
    );
    expect(herdr.monitored).toEqual([{ paneId: "p-target", correlationId: proposal.id }]);
    await expect(application.listEligibleAgents()).resolves.toEqual([]);
    await expect(
      application.createProposal({
        target: "term-target",
        mode: "non-mutating",
        task: "Duplicate",
      }),
    ).rejects.toThrow("not an Eligible Agent");
  });

  it("resolves and atomically reserves the canonical worktree for write mode", async () => {
    const { application, registry, herdr } = await harness();
    const proposal = await application.createProposal({
      target: "term-target",
      mode: "write",
      task: "Update the parser.",
      deadlineMinutes: 15,
      allowProjectDependencyInstall: true,
    });
    expect(proposal.target.worktreePath).toBe("/canonical/worktree");
    herdr.beforeDelivery = () => {
      expect(registry.listWriteLeases()).toEqual([
        expect.objectContaining({
          dispatchId: proposal.id,
          worktreePath: "/canonical/worktree",
        }),
      ]);
    };

    await expect(application.confirmProposal(proposal, origin)).resolves.toEqual(
      expect.objectContaining({ status: "active" }),
    );
  });

  it("retains reservations and attention for both known-send and unknown-send ambiguity", async () => {
    const { application, registry, herdr, advance } = await harness();
    const first = await application.createProposal({
      target: "term-target",
      mode: "non-mutating",
      task: "First",
      deadlineMinutes: 15,
      allowProjectDependencyInstall: false,
    });
    herdr.delivery = { status: "ambiguous", reason: "echo-not-found", pane };

    await expect(application.confirmProposal(first, origin)).resolves.toEqual({
      status: "delivery-unverified",
      dispatchId: first.id,
      lifecycle: "delivering",
    });
    expect(registry.getDispatch(first.id)?.lifecycle).toBe("delivering");
    expect(registry.listAttention(first.id).map((item) => item.condition)).toEqual([
      "delivery-unverified",
    ]);

    registry.settle({
      dispatchId: first.id,
      outcome: "failed",
      sanitizedResult: { summary: "test cleanup" },
      kind: "manual",
      settledAt: 1_750_000_000_100,
    });
    advance(200);
    const second = await application.createProposal({
      target: "term-target",
      mode: "non-mutating",
      task: "Second",
      deadlineMinutes: 15,
      allowProjectDependencyInstall: false,
    });
    herdr.delivery = { status: "ambiguous", reason: "response-unknown", pane };

    await expect(application.confirmProposal(second, origin)).resolves.toEqual({
      status: "delivery-unverified",
      dispatchId: second.id,
      lifecycle: "delivering",
    });
    expect(registry.getDispatch(second.id)?.lifecycle).toBe("delivering");
    expect(registry.listTargetOccupancy()).toHaveLength(1);
  });

  it("accepts done-to-idle drift because both statuses are idle-like", async () => {
    const { application, herdr } = await harness();
    const proposal = await application.createProposal({
      target: "term-target",
      mode: "non-mutating",
      task: "Inspect",
      deadlineMinutes: 15,
      allowProjectDependencyInstall: false,
    });
    herdr.resolved = {
      pane: { ...pane, agentStatus: "idle" },
      agent: { ...agent, agentStatus: "idle" },
    };

    await expect(application.confirmProposal(proposal, origin)).resolves.toEqual(
      expect.objectContaining({ status: "active" }),
    );
  });

  it("invalidates stale proposals before acquiring any reservation", async () => {
    const { application, registry, herdr } = await harness();
    const proposal = await application.createProposal({
      target: "term-target",
      mode: "non-mutating",
      task: "Inspect",
      deadlineMinutes: 15,
      allowProjectDependencyInstall: false,
    });
    herdr.resolved = { pane: { ...pane, agentStatus: "working" }, agent: { ...agent, agentStatus: "working" } };

    await expect(application.confirmProposal(proposal, origin)).rejects.toBeInstanceOf(
      StaleProposalError,
    );
    expect(registry.getDispatch(proposal.id)).toBeUndefined();
    expect(registry.listTargetOccupancy()).toEqual([]);
  });

  it("keeps delivering reservations and adds attention on an unexpected adapter failure", async () => {
    const { application, registry, herdr } = await harness();
    const proposal = await application.createProposal({
      target: "term-target",
      mode: "non-mutating",
      task: "Inspect",
      deadlineMinutes: 15,
      allowProjectDependencyInstall: false,
    });
    herdr.deliveryError = new Error("protocol stream failed");

    await expect(application.confirmProposal(proposal, origin)).resolves.toEqual({
      status: "delivery-unverified",
      dispatchId: proposal.id,
      lifecycle: "delivering",
    });
    expect(registry.getDispatch(proposal.id)?.lifecycle).toBe("delivering");
    expect(registry.listAttention(proposal.id)).toEqual([
      expect.objectContaining({ condition: "delivery-unverified" }),
    ]);
  });

  it("treats settlement before markActive as a benign first-wins race", async () => {
    const { application, registry, herdr } = await harness();
    const proposal = await application.createProposal({
      target: "term-target",
      mode: "non-mutating",
      task: "Inspect",
      deadlineMinutes: 15,
      allowProjectDependencyInstall: false,
    });
    herdr.beforeDelivery = () => {
      registry.settle({
        dispatchId: proposal.id,
        outcome: "done",
        sanitizedResult: { summary: "result arrived first" },
        kind: "result",
        settledAt: 1_750_000_000_001,
      });
    };

    await expect(application.confirmProposal(proposal, origin)).resolves.toEqual({
      status: "already-settled",
      dispatchId: proposal.id,
      outcome: "done",
    });
  });

  it("supports one bounded explicit inspection while framing is left to the Pi adapter", async () => {
    const { application, herdr } = await harness();

    const inspected = await application.inspectAgent("Pi target", 12);

    expect(herdr.readLines).toBe(50);
    expect(inspected.target.terminalId).toBe("term-target");
    expect(inspected.text.split("\n")).toHaveLength(12);
    expect(inspected.text).toContain("line 60");
  });

  it("settles a proven not-sent delivery as failed and releases reservations", async () => {
    const { application, registry, herdr } = await harness();
    const proposal = await application.createProposal({
      target: "term-target",
      mode: "non-mutating",
      task: "Inspect",
      deadlineMinutes: 15,
      allowProjectDependencyInstall: false,
    });
    herdr.delivery = { status: "not-sent", reason: "transport-unavailable" };

    await expect(application.confirmProposal(proposal, origin)).resolves.toEqual({
      status: "failed",
      dispatchId: proposal.id,
      reason: "transport-unavailable",
    });
    expect(registry.getDispatch(proposal.id)).toEqual(
      expect.objectContaining({ lifecycle: "settled", finalOutcome: "failed" }),
    );
    expect(registry.listTargetOccupancy()).toEqual([]);
  });
});
