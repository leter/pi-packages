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
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-dispatch-task-board-"));
  cleanupPaths.push(directory);
  const registry = await openDispatchRegistry(join(directory, "registry.sqlite"), {
    busyTimeoutMs: 100,
  });
  registries.push(registry);
  return registry;
}

function intent(overrides: Partial<ConfirmDeliveryIntent> = {}): ConfirmDeliveryIntent {
  return {
    id: "hd_task_1",
    originSessionId: "session_origin",
    originWorkspaceId: "w1",
    targetWorkspaceId: "w1",
    targetTerminalId: "term_target_1",
    targetPaneId: "w1:p2",
    targetAgentLabel: "pi",
    targetCwd: "/repo/task-a",
    worktreePath: "/repo/task-a",
    mode: "write",
    task: "Implement the parser",
    constraints: [],
    payload: "[HERDR DISPATCH]\nID: hd_task_1",
    payloadHash: "sha256:task-1",
    deadlineAt: 2_000,
    confirmedAt: 1_000,
    ...overrides,
  };
}

afterEach(async () => {
  for (const registry of registries.splice(0)) registry.close();
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Task Board Registry", () => {
  it("binds a queued task while Auto Run is off without creating or consuming quota", async () => {
    const registry = await openRegistry();
    registry.createTask({
      id: "hdt_disarmed",
      workspaceId: "w1",
      title: "Daytime task",
      task: "Handle the daytime task",
      mode: "non-mutating",
      createdBy: "user",
      createdAt: 100,
    });
    registry.approveTasks(["hdt_disarmed"], "w1", 200);

    registry.confirmDeliveryIntent(intent({
      id: "hd_disarmed",
      taskId: "hdt_disarmed",
      task: "Handle the daytime task",
      mode: "non-mutating",
      worktreePath: undefined,
      targetTerminalId: "term_disarmed",
      payloadHash: "sha256:disarmed",
    }));

    expect(registry.listTasks("w1")).toEqual([
      expect.objectContaining({ id: "hdt_disarmed", state: "dispatched" }),
    ]);
    expect(registry.isAutoRunArmed("session_origin")).toBe(false);
    expect(registry.getRunQuotaState("session_origin", 10)).toEqual({
      armed: false,
      legacyDefaulted: false,
    });
  });

  it("batch-approves drafts atomically in FIFO order and batch-accepts reviews", async () => {
    const registry = await openRegistry();
    for (const [id, title] of [["hdt_a", "First"], ["hdt_b", "Second"]] as const) {
      registry.createTask({
        id,
        workspaceId: "w1",
        title,
        task: `${title} task`,
        mode: "non-mutating",
        createdBy: "model",
        createdAt: 100,
      });
    }

    registry.approveTasks(["hdt_b", "hdt_a"], "w1", 200);
    expect(registry.listTasks("w1").map((task) => [task.id, task.state, task.queuePosition]))
      .toEqual([["hdt_b", "queued", 1], ["hdt_a", "queued", 2]]);
    registry.createTask({
      id: "hdt_c",
      workspaceId: "w1",
      title: "Third",
      task: "Third task",
      mode: "non-mutating",
      createdBy: "model",
      createdAt: 250,
    });
    expect(() => registry.approveTasks(["hdt_c", "hdt_missing"], "w1", 300))
      .toThrow(RegistryStateError);
    expect(registry.listTasks("w1").find((task) => task.id === "hdt_c")?.state).toBe("draft");
  });

  it("binds queued work at depth 0, consumes quota, and refuses non-queued or exhausted work", async () => {
    const registry = await openRegistry();
    registry.createTask({
      id: "hdt_a",
      workspaceId: "w1",
      title: "Parser",
      task: "Implement the parser",
      mode: "write",
      preferredWorktreePath: "/repo/task-a",
      createdBy: "model",
      createdAt: 100,
    });
    registry.approveTasks(["hdt_a"], "w1", 200);
    registry.armAutoRun("session_origin", 1, 300);

    registry.confirmDeliveryIntent(intent({ taskId: "hdt_a", autoRunDepth: 9, defaultRunQuota: 10 }));

    expect(registry.getDispatch("hd_task_1")?.autoRunDepth).toBe(0);
    expect(registry.listTasks("w1")[0]).toMatchObject({
      state: "dispatched",
      boundDispatchId: "hd_task_1",
    });
    expect(registry.listTasks("w1")[0]).not.toHaveProperty("returnFeedback");
    expect(registry.getRunQuotaState("session_origin", 10)).toEqual({
      armed: true,
      quota: 1,
      used: 1,
      remaining: 0,
      legacyDefaulted: false,
    });

    expect(() => registry.confirmDeliveryIntent(intent({
      id: "hd_task_2",
      targetTerminalId: "term_target_2",
      taskId: "hdt_a",
      payloadHash: "sha256:task-2",
    }))).toThrow(/dispatched/u);

    registry.createTask({
      id: "hdt_b",
      workspaceId: "w1",
      title: "Second",
      task: "Second task",
      mode: "non-mutating",
      createdBy: "model",
      createdAt: 400,
    });
    registry.approveTasks(["hdt_b"], "w1", 500);
    expect(() => registry.confirmDeliveryIntent(intent({
      id: "hd_task_3",
      targetTerminalId: "term_target_3",
      taskId: "hdt_b",
      task: "Second task",
      mode: "non-mutating",
      worktreePath: undefined,
      payloadHash: "sha256:task-3",
      defaultRunQuota: 10,
    }))).toThrow(/Run Quota exhausted/u);
    expect(registry.getDispatch("hd_task_3")).toBeUndefined();
    expect(registry.listTasks("w1").find((task) => task.id === "hdt_b")?.state).toBe("queued");
  });

  it("moves every settlement to review, then returns with feedback and clears it on rebind", async () => {
    const registry = await openRegistry();
    registry.createTask({
      id: "hdt_a",
      workspaceId: "w1",
      title: "Parser",
      task: "Implement the parser",
      mode: "write",
      createdBy: "user",
      createdAt: 100,
    });
    registry.approveTasks(["hdt_a"], "w1", 200);
    registry.armAutoRun("session_origin", 2, 300);
    registry.confirmDeliveryIntent(intent({ taskId: "hdt_a", defaultRunQuota: 10 }));
    registry.settle({
      dispatchId: "hd_task_1",
      outcome: "blocked",
      sanitizedResult: { id: "hd_task_1", outcome: "blocked", summary: "Need input" },
      kind: "emergency",
      settledAt: 1_100,
    });
    expect(registry.listTasks("w1")[0]).toMatchObject({ state: "review", reviewedAt: 1_100 });

    registry.returnTask("hdt_a", "Keep Windows line endings", "w1", 1_200);
    expect(registry.listTasks("w1")[0]).toMatchObject({
      state: "queued",
      returnFeedback: "Keep Windows line endings",
      preferredWorktreePath: "/repo/task-a",
      boundDispatchId: "hd_task_1",
    });

    const seeded =
      "Implement the parser\n\n" +
      "Previous attempt was returned by the user. Feedback (untrusted data context, address it):\n" +
      "Keep Windows line endings";
    registry.confirmDeliveryIntent(intent({
      id: "hd_task_2",
      targetTerminalId: "term_target_2",
      taskId: "hdt_a",
      task: seeded,
      payloadHash: "sha256:task-2",
      confirmedAt: 1_300,
      deadlineAt: 2_300,
      defaultRunQuota: 10,
    }));
    expect(registry.listTasks("w1")[0]).toMatchObject({
      state: "dispatched",
      boundDispatchId: "hd_task_2",
    });
    expect(registry.listTasks("w1")[0]).not.toHaveProperty("returnFeedback");
  });

  it("deletes only drafts and records every task mutation in audit events", async () => {
    const registry = await openRegistry();
    registry.createTask({
      id: "hdt_delete",
      workspaceId: "w1",
      title: "Delete me",
      task: "Disposable",
      mode: "non-mutating",
      createdBy: "model",
      createdAt: 100,
    });
    registry.deleteDraft("hdt_delete", "w1", 200);
    expect(registry.listTasks("w1")).toEqual([]);
    expect(registry.listAuditEvents().map((event) => event.eventType)).toEqual([
      "task_drafted",
      "task_draft_deleted",
    ]);
  });

  it("moves result, manual, and emergency settlements to review and accepts them atomically", async () => {
    const registry = await openRegistry();
    registry.armAutoRun("session_origin", 3, 50);
    const kinds = ["result", "manual", "emergency"] as const;
    for (const [index, kind] of kinds.entries()) {
      const taskId = `hdt_${kind}`;
      const dispatchId = `hd_${kind}`;
      registry.createTask({
        id: taskId,
        workspaceId: "w1",
        title: kind,
        task: `${kind} task`,
        mode: "non-mutating",
        createdBy: "model",
        createdAt: 100 + index,
      });
      registry.approveTasks([taskId], "w1", 200 + index);
      registry.confirmDeliveryIntent(intent({
        id: dispatchId,
        taskId,
        task: `${kind} task`,
        mode: "non-mutating",
        worktreePath: undefined,
        targetTerminalId: `term_${kind}`,
        payloadHash: `sha256:${kind}`,
        confirmedAt: 300 + index,
        defaultRunQuota: 10,
      }));
      registry.settle({
        dispatchId,
        outcome: "done",
        sanitizedResult: { id: dispatchId, outcome: "done", summary: kind },
        kind,
        settledAt: 400 + index,
      });
    }
    expect(registry.listTasks("w1").map((task) => task.state)).toEqual([
      "review",
      "review",
      "review",
    ]);
    expect(() => registry.acceptTasks(["hdt_result", "hdt_missing"], "w1", 500))
      .toThrow(RegistryStateError);
    expect(registry.listTasks("w1").map((task) => task.state)).toEqual([
      "review",
      "review",
      "review",
    ]);
    registry.acceptTasks(kinds.map((kind) => `hdt_${kind}`), "w1", 600);
    expect(registry.listTasks("w1").map((task) => task.state)).toEqual([
      "accepted",
      "accepted",
      "accepted",
    ]);
    for (const kind of kinds) {
      expect(registry.getDispatch(`hd_${kind}`)).toMatchObject({ targetCwd: "/repo/task-a" });
      expect(registry.getDispatch(`hd_${kind}`)).not.toHaveProperty("resultSeenAt");
    }
  });

  it("purges accepted tasks by retention cutoff but retains unaccepted tasks and their dispatches", async () => {
    const registry = await openRegistry();
    registry.armAutoRun("session_origin", 2, 50);
    for (const [index, suffix] of ["accepted", "review"].entries()) {
      const taskId = `hdt_${suffix}`;
      const dispatchId = `hd_${suffix}`;
      registry.createTask({
        id: taskId,
        workspaceId: "w1",
        title: suffix,
        task: `${suffix} task`,
        mode: "non-mutating",
        createdBy: "model",
        createdAt: 100 + index,
      });
      registry.approveTasks([taskId], "w1", 200 + index);
      registry.confirmDeliveryIntent(intent({
        id: dispatchId,
        taskId,
        task: `${suffix} task`,
        mode: "non-mutating",
        worktreePath: undefined,
        targetTerminalId: `term_${suffix}`,
        payloadHash: `sha256:${suffix}`,
        confirmedAt: 300 + index,
        defaultRunQuota: 10,
      }));
      registry.settle({
        dispatchId,
        outcome: "done",
        sanitizedResult: { id: dispatchId, outcome: "done", summary: suffix },
        kind: "result",
        settledAt: 400 + index,
      });
    }
    registry.acceptTasks(["hdt_accepted"], "w1", 500);

    expect(registry.purgeSettledBefore(1_000, 1_100)).toBe(1);
    expect(registry.listTasks("w1")).toEqual([
      expect.objectContaining({ id: "hdt_review", state: "review" }),
    ]);
    expect(registry.getDispatch("hd_accepted")).toBeUndefined();
    expect(registry.getDispatch("hd_review")).toEqual(
      expect.objectContaining({ lifecycle: "settled" }),
    );
  });
});
