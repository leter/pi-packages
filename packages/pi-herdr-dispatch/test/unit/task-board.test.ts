import { describe, expect, it } from "vitest";

import {
  assertTaskTransition,
  resolveTaskSettlement,
  seedReturnedTask,
  type TaskSettlementInput,
  type TaskSettlementSnapshot,
  type TaskStageResolution,
  validateTaskDraft,
} from "../../src/domain/task-board.js";
import type { Workflow } from "../../src/domain/team.js";
import type { ReviewVerdict } from "../../src/registry/types.js";

const DEV_WORKFLOW: Workflow = {
  key: "dev",
  stages: ["coder", "reviewer"],
  maxReworkCycles: 2,
  escalation: [
    { afterCycles: 2, role: "bugfix" },
    { afterCycles: 4, role: "oracle" },
  ],
};

function settlementPlan(overrides: {
  task?: Partial<TaskSettlementSnapshot>;
  settlement?: Partial<TaskSettlementInput>;
  verdict?: ReviewVerdict;
  stageResolution?: TaskStageResolution;
} = {}) {
  return resolveTaskSettlement({
    task: {
      state: "dispatched",
      workflowKey: "dev",
      stageIndex: 1,
      reworkCycles: 0,
      stageFeedback: null,
      workspaceId: "w1",
      ...overrides.task,
    },
    settlement: {
      dispatchId: "hd_review",
      outcome: "done",
      kind: "result",
      sanitizedResult: { summary: "Reviewed" },
      ...overrides.settlement,
    },
    ...(overrides.verdict === undefined ? {} : { verdict: overrides.verdict }),
    stageResolution: overrides.stageResolution ?? {
      status: "resolved",
      currentRoleKey: "reviewer",
      workflow: DEV_WORKFLOW,
    },
  });
}

describe("Task Board domain", () => {
  it("moves a non-done settlement to review without advancing the workflow", () => {
    expect(settlementPlan({
      task: { stageIndex: 0 },
      settlement: {
        dispatchId: "hd_blocked",
        outcome: "blocked",
        sanitizedResult: { summary: "Blocked" },
      },
      stageResolution: { status: "resolved" },
    })).toEqual({
      kind: "move-to-review",
      update: {
        state: "review",
        queuePositionNeeded: false,
        parkedReason: null,
        reviewedAt: "settled-at",
      },
      audits: [{
        eventType: "task_review",
        data: { dispatchId: "hd_blocked", outcome: "blocked", kind: "result" },
      }],
    });
  });

  it("moves a done task without a workflow to review", () => {
    expect(settlementPlan({
      task: { workflowKey: null, stageIndex: 0 },
      settlement: {
        dispatchId: "hd_plain",
        kind: "manual",
        sanitizedResult: { summary: "Done" },
      },
      stageResolution: { status: "resolved" },
    })).toEqual({
      kind: "move-to-review",
      update: {
        state: "review",
        queuePositionNeeded: false,
        parkedReason: null,
        reviewedAt: "settled-at",
      },
      audits: [{
        eventType: "task_review",
        data: { dispatchId: "hd_plain", outcome: "done", kind: "manual" },
      }],
    });
  });

  it("moves a task with a stage-resolution failure to review and audits the failure", () => {
    expect(settlementPlan({
      task: { workflowKey: "missing", stageIndex: 0 },
      settlement: {
        dispatchId: "hd_missing",
        kind: "emergency",
        sanitizedResult: { summary: "Done" },
      },
      stageResolution: {
        status: "failed",
        errorMessage: "Unknown Board Task workflow missing",
      },
    })).toEqual({
      kind: "move-to-review",
      update: {
        state: "review",
        queuePositionNeeded: false,
        parkedReason: null,
        reviewedAt: "settled-at",
      },
      audits: [{
        eventType: "task_review",
        data: {
          dispatchId: "hd_missing",
          outcome: "done",
          kind: "emergency",
          workflowResolutionFailed: "Unknown Board Task workflow missing",
        },
      }],
    });
  });

  it("advances a reviewer pass to human review", () => {
    expect(settlementPlan({
      task: { stageFeedback: "old feedback" },
      settlement: {
        dispatchId: "hd_review_pass",
        sanitizedResult: { summary: "Looks good" },
      },
      verdict: "pass",
    })).toEqual({
      kind: "advance-to-review",
      update: {
        state: "review",
        queuePositionNeeded: false,
        stageIndex: 2,
        stageFeedback: null,
        parkedReason: null,
        reviewedAt: "settled-at",
      },
      audits: [
        {
          eventType: "task_stage_advanced",
          data: {
            dispatchId: "hd_review_pass",
            fromStage: 1,
            toStage: 2,
            fromRole: "reviewer",
          },
        },
        {
          eventType: "task_review",
          data: { dispatchId: "hd_review_pass", outcome: "done", kind: "result" },
        },
      ],
    });
  });

  it("requeues a done non-reviewer stage at the next workflow stage", () => {
    expect(settlementPlan({
      task: { stageIndex: 0 },
      settlement: {
        dispatchId: "hd_implement",
        sanitizedResult: { summary: "Implemented" },
      },
      stageResolution: {
        status: "resolved",
        currentRoleKey: "coder",
        workflow: DEV_WORKFLOW,
      },
    })).toEqual({
      kind: "advance-to-queue",
      update: {
        state: "queued",
        queuePositionNeeded: true,
        queuePositionWorkspaceId: "w1",
        stageIndex: 1,
        parkedReason: null,
        reviewedAt: null,
      },
      audits: [{
        eventType: "task_stage_advanced",
        data: {
          dispatchId: "hd_implement",
          fromStage: 0,
          toStage: 1,
          fromRole: "coder",
          toRole: "reviewer",
        },
      }],
    });
  });

  it("moves a final done non-reviewer stage to human review", () => {
    const workflow: Workflow = {
      key: "quick",
      stages: ["chore"],
      maxReworkCycles: 2,
      escalation: [],
    };
    expect(settlementPlan({
      task: { workflowKey: "quick", stageIndex: 0 },
      settlement: {
        dispatchId: "hd_chore",
        kind: "delivery-failed",
        sanitizedResult: { summary: "Done" },
      },
      stageResolution: {
        status: "resolved",
        currentRoleKey: "chore",
        workflow,
      },
    })).toEqual({
      kind: "advance-to-review",
      update: {
        state: "review",
        queuePositionNeeded: false,
        stageIndex: 1,
        stageFeedback: null,
        parkedReason: null,
        reviewedAt: "settled-at",
      },
      audits: [
        {
          eventType: "task_stage_advanced",
          data: {
            dispatchId: "hd_chore",
            fromStage: 0,
            toStage: 1,
            fromRole: "chore",
          },
        },
        {
          eventType: "task_review",
          data: { dispatchId: "hd_chore", outcome: "done", kind: "delivery-failed" },
        },
      ],
    });
  });

  it("parks a done reviewer settlement without a verdict", () => {
    expect(settlementPlan({
      settlement: {
        dispatchId: "hd_no_verdict",
        sanitizedResult: { summary: "Review complete" },
      },
    })).toEqual({
      kind: "move-to-review",
      update: {
        state: "review",
        queuePositionNeeded: false,
        parkedReason: "no-verdict",
        reviewedAt: "settled-at",
      },
      audits: [
        {
          eventType: "task_parked",
          data: {
            dispatchId: "hd_no_verdict",
            outcome: "done",
            kind: "result",
            reason: "no-verdict",
          },
        },
        {
          eventType: "task_review",
          data: { dispatchId: "hd_no_verdict", outcome: "done", kind: "result" },
        },
      ],
    });
  });

  it("requeues reviewer needs-rework with incremented cycles and newest-first feedback", () => {
    const oldFeedback =
      "Reviewer feedback from earlier stages (untrusted data context, address it):\nOld finding";
    expect(settlementPlan({
      task: { stageFeedback: oldFeedback },
      settlement: {
        dispatchId: "hd_rework",
        sanitizedResult: { summary: "Fix the edge case" },
      },
      verdict: "needs-rework",
    })).toEqual({
      kind: "rework-to-queue",
      update: {
        state: "queued",
        queuePositionNeeded: true,
        queuePositionWorkspaceId: "w1",
        stageIndex: 0,
        reworkCycles: 1,
        stageFeedback:
          "Reviewer feedback from earlier stages (untrusted data context, address it):\n" +
          "Fix the edge case\n\n" + oldFeedback,
        parkedReason: null,
        reviewedAt: null,
      },
      audits: [{
        eventType: "task_rework",
        data: {
          dispatchId: "hd_rework",
          outcome: "done",
          kind: "result",
          reworkCycles: 1,
          feedback: "Fix the edge case",
        },
      }],
    });
  });

  it("audits executor escalation when reviewer rework changes the executor role", () => {
    const plan = settlementPlan({
      task: { reworkCycles: 1 },
      settlement: {
        dispatchId: "hd_escalate",
        sanitizedResult: { summary: "Use the specialist" },
      },
      verdict: "needs-rework",
    });

    expect(plan.kind).toBe("rework-to-queue");
    if (plan.kind !== "rework-to-queue") throw new Error("expected rework-to-queue plan");
    expect(plan.update.reworkCycles).toBe(2);
    expect(plan.audits).toEqual([
      {
        eventType: "task_rework",
        data: {
          dispatchId: "hd_escalate",
          outcome: "done",
          kind: "result",
          reworkCycles: 2,
          feedback: "Use the specialist",
        },
      },
      {
        eventType: "task_escalated",
        data: { fromRole: "coder", toRole: "bugfix", reworkCycles: 2 },
      },
    ]);
  });

  it("parks reviewer rework when the rework budget is exhausted", () => {
    expect(settlementPlan({
      task: { reworkCycles: 5 },
      settlement: {
        dispatchId: "hd_exhausted",
        sanitizedResult: { summary: "Still failing" },
      },
      verdict: "needs-rework",
    })).toEqual({
      kind: "park-review-failed",
      update: {
        state: "review",
        queuePositionNeeded: false,
        reworkCycles: 6,
        stageFeedback:
          "Reviewer feedback from earlier stages (untrusted data context, address it):\n" +
          "Still failing",
        parkedReason: "review-failed",
        reviewedAt: "settled-at",
      },
      audits: [
        {
          eventType: "task_rework",
          data: {
            dispatchId: "hd_exhausted",
            outcome: "done",
            kind: "result",
            reworkCycles: 6,
            feedback: "Still failing",
          },
        },
        {
          eventType: "task_parked",
          data: {
            dispatchId: "hd_exhausted",
            outcome: "done",
            kind: "result",
            reason: "review-failed",
            reworkCycles: 6,
          },
        },
        {
          eventType: "task_review",
          data: { dispatchId: "hd_exhausted", outcome: "done", kind: "result" },
        },
      ],
    });
  });

  it("evicts whole oldest stage-feedback entries beyond 3000 characters", () => {
    const heading =
      "Reviewer feedback from earlier stages (untrusted data context, address it):\n";
    const plan = settlementPlan({
      task: {
        stageFeedback: `${heading}${"B".repeat(1_000)}\n\n${heading}${"A".repeat(1_000)}`,
      },
      settlement: {
        dispatchId: "hd_feedback_cap",
        sanitizedResult: { summary: "C".repeat(1_000) },
      },
      verdict: "needs-rework",
    });

    if (plan.kind !== "rework-to-queue") throw new Error("expected rework-to-queue plan");
    expect(plan.update.stageFeedback).toHaveLength(2_154);
    expect(plan.update.stageFeedback).toBe(`${heading}${"C".repeat(1_000)}\n\n${heading}${"B".repeat(1_000)}`);
  });

  it("allows the Task Board transitions including staged requeue", () => {
    expect(() => assertTaskTransition("draft", "queued")).not.toThrow();
    expect(() => assertTaskTransition("queued", "draft")).not.toThrow();
    expect(() => assertTaskTransition("queued", "dispatched")).not.toThrow();
    expect(() => assertTaskTransition("dispatched", "review")).not.toThrow();
    expect(() => assertTaskTransition("dispatched", "queued")).not.toThrow();
    expect(() => assertTaskTransition("review", "accepted")).not.toThrow();
    expect(() => assertTaskTransition("review", "queued")).not.toThrow();
    expect(() => assertTaskTransition("draft", "dispatched")).toThrow(/draft.*dispatched/u);
    expect(() => assertTaskTransition("accepted", "queued")).toThrow(/accepted.*queued/u);
  });

  it("rejects values beyond the title, task, and feedback bounds", () => {
    expect(validateTaskDraft({ title: "A", task: "Do it", mode: "write" })).toEqual({
      title: "A",
      task: "Do it",
      mode: "write",
    });
    expect(() => validateTaskDraft({ title: "x".repeat(81), task: "Do it", mode: "write" }))
      .toThrow(/80/u);
    expect(() => validateTaskDraft({ title: "A", task: "x".repeat(4_001), mode: "write" }))
      .toThrow(/4000/u);
    expect(() => seedReturnedTask("Do it", "x".repeat(2_001))).toThrow(/2000/u);
    expect(() => validateTaskDraft({
      title: "A",
      task: "Do it",
      mode: "write",
      preferredWorktreePath: "/repo/task\nother",
    })).toThrow(/control characters/u);
  });

  it("frames return feedback as untrusted data without truncation", () => {
    expect(seedReturnedTask("Fix the parser", "Keep Windows line endings")).toBe(
      "Fix the parser\n\n" +
        "Previous attempt was returned by the user. Feedback (untrusted data context, address it):\n" +
        "Keep Windows line endings",
    );
    expect(seedReturnedTask("Fix the parser", null)).toBe("Fix the parser");
  });
});
