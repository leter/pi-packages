import { describe, expect, it } from "vitest";

import { UI_COPY } from "../../src/pi/ui-copy.js";

describe("human UI copy catalog", () => {
  it("defines the exact state and attention vocabulary", () => {
    expect([
      UI_COPY.state.outcome("done"),
      UI_COPY.state.outcome("blocked"),
      UI_COPY.state.outcome("failed"),
      UI_COPY.state.outcome("cancelled"),
      UI_COPY.state.lifecycle("delivering"),
      UI_COPY.state.lifecycle("active"),
      UI_COPY.state.agentStatus("idle"),
      UI_COPY.state.agentStatus("done"),
      UI_COPY.state.agentStatus("working"),
      UI_COPY.state.agentStatus("blocked"),
    ]).toEqual([
      "done",
      "blocked",
      "failed",
      "cancelled",
      "delivering",
      "active",
      "idle",
      "done",
      "working",
      "blocked",
    ]);
    expect([
      "target-lost",
      "target-moved",
      "delivery-unverified",
      "malformed-result",
      "result-missing",
      "blocked-runtime",
      "monitoring-paused",
      "overdue",
      "unacknowledged",
    ].map((condition) => UI_COPY.state.attention(condition as never))).toEqual([
      "Target lost",
      "Target moved",
      "Delivery unverified",
      "Malformed result",
      "Result missing",
      "Runtime blocked",
      "Monitoring paused",
      "Overdue",
      "Unacknowledged",
    ]);
  });

  it("builds exact relative-time and pluralized count copy", () => {
    expect(UI_COPY.time.relativeDeadline(1_000_000 + 22 * 60_000, 1_000_000)).toBe("in 22m");
    expect(UI_COPY.time.relativeDeadline(1_000_000, 1_000_000 + 8 * 60_000)).toBe("8m overdue");
    expect(UI_COPY.time.relativeDeadline(1_000_000 + 125 * 60_000, 1_000_000)).toBe("in 2h 05m");
    expect(UI_COPY.time.relativeAge(1_000_000, 1_000_000)).toBe("just now");
    expect(UI_COPY.time.relativeAge(1_000_000, 1_000_000 + 125 * 60_000)).toBe("2h 05m ago");
    expect(UI_COPY.count.eligibleAgents(1)).toBe("1 eligible Agent");
    expect(UI_COPY.count.eligibleAgents(2)).toBe("2 eligible Agents");
    expect(UI_COPY.count.unsettledDispatches(1)).toBe("1 unsettled dispatch");
    expect(UI_COPY.count.unsettledDispatches(2)).toBe("2 unsettled dispatches");
    expect(UI_COPY.count.files(2)).toBe("2 files");
    expect(UI_COPY.count.tests(3)).toBe("3 tests");
  });

  it("contains exact command and Dispatch Manager messages", () => {
    expect(UI_COPY.command.description("manager")).toBe("Open the Herdr Dispatch Manager");
    expect(UI_COPY.command.chooseEligibleAgent()).toBe("Choose an Eligible Agent");
    expect(UI_COPY.command.noDispatchForAction("reply")).toBe("No dispatch currently needs a reply.");
    expect(UI_COPY.command.noDispatchForAction("cancel")).toBe(
      "No unsettled dispatch from this session can be cancelled.",
    );
    expect(UI_COPY.command.noDispatchForAction("resolve")).toBe(
      "No dispatch currently requires manual resolution.",
    );
    expect(UI_COPY.manager.heading(2, 1, 3)).toBe(
      "  2 running · 1 delivering · 3 need attention",
    );
    expect(UI_COPY.manager.settledHeading(2, false)).toBe("SETTLED · 2 HIDDEN · PRESS S");
    expect(UI_COPY.manager.settledHeading(2, true)).toBe("SETTLED · LAST 2");
    expect(UI_COPY.manager.listKeybar(false)).toBe(
      "↑↓ select · enter detail · s show settled · esc close",
    );
    expect(UI_COPY.manager.technicalLabel("workspace")).toBe("Workspace");
  });

  it("contains exact human renderer, notification, and follow-up copy", () => {
    expect(UI_COPY.presentation.noEligibleAgents()).toBe(
      "No eligible Agents right now — the others are working, blocked, or occupied.",
    );
    expect(UI_COPY.presentation.dispatchActive()).toBe("dispatch active");
    expect(UI_COPY.presentation.deliveryEchoVerified()).toBe("· delivery echo verified");
    expect(UI_COPY.presentation.resultCounts(2, 3)).toBe("2 files · 3 tests (expand for details)");
    expect(UI_COPY.notification.outcomeTitle("claude", "done")).toBe("claude done");
    expect(UI_COPY.notification.attentionTitle("claude")).toBe("claude needs attention");
    expect(UI_COPY.followup.replyCancelled()).toBe("Reply cancelled.");
    expect(UI_COPY.followup.deliveryVerified("reply")).toBe(
      "reply request delivery echo verified.",
    );
    expect(UI_COPY.followup.settled("claude", "blocked")).toBe(
      "claude dispatch settled blocked.",
    );
  });
});
