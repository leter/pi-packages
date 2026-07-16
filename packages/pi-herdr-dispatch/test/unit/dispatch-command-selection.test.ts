import { describe, expect, it } from "vitest";

import type { AttentionRecord, StoredDispatch } from "../../src/registry/types.js";
import {
  actionCandidates,
  actionIneligibility,
  dispatchCompletions,
  resolveDispatchSelector,
} from "../../src/pi/dispatch-command-selection.js";

function dispatch(overrides: Partial<StoredDispatch> = {}): StoredDispatch {
  return {
    id: "hd_alpha",
    originSessionId: "session_origin",
    originWorkspaceId: "w1",
    targetWorkspaceId: "w1",
    targetTerminalId: "term_alpha",
    targetPaneId: "w1:p2",
    targetAgentLabel: "claude",
    targetCwd: "/repo",
    mode: "non-mutating",
    lifecycle: "active",
    task: "Inspect login state",
    constraints: [],
    payload: "payload",
    payloadHash: "hash",
    deadlineAt: 2_000,
    createdAt: 1_000,
    confirmedAt: 1_000,
    deliveryStartedAt: 1_000,
    activeAt: 1_100,
    autoRunDepth: 0,
    wakeOnSettle: true,
    updatedAt: 1_100,
    ...overrides,
  };
}

const overdue: AttentionRecord = { condition: "overdue", details: {}, addedAt: 1_500 };

describe("dispatch command selection", () => {
  it("gives exact matches precedence over prefix ambiguity", () => {
    const exact = dispatch();
    const longer = dispatch({ id: "hd_alpha_more", targetTerminalId: "term_more" });
    const lookup = {
      getDispatch: (id: string) => (id === exact.id ? exact : undefined),
      listByIdPrefix: () => [exact, longer],
    };
    expect(resolveDispatchSelector(lookup, "hd_alpha")).toEqual({ status: "matched", dispatch: exact });
  });

  it("reports zero, one, and multiple prefix matches without guessing", () => {
    const first = dispatch();
    const second = dispatch({ id: "hd_alpine", targetTerminalId: "term_second" });
    const lookup = (matches: StoredDispatch[]) => ({
      getDispatch: () => undefined,
      listByIdPrefix: () => matches,
    });
    expect(resolveDispatchSelector(lookup([]), "hd_missing")).toEqual({ status: "not-found" });
    expect(resolveDispatchSelector(lookup([first]), "hd_alp")).toEqual({ status: "matched", dispatch: first });
    expect(resolveDispatchSelector(lookup([first, second]), "hd_al")).toEqual({
      status: "ambiguous",
      matches: [first, second],
    });
  });

  it("filters action candidates by origin, lifecycle, and attention", () => {
    const own = dispatch();
    const foreign = dispatch({ id: "hd_foreign", originSessionId: "session_other" });
    const attentionFor = (id: string) => (id === own.id ? [overdue] : []);
    expect(actionCandidates("reply", [own, foreign], "session_origin", attentionFor)).toEqual([own]);
    expect(actionCandidates("cancel", [own, foreign], "session_origin", attentionFor)).toEqual([own]);
    expect(actionCandidates("resolve", [own, foreign], "session_origin", attentionFor)).toEqual([own, foreign]);
  });

  it("allows only resolution after the target is lost", () => {
    const candidate = dispatch();
    const targetLost: AttentionRecord = { condition: "target-lost", details: {}, addedAt: 1_500 };
    const attentionFor = () => [targetLost];
    expect(actionCandidates("cancel", [candidate], "session_origin", attentionFor)).toEqual([]);
    expect(actionCandidates("resolve", [candidate], "session_origin", attentionFor)).toEqual([candidate]);
    expect(actionIneligibility("cancel", candidate, "session_origin", [targetLost])).toContain(
      "只能手动处理",
    );
  });

  it("reports settled and action-specific ineligibility", () => {
    expect(
      actionIneligibility(
        "cancel",
        dispatch({ lifecycle: "settled", finalOutcome: "done", settledAt: 2_000 }),
        "session_origin",
        [],
      ),
    ).toContain("该派发已结算:完成");
    expect(actionIneligibility("reply", dispatch(), "session_origin", [])).toContain("待处理状况");
  });

  it("completes canonical IDs with human-readable labels", () => {
    const candidate = dispatch();
    const completions = dispatchCompletions(
      "hd_a",
      "reply",
      [candidate],
      "session_origin",
      () => [overdue],
    );
    expect(completions).toEqual([
      {
        value: "hd_alpha",
        label: "claude · Inspect login state",
        description: "overdue",
      },
    ]);
  });
});
