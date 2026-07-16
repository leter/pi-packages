import { describe, expect, it } from "vitest";

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  renderAgentsResult,
  renderConfirmationResult,
  renderDispatchResultMessage,
  renderDispatchWidget,
  renderStatusResult,
} from "../../src/pi/renderers.js";
import {
  alignColumns,
  formatAgentTable,
  formatDispatchTable,
  formatInspectionText,
  outcomeMark,
  parseResultCard,
  relativeDeadline,
  shortenId,
  shortenPath,
} from "../../src/pi/visual.js";
import type { StoredDispatch } from "../../src/registry/types.js";

const fakeTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => `<b>${text}</b>`,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

const dispatch: StoredDispatch = {
  id: "hd_view",
  originSessionId: "session_1",
  originWorkspaceId: "w1",
  targetWorkspaceId: "w1",
  targetTerminalId: "term_6569653c7869324",
  targetPaneId: "w1:p2",
  targetAgentLabel: "claude",
  targetCwd: "/repo",
  mode: "write",
  lifecycle: "active",
  task: "Do work",
  constraints: [],
  payload: "payload",
  payloadHash: "hash",
  deadlineAt: 1_000_000 + 22 * 60_000,
  createdAt: 1_000_000,
  confirmedAt: 1_000_000,
  deliveryStartedAt: 1_000_000,
  activeAt: 1_000_000,
  updatedAt: 1_000_000,
};

describe("visual vocabulary", () => {
  it("formats relative deadlines in both directions", () => {
    expect(relativeDeadline(1_000_000 + 22 * 60_000, 1_000_000)).toBe("in 22m");
    expect(relativeDeadline(1_000_000, 1_000_000 + 8 * 60_000)).toBe("8m overdue");
    expect(relativeDeadline(1_000_000 + 125 * 60_000, 1_000_000)).toBe("in 2h 05m");
  });

  it("shortens ids and home-relative paths", () => {
    expect(shortenId("term_6569653c7869324")).toBe("term_6569…9324");
    expect(shortenId("w1:p2")).toBe("w1:p2");
    expect(shortenPath("/home/user/projects/x", 40, "/home/user")).toBe("~/projects/x");
  });

  it("aligns table columns", () => {
    const lines = alignColumns([
      ["a", "bb", "c"],
      ["dddd", "e", "f"],
    ]);
    expect(lines[0]).toBe("a     bb  c");
    expect(lines[1]).toBe("dddd  e   f");
  });

  it("renders human agent and dispatch tables with teaching empty states", () => {
    expect(formatAgentTable([])).toBe(
      "No eligible Agents right now — the others are working, blocked, or occupied.\n" +
        "Agents become eligible when their status is idle or done.",
    );
    expect(formatAgentTable([
      {
        terminalId: "term_6569653c7869324",
        paneId: "w1:p2",
        workspaceId: "w1",
        agentLabel: "claude",
        cwd: "/repo",
        status: "idle",
        statusProvenance: "screen-detected",
      },
    ])).toBe("1 eligible Agent\n  ○ claude  idle ~screen  /repo  term_6569…9324");
    expect(formatDispatchTable([], () => [], 0)).toBe(
      "No unsettled dispatches.\n" +
        "Start one with /hd-new, or just ask for work to be dispatched.",
    );
    const table = formatDispatchTable(
      [dispatch],
      () => [{ condition: "overdue", details: undefined, addedAt: 0 }],
      1_000_000,
    );
    expect(table).toBe(
      "1 unsettled dispatch\n  ● claude  Do work  active  write  in 22m  ▲ overdue",
    );
  });

  it("labels human inspection output as untrusted", () => {
    const text = formatInspectionText("term_6569653c7869324", "line1\nline2");
    expect(text).toContain("2 lines");
    expect(text).toContain("untrusted");
    expect(text.endsWith("── end ──")).toBe(true);
  });

  it("parses result cards from framed content with details fallback", () => {
    const framed = `BEGIN\nnote\n${JSON.stringify({ id: "hd_1", outcome: "done", summary: "S", tests: ["t"] }, null, 2)}\nEND`;
    const card = parseResultCard(framed);
    expect(card).toMatchObject({ dispatchId: "hd_1", outcome: "done", summary: "S" });
    expect(parseResultCard("garbage", { dispatchId: "hd_2", outcome: "failed" })).toMatchObject({
      dispatchId: "hd_2",
      outcome: "failed",
    });
    expect(parseResultCard("garbage")).toBeUndefined();
  });
});

describe("themed renderers", () => {
  it("renders eligible agents with semantic status colors", () => {
    const text = renderAgentsResult(
      {
        targets: [
          {
            terminalId: "term_6569653c7869324",
            paneId: "w1:p2",
            workspaceId: "w1",
            agentLabel: "claude",
            cwd: "/repo",
            status: "idle",
            statusProvenance: "screen-detected",
          },
        ],
      },
      fakeTheme,
    );
    const rendered = text!.render(120).join("\n");
    expect(rendered).toContain("<success>○</success>");
    expect(rendered).toContain("<b>claude");
    expect(rendered).toContain("<dim>~screen</dim>");
  });

  it("renders dispatch status with attention and overdue emphasis", () => {
    const text = renderStatusResult(
      {
        dispatch,
        attention: [{ condition: "blocked-runtime", details: undefined, addedAt: 940_000 }],
        now: 1_000_000,
      },
      fakeTheme,
      false,
    );
    const rendered = text!.render(120).join("\n");
    expect(rendered).toContain("<accent>●</accent>");
    expect(rendered).toContain("<warning>▲ blocked-runtime</warning>");
    expect(rendered).toContain("deadline in 22m");
    expect(rendered).not.toContain("hd_view");
    expect(rendered).not.toContain("term_6569");
    const expanded = renderStatusResult(
      { dispatch, attention: [], now: 1_000_000 },
      fakeTheme,
      true,
    )!.render(120).join("\n");
    expect(expanded).toContain("dispatch hd_view");
    expect(expanded).toContain("terminal term_6569");
  });

  it("renders settled result cards by outcome", () => {
    expect(outcomeMark("done").color).toBe("success");
    const message = {
      content: `HEADER\n${JSON.stringify({ id: "hd_1", outcome: "failed", summary: "Broke", changedFiles: ["a.ts"] })}\nEND`,
      details: {
        dispatchId: "hd_1",
        outcome: "failed",
        agentLabel: "claude",
        taskSummary: "Fix login state",
      },
    };
    const collapsed = renderDispatchResultMessage(message, false, fakeTheme).render(120).join("\n");
    expect(collapsed).toContain("<error>✗</error>");
    expect(collapsed).toContain("Broke");
    expect(collapsed).toContain("claude failed");
    expect(collapsed).toContain("Fix login state");
    expect(collapsed).not.toContain("hd_1");
    expect(collapsed).toContain("expand for details");
    const expanded = renderDispatchResultMessage(message, true, fakeTheme).render(120).join("\n");
    expect(expanded).toContain("a.ts");
    expect(expanded).toContain("untrusted data");
    expect(expanded).toContain("dispatch hd_1");
  });

  it("renders confirmation outcomes and the widget", () => {
    const active = renderConfirmationResult(
      { status: "active", dispatchId: "hd_1" },
      fakeTheme,
    )!.render(120).join("\n");
    expect(active).toContain("<success>✓</success>");
    const widget = renderDispatchWidget(
      { delivering: 1, active: 2, attention: 1 },
      fakeTheme,
    ).render(120).join("\n");
    expect(widget).toContain("<warning>◌ 1 delivering</warning>");
    expect(widget).toContain("<accent>● 2 running</accent>");
    expect(widget).toContain("<warning>▲ 1 attention</warning>");
    const quiet = renderDispatchWidget({ delivering: 0, active: 0, attention: 0 }, fakeTheme)
      .render(120)
      .join("\n");
    expect(quiet).toContain("<dim>● 0 running</dim>");
    expect(quiet).toContain("<dim>no attention</dim>");
  });
});
