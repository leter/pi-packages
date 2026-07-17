import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_TEAM_CATALOG, parseTeamConfig } from "../../src/domain/team.js";
import {
  openDispatchRegistry,
  RegistryStateError,
  type DispatchRegistry,
} from "../../src/registry/registry.js";
import type { ConfirmDeliveryIntent, ReviewVerdict } from "../../src/registry/types.js";

const cleanupPaths: string[] = [];
const registries: DispatchRegistry[] = [];

async function openRegistry(): Promise<DispatchRegistry> {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-roles-workflows-"));
  cleanupPaths.push(directory);
  const registry = await openDispatchRegistry(join(directory, "registry.sqlite"), {
    busyTimeoutMs: 100,
  });
  registries.push(registry);
  return registry;
}

function createDevTask(registry: DispatchRegistry, id = "hdt_dev"): void {
  registry.createTask({
    id,
    workspaceId: "w1",
    title: "Parser",
    task: "Implement the parser",
    mode: "write",
    role: "coder",
    createdBy: "model",
    createdAt: 100,
  });
  registry.approveTasks([id], "w1", 200);
}

function bindCurrent(
  registry: DispatchRegistry,
  taskId: string,
  dispatchId: string,
  confirmedAt: number,
): ReturnType<DispatchRegistry["prepareTaskDispatch"]> {
  const prepared = registry.prepareTaskDispatch(taskId);
  const intent: ConfirmDeliveryIntent = {
    id: dispatchId,
    originSessionId: "session_origin",
    originWorkspaceId: "w1",
    targetWorkspaceId: "w1",
    targetTerminalId: `term_${dispatchId}`,
    targetPaneId: `w1:${dispatchId}`,
    targetAgentLabel: prepared.roleKey ?? "pi",
    targetCwd: "/repo/task-a",
    ...(prepared.stageMode === "write" ? { worktreePath: "/repo/task-a" } : {}),
    mode: prepared.stageMode,
    task: prepared.task,
    constraints: [],
    payload: `[HERDR DISPATCH]\nID: ${dispatchId}`,
    payloadHash: `sha256:${dispatchId}`,
    deadlineAt: confirmedAt + 1_000,
    confirmedAt,
    taskId,
  };
  registry.confirmDeliveryIntent(intent);
  return prepared;
}

function settle(
  registry: DispatchRegistry,
  dispatchId: string,
  settledAt: number,
  options: {
    outcome?: "done" | "blocked" | "failed" | "cancelled";
    verdict?: ReviewVerdict;
    kind?: "result" | "manual" | "emergency";
    summary?: string;
  } = {},
): void {
  const outcome = options.outcome ?? "done";
  registry.settle({
    dispatchId,
    outcome,
    sanitizedResult: {
      id: dispatchId,
      outcome,
      summary: options.summary ?? `Summary for ${dispatchId}`,
      ...(options.verdict === undefined ? {} : { verdict: options.verdict }),
    },
    kind: options.kind ?? "result",
    settledAt,
  });
}

function completeReviewCycle(
  registry: DispatchRegistry,
  taskId: string,
  cycle: number,
  verdict: ReviewVerdict = "needs-rework",
  summary = `Review cycle ${cycle} needs attention`,
): void {
  const implementId = `hd_implement_${cycle}`;
  const reviewId = `hd_review_${cycle}`;
  bindCurrent(registry, taskId, implementId, 1_000 + cycle * 100);
  settle(registry, implementId, 1_010 + cycle * 100);
  bindCurrent(registry, taskId, reviewId, 1_020 + cycle * 100);
  settle(registry, reviewId, 1_030 + cycle * 100, {
    verdict,
    summary,
  });
}

afterEach(async () => {
  for (const registry of registries.splice(0)) registry.close();
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Board Task roles and staged workflows", () => {
  it("defaults coder to dev, advances to reviewer, then passes to human review", async () => {
    const registry = await openRegistry();
    createDevTask(registry);

    const implement = bindCurrent(registry, "hdt_dev", "hd_implement", 300);
    expect(implement).toMatchObject({ roleKey: "coder", reviewerStage: false });
    expect(implement.task).toMatch(/^Role: .*implementation specialist/u);
    expect(implement.task.indexOf("Role:")).toBeLessThan(implement.task.indexOf("Implement the parser"));
    settle(registry, "hd_implement", 400);

    expect(registry.getTask("hdt_dev")).toMatchObject({
      role: "coder",
      workflow: "dev",
      state: "queued",
      stageIndex: 1,
      reworkCycles: 0,
    });
    const reviewer = bindCurrent(registry, "hdt_dev", "hd_reviewer", 500);
    expect(reviewer).toMatchObject({ roleKey: "reviewer", reviewerStage: true });
    settle(registry, "hd_reviewer", 600, { verdict: "pass" });

    expect(registry.getTask("hdt_dev")).toMatchObject({
      state: "review",
      stageIndex: 2,
      reviewedAt: 600,
    });
    expect(registry.getTask("hdt_dev")).not.toHaveProperty("stageFeedback");
    expect(registry.getResult("hd_reviewer")?.verdict).toBe("pass");
    expect(registry.listAuditEvents().map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["task_stage_advanced", "task_review"]),
    );
  });

  it("dispatches later stages under the stage role's mode and refuses the task mode", async () => {
    const registry = await openRegistry();
    createDevTask(registry);
    bindCurrent(registry, "hdt_dev", "hd_implement", 300);
    settle(registry, "hd_implement", 400);

    const prepared = registry.prepareTaskDispatch("hdt_dev");
    expect(prepared.stageMode).toBe("non-mutating");
    expect(() =>
      registry.confirmDeliveryIntent({
        id: "hd_reviewer_write",
        originSessionId: "session_origin",
        originWorkspaceId: "w1",
        targetWorkspaceId: "w1",
        targetTerminalId: "term_hd_reviewer_write",
        targetPaneId: "w1:hd_reviewer_write",
        targetAgentLabel: "reviewer",
        targetCwd: "/repo/task-a",
        worktreePath: "/repo/task-a",
        mode: "write",
        task: prepared.task,
        constraints: [],
        payload: "[HERDR DISPATCH]\nID: hd_reviewer_write",
        payloadHash: "sha256:hd_reviewer_write",
        deadlineAt: 1_500,
        confirmedAt: 500,
        taskId: "hdt_dev",
      }),
    ).toThrow(/current stage requires mode non-mutating/u);
    expect(registry.getTask("hdt_dev")).toMatchObject({ state: "queued", stageIndex: 1 });
  });

  it("requeues reviewer rework with framed feedback retained across bind", async () => {
    const registry = await openRegistry();
    createDevTask(registry);
    completeReviewCycle(registry, "hdt_dev", 1);

    const rework = registry.getTask("hdt_dev")!;
    expect(rework).toMatchObject({ state: "queued", stageIndex: 0, reworkCycles: 1 });
    expect(rework.stageFeedback).toBe(
      "Reviewer feedback from earlier stages (untrusted data context, address it):\n" +
        "Review cycle 1 needs attention",
    );
    const prepared = bindCurrent(registry, "hdt_dev", "hd_rework_bind", 2_000);
    expect(prepared.task).toMatch(
      /^Role: .*implementation specialist[\s\S]*Implement the parser[\s\S]*Reviewer feedback from earlier stages \(untrusted data context, address it\):/u,
    );
    expect(registry.getTask("hdt_dev")?.stageFeedback).toBe(rework.stageFeedback);
  });

  it("audits escalation to bugfix at cycle 2", async () => {
    const registry = await openRegistry();
    createDevTask(registry);
    completeReviewCycle(registry, "hdt_dev", 1);
    completeReviewCycle(registry, "hdt_dev", 2);

    expect(registry.getTask("hdt_dev")).toMatchObject({
      state: "queued",
      stageIndex: 0,
      reworkCycles: 2,
    });
    expect(registry.prepareTaskDispatch("hdt_dev")).toMatchObject({ roleKey: "bugfix" });
    expect(registry.listAuditEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "task_escalated",
        data: expect.objectContaining({
          taskId: "hdt_dev",
          fromRole: "coder",
          toRole: "bugfix",
          reworkCycles: 2,
        }),
      }),
    ]));
  });

  it("parks at review-failed after the escalation chain and budget are exhausted", async () => {
    const registry = await openRegistry();
    createDevTask(registry);
    for (let cycle = 1; cycle <= 6; cycle += 1) {
      completeReviewCycle(registry, "hdt_dev", cycle);
    }

    const task = registry.getTask("hdt_dev")!;
    expect(task).toMatchObject({
      state: "review",
      stageIndex: 1,
      reworkCycles: 6,
      parkedReason: "review-failed",
    });
    expect(task.stageFeedback).toContain("Review cycle 6 needs attention");
    expect(registry.listAuditEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "task_parked",
        data: expect.objectContaining({ reason: "review-failed", reworkCycles: 6 }),
      }),
    ]));
  });

  it("parks a reviewer stage with no verdict and leaves its stage unchanged", async () => {
    const registry = await openRegistry();
    createDevTask(registry);
    bindCurrent(registry, "hdt_dev", "hd_implement", 300);
    settle(registry, "hd_implement", 400);
    bindCurrent(registry, "hdt_dev", "hd_reviewer", 500);
    settle(registry, "hd_reviewer", 600);

    expect(registry.getTask("hdt_dev")).toMatchObject({
      state: "review",
      stageIndex: 1,
      reworkCycles: 0,
      parkedReason: "no-verdict",
    });
    registry.returnTask("hdt_dev", "Please rerun the workflow", "w1", 700);
    expect(registry.getTask("hdt_dev")).toMatchObject({
      state: "queued",
      stageIndex: 0,
      reworkCycles: 0,
      returnFeedback: "Please rerun the workflow",
    });
    expect(registry.getTask("hdt_dev")).not.toHaveProperty("parkedReason");
  });

  it("evicts whole oldest feedback entries beyond 3000 characters", async () => {
    const registry = await openRegistry();
    createDevTask(registry);
    completeReviewCycle(registry, "hdt_dev", 1, "needs-rework", "A".repeat(1_000));
    completeReviewCycle(registry, "hdt_dev", 2, "needs-rework", "B".repeat(1_000));
    completeReviewCycle(registry, "hdt_dev", 3, "needs-rework", "C".repeat(1_000));

    const feedback = registry.getTask("hdt_dev")?.stageFeedback ?? "";
    expect(feedback.length).toBeLessThanOrEqual(3_000);
    expect(feedback.indexOf("C".repeat(20))).toBeLessThan(feedback.indexOf("B".repeat(20)));
    expect(feedback).not.toContain("A".repeat(20));
    expect(feedback.match(/Reviewer feedback from earlier stages/g)).toHaveLength(2);
  });

  it.each(["result", "manual", "emergency"] as const)(
    "advances a done non-review stage through the %s settlement path",
    async (kind) => {
      const registry = await openRegistry();
      const taskId = `hdt_advance_${kind}`;
      const dispatchId = `hd_advance_${kind}`;
      createDevTask(registry, taskId);
      bindCurrent(registry, taskId, dispatchId, 300);
      settle(registry, dispatchId, 400, { kind });
      expect(registry.getTask(taskId)).toMatchObject({ state: "queued", stageIndex: 1 });
    },
  );

  it.each(["result", "manual", "emergency"] as const)(
    "parks a non-done %s settlement for the human without advancing",
    async (kind) => {
      const registry = await openRegistry();
      const taskId = `hdt_${kind}`;
      const dispatchId = `hd_${kind}`;
      createDevTask(registry, taskId);
      bindCurrent(registry, taskId, dispatchId, 300);
      settle(registry, dispatchId, 400, { outcome: "blocked", kind });
      expect(registry.getTask(taskId)).toMatchObject({
        state: "review",
        stageIndex: 0,
        reworkCycles: 0,
      });
      expect(registry.getTask(taskId)).not.toHaveProperty("parkedReason");
    },
  );

  it("refuses a bind when a stored catalog key has vanished", async () => {
    const registry = await openRegistry();
    registry.setTeamConfigState({
      status: "ready",
      team: parseTeamConfig({
        roles: {
          specialist: {
            label: "专员",
            mode: "non-mutating",
            brief: "Act as the specialist for this bounded task.",
          },
        },
      }),
    });
    registry.createTask({
      id: "hdt_specialist",
      workspaceId: "w1",
      title: "Specialist",
      task: "Inspect the specialist case",
      mode: "non-mutating",
      role: "specialist",
      createdBy: "model",
      createdAt: 100,
    });
    registry.approveTasks(["hdt_specialist"], "w1", 200);
    registry.setTeamConfigState({ status: "ready", team: DEFAULT_TEAM_CATALOG });

    expect(() => registry.prepareTaskDispatch("hdt_specialist"))
      .toThrow(/role specialist/u);
    expect(() => registry.confirmDeliveryIntent({
      id: "hd_specialist",
      originSessionId: "session_origin",
      originWorkspaceId: "w1",
      targetWorkspaceId: "w1",
      targetTerminalId: "term_specialist",
      targetPaneId: "w1:p2",
      targetAgentLabel: "specialist",
      targetCwd: "/repo",
      mode: "non-mutating",
      task: "Inspect the specialist case",
      constraints: [],
      payload: "payload",
      payloadHash: "hash",
      deadlineAt: 2_000,
      confirmedAt: 1_000,
      taskId: "hdt_specialist",
    })).toThrow(/role specialist/u);
    expect(registry.getTask("hdt_specialist")?.state).toBe("queued");
  });

  it("invalid team config blocks only role/workflow tasks", async () => {
    const registry = await openRegistry();
    createDevTask(registry, "hdt_role");
    registry.setTeamConfigState({ status: "invalid", reason: "broken team.json" });
    registry.createTask({
      id: "hdt_plain",
      workspaceId: "w1",
      title: "Plain",
      task: "Inspect the plain case",
      mode: "non-mutating",
      createdBy: "user",
      createdAt: 300,
    });
    registry.approveTasks(["hdt_plain"], "w1", 400);
    expect(() => bindCurrent(registry, "hdt_plain", "hd_plain", 500)).not.toThrow();
    expect(() => registry.prepareTaskDispatch("hdt_role"))
      .toThrowError(RegistryStateError);
    expect(() => registry.createTask({
      id: "hdt_blocked",
      workspaceId: "w1",
      title: "Blocked",
      task: "Role task",
      mode: "write",
      role: "coder",
      createdBy: "model",
      createdAt: 600,
    })).toThrow(/Team catalog is invalid/u);
  });
});
