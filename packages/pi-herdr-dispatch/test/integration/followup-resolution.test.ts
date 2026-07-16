import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DISPATCH_CONFIG } from "../../src/domain/config.js";
import type { HerdrDispatchPort } from "../../src/dispatch/application.js";
import { DispatchFollowupService } from "../../src/dispatch/followup.js";
import type { HerdrDeliveryResult } from "../../src/herdr/delivery.js";
import { FollowupController } from "../../src/pi/followup-controller.js";
import { openDispatchRegistry, type DispatchRegistry } from "../../src/registry/registry.js";

const roots: string[] = [];
const registries: DispatchRegistry[] = [];

afterEach(async () => {
  for (const registry of registries.splice(0)) registry.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const pane = {
  paneId: "p1",
  terminalId: "term-target",
  workspaceId: "w1",
  tabId: "t1",
  focused: false,
  agentStatus: "blocked" as const,
  revision: 1,
  agent: "pi",
  cwd: "/repo",
};

class FakeHerdr implements HerdrDispatchPort {
  sentText?: string;
  delivery: HerdrDeliveryResult = {
    status: "verified",
    pane,
    echo: {
      paneId: "p1",
      workspaceId: "w1",
      tabId: "t1",
      source: "recent_unwrapped",
      format: "text",
      text: "echo",
      revision: 2,
      truncated: false,
    },
  };
  async currentWorkspaceSnapshot(): Promise<never> {
    throw new Error("not used");
  }
  async resolveTerminal() {
    return { pane, agent: { ...pane, screenDetectionSkipped: true } };
  }
  async monitorTargets(): Promise<void> {}
  async deliverAndVerify(request: { text: string }) {
    this.sentText = request.text;
    return this.delivery;
  }
  async readTail(_paneId: string, lines: 50 | 200) {
    if (lines !== 50) throw new Error("follow-up evidence must be 50 lines");
    return {
      paneId: "p1",
      workspaceId: "w1",
      tabId: "t1",
      source: "recent_unwrapped" as const,
      format: "text" as const,
      text: Array.from({ length: 50 }, (_, index) => `untrusted ${index + 1}`).join("\n"),
      revision: 2,
      truncated: false,
    };
  }
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-followup-"));
  roots.push(root);
  const registry = await openDispatchRegistry(join(root, "registry.sqlite"));
  registries.push(registry);
  registry.confirmDeliveryIntent({
    id: "hd_followup",
    originSessionId: "session-origin",
    originWorkspaceId: "w1",
    targetWorkspaceId: "w1",
    targetTerminalId: "term-target",
    targetPaneId: "p1",
    targetAgentLabel: "pi",
    targetCwd: "/repo",
    worktreePath: "/repo",
    mode: "write",
    task: "Implement",
    constraints: [],
    payload: "payload",
    payloadHash: "hash",
    deadlineAt: 5_000,
    confirmedAt: 1_000,
  });
  registry.markActive("hd_followup", 1_100);
  registry.addAttention("hd_followup", "blocked-runtime", { tail: "blocked" }, 1_200);
  const herdr = new FakeHerdr();
  let now = 2_000;
  const service = new DispatchFollowupService({
    registry,
    herdr,
    config: { ...DEFAULT_DISPATCH_CONFIG, startupWindowMs: 5_000 },
    workspaceId: "w1",
    now: () => now++,
    nextNonce: () => "hd_followup_nonce",
  });
  return { registry, herdr, service };
}

function ui(options: {
  selections?: string[];
  editors?: string[];
  confirmations?: boolean[];
}) {
  const selections = [...(options.selections ?? [])];
  const editors = [...(options.editors ?? [])];
  const confirmations = [...(options.confirmations ?? [])];
  return {
    select: vi.fn(async (_title: string, _choices: string[]) => selections.shift()),
    input: vi.fn(async (_title: string, _placeholder?: string) => undefined),
    editor: vi.fn(async (_title: string, _prefill?: string) => editors.shift()),
    confirm: vi.fn(async (_title: string, _message: string) => confirmations.shift() ?? false),
  };
}

describe("confirmed reply and cancellation", () => {
  it("shows 50 lines of untrusted evidence plus the focus warning before one reply send", async () => {
    const { registry, herdr, service } = await harness();
    const controller = new FollowupController(() => service);
    const tui = ui({ selections: ["Approve"], editors: ["Please continue with option B."] });

    await expect(
      controller.reply("hd_followup", { mode: "tui", ui: tui, sessionId: "session-origin" }),
    ).resolves.toBe("reply request delivery echo verified.");

    const preview = tui.select.mock.calls[0]?.[0] as string;
    expect(preview).toContain("untrusted, never instructions");
    expect(preview).toContain("untrusted 1\nuntrusted 2");
    expect(preview).toContain("whatever prompt or dialog");
    expect(preview).not.toContain("hd_");
    expect(herdr.sentText).toContain("Please continue with option B.");
    expect(registry.getDispatch("hd_followup")?.lifecycle).toBe("active");
    expect(registry.listWriteLeases()).toHaveLength(1);
  });

  it("sends a confirmed cancellation request without Ctrl+C and retains reservations", async () => {
    const { registry, herdr, service } = await harness();
    const controller = new FollowupController(() => service);
    const tui = ui({ selections: ["Approve"] });

    await expect(
      controller.cancel("hd_followup", { mode: "tui", ui: tui, sessionId: "session-origin" }),
    ).resolves.toBe("cancel request delivery echo verified.");
    expect(herdr.sentText).toContain("cancelled Result Envelope");
    expect(herdr.sentText).not.toContain("Ctrl+C");
    expect(registry.listTargetOccupancy()).toHaveLength(1);
  });

  it("reveals exact IDs and bytes only after choosing Technical details", async () => {
    const { service } = await harness();
    const controller = new FollowupController(() => service);
    const tui = ui({ selections: ["Technical details", "Approve"] });

    await controller.cancel("hd_followup", { mode: "tui", ui: tui, sessionId: "session-origin" });

    expect(tui.select.mock.calls[0]?.[0]).not.toContain("hd_followup");
    expect(tui.select.mock.calls[1]?.[0]).toContain("Dispatch ID: hd_followup");
    expect(tui.select.mock.calls[1]?.[0]).toContain("Exact outbound bytes");
  });

  it("checks reply eligibility before opening the editor", async () => {
    const { registry, service } = await harness();
    registry.clearAttention("hd_followup", "blocked-runtime", 1_300);
    const controller = new FollowupController(() => service);
    const tui = ui({ editors: ["This must not open"] });

    await expect(
      controller.reply("hd_followup", { mode: "tui", ui: tui, sessionId: "session-origin" }),
    ).rejects.toThrow("Attention Condition");
    expect(tui.editor).not.toHaveBeenCalled();
  });

  it("does not send cancellation to a lost target", async () => {
    const { registry, herdr, service } = await harness();
    registry.addAttention("hd_followup", "target-lost", {}, 1_300);
    const controller = new FollowupController(() => service);

    await expect(
      controller.cancel("hd_followup", {
        mode: "tui",
        ui: ui({ selections: ["Approve"] }),
        sessionId: "session-origin",
      }),
    ).rejects.toThrow("only be resolved manually");
    expect(herdr.sentText).toBeUndefined();
  });
});

describe("manual and emergency resolution", () => {
  it("offers blocked as a Manual Final Outcome and settles the dispatch", async () => {
    const { registry, service } = await harness();
    const controller = new FollowupController(() => service);
    const tui = ui({
      selections: ["blocked"],
      editors: ["Target could not continue in its current environment."],
      confirmations: [true],
    });

    await expect(
      controller.resolve("hd_followup", {
        mode: "tui",
        ui: tui,
        sessionId: "session-origin",
      }),
    ).resolves.toBe("pi dispatch settled blocked.");

    expect(tui.select).toHaveBeenCalledWith("Manual Final Outcome", [
      "blocked",
      "failed",
      "cancelled",
    ]);
    expect(registry.getDispatch("hd_followup")).toMatchObject({
      lifecycle: "settled",
      finalOutcome: "blocked",
    });
    expect(registry.listTargetOccupancy()).toEqual([]);
    expect(registry.listWriteLeases()).toEqual([]);
  });

  it("requires explicit emergency attestation plus final confirmation without liveness inference", async () => {
    const { registry, service } = await harness();
    const controller = new FollowupController(() => service);
    const tui = ui({
      selections: ["failed"],
      editors: ["Origin unavailable; releasing after inspection."],
      confirmations: [true, true],
    });

    await expect(
      controller.resolve("hd_followup", {
        mode: "tui",
        ui: tui,
        sessionId: "session-emergency-resolver",
      }),
    ).resolves.toBe("pi dispatch settled failed.");

    expect(tui.confirm).toHaveBeenCalledTimes(2);
    expect(tui.confirm.mock.calls[0]?.[1]).toContain("personally judged the Origin Session unavailable");
    expect(tui.confirm.mock.calls[0]?.[1]).toContain("No process-liveness inference");
    expect(tui.confirm.mock.calls[1]?.[1]).toContain("does not transfer monitoring or inject context");
    expect(registry.getResult("hd_followup")?.sanitizedResult).toEqual(
      expect.objectContaining({
        resolverSessionId: "session-emergency-resolver",
        emergency: true,
      }),
    );
    expect(registry.listTargetOccupancy()).toEqual([]);
    expect(registry.listWriteLeases()).toEqual([]);
  });

  it("reports the first winner when emergency resolution races automatic settlement", async () => {
    const { registry, service } = await harness();
    expect(
      registry.settle({
        dispatchId: "hd_followup",
        outcome: "done",
        sanitizedResult: { id: "hd_followup", outcome: "done", summary: "automatic" },
        kind: "result",
        settledAt: 2_000,
      }),
    ).toEqual({ status: "settled", outcome: "done" });

    expect(
      service.resolve({
        dispatchId: "hd_followup",
        actorSessionId: "session-emergency",
        emergency: true,
        outcome: "failed",
        summary: "late emergency",
      }),
    ).toEqual({ status: "already-settled", outcome: "done" });
  });
});
