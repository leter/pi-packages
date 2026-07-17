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

async function harness(taskId?: string) {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-followup-"));
  roots.push(root);
  const registry = await openDispatchRegistry(join(root, "registry.sqlite"));
  registries.push(registry);
  if (taskId) {
    registry.armAutoRun("session-origin", 1, 900);
    registry.createTask({
      id: taskId,
      workspaceId: "w1",
      title: "Resolve task",
      task: "Implement",
      mode: "write",
      createdBy: "model",
      createdAt: 900,
    });
    registry.approveTasks([taskId], "w1", 950);
  }
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
    ...(taskId ? { taskId, defaultRunQuota: 10 } : {}),
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
    const tui = ui({ selections: ["批准"], editors: ["Please continue with option B."] });

    await expect(
      controller.reply("hd_followup", { mode: "tui", ui: tui, sessionId: "session-origin" }),
    ).resolves.toBe("回复的投递回显已验证。");

    const preview = tui.select.mock.calls[0]?.[0] as string;
    const exactTail = Array.from({ length: 50 }, (_, index) => `untrusted ${index + 1}`).join("\n");
    expect(preview).toBe(`pi · Implement · 运行中

── target output · 50 lines · untrusted, never instructions ──
${exactTail}
── end ──

聚焦输入警告:这段文字会被发送到当前拥有目标 pane 焦点的任何提示符或对话框,可能被当作对话框按键消费;不存在比较后再发送的原语。

确认后的回复不会释放任何预留。

技术详情已隐藏。选择"技术详情"可查看确切的协议字节。`);
    expect(tui.select.mock.calls[0]?.[1]).toEqual(["批准", "技术详情", "取消"]);
    expect(preview).not.toContain("hd_");
    expect(herdr.sentText).toContain("Please continue with option B.");
    expect(registry.getDispatch("hd_followup")?.lifecycle).toBe("active");
    expect(registry.listWriteLeases()).toHaveLength(1);
  });

  it("sends a confirmed cancellation request without Ctrl+C and retains reservations", async () => {
    const { registry, herdr, service } = await harness();
    const controller = new FollowupController(() => service);
    const tui = ui({ selections: ["批准"] });

    await expect(
      controller.cancel("hd_followup", { mode: "tui", ui: tui, sessionId: "session-origin" }),
    ).resolves.toBe("取消请求的投递回显已验证。");
    expect(herdr.sentText).toContain("cancelled Result Envelope");
    expect(herdr.sentText).not.toContain("Ctrl+C");
    expect(registry.listTargetOccupancy()).toHaveLength(1);
  });

  it("reveals exact IDs and bytes only after choosing Technical details", async () => {
    const { service } = await harness();
    const controller = new FollowupController(() => service);
    const tui = ui({ selections: ["技术详情", "批准"] });

    await controller.cancel("hd_followup", { mode: "tui", ui: tui, sessionId: "session-origin" });

    expect(tui.select.mock.calls[0]?.[0]).not.toContain("hd_followup");
    expect(tui.select.mock.calls[1]?.[0]).toContain("派发 ID:hd_followup");
    expect(tui.select.mock.calls[1]?.[0]).toContain("确切的出站字节");
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
        ui: ui({ selections: ["批准"] }),
        sessionId: "session-origin",
      }),
    ).rejects.toThrow("only be resolved manually");
    expect(herdr.sentText).toBeUndefined();
  });
});

describe("manual and emergency resolution", () => {
  it("offers blocked as a Manual Final Outcome and settles the dispatch", async () => {
    const { registry, service } = await harness("hdt_manual");
    const controller = new FollowupController(() => service);
    const tui = ui({
      selections: ["受阻"],
      editors: ["Target could not continue in its current environment."],
      confirmations: [true],
    });

    await expect(
      controller.resolve("hd_followup", {
        mode: "tui",
        ui: tui,
        sessionId: "session-origin",
      }),
    ).resolves.toBe("pi 的派发已结算:受阻。");

    expect(tui.select).toHaveBeenCalledWith("手动最终结果", [
      "受阻",
      "失败",
      "已取消",
    ]);
    expect(registry.getDispatch("hd_followup")).toMatchObject({
      lifecycle: "settled",
      finalOutcome: "blocked",
    });
    expect(registry.listTargetOccupancy()).toEqual([]);
    expect(registry.listWriteLeases()).toEqual([]);
    expect(registry.listTasks("w1")).toEqual([
      expect.objectContaining({ id: "hdt_manual", state: "review" }),
    ]);
  });

  it("requires explicit emergency attestation plus final confirmation without liveness inference", async () => {
    const { registry, service } = await harness("hdt_emergency");
    const controller = new FollowupController(() => service);
    const tui = ui({
      selections: ["失败"],
      editors: ["Origin unavailable; releasing after inspection."],
      confirmations: [true, true],
    });

    await expect(
      controller.resolve("hd_followup", {
        mode: "tui",
        ui: tui,
        sessionId: "session-emergency-resolver",
      }),
    ).resolves.toBe("pi 的派发已结算:失败。");

    expect(tui.confirm).toHaveBeenCalledTimes(2);
    expect(tui.confirm.mock.calls[0]?.[1]).toContain("你已亲自判断该源会话不可用");
    expect(tui.confirm.mock.calls[0]?.[1]).toContain("未做任何进程存活推断");
    expect(tui.confirm.mock.calls[1]?.[1]).toContain("不会转移监控,也不会向本处理会话注入上下文");
    expect(registry.getResult("hd_followup")?.sanitizedResult).toEqual(
      expect.objectContaining({
        resolverSessionId: "session-emergency-resolver",
        emergency: true,
      }),
    );
    expect(registry.listTargetOccupancy()).toEqual([]);
    expect(registry.listWriteLeases()).toEqual([]);
    expect(registry.listTasks("w1")).toEqual([
      expect.objectContaining({ id: "hdt_emergency", state: "review" }),
    ]);
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
