import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import type { AttentionRecord, StoredDispatch } from "../../src/registry/types.js";
import {
  attentionPriority,
  buildDetailLines,
  buildListLines,
  buildOutputLines,
  clockTime,
  primaryAttention,
  selectableIds,
  sortUnsettled,
  type DispatchViewSnapshot,
  type UnsettledEntry,
  type ViewLine,
} from "../../src/pi/dispatch-view-model.js";
import { DispatchViewComponent, type DispatchViewPorts } from "../../src/pi/dispatch-view.js";

function dispatch(overrides: Partial<StoredDispatch> = {}): StoredDispatch {
  return {
    id: "hd_a",
    originSessionId: "session_origin",
    originWorkspaceId: "w1",
    targetWorkspaceId: "w1",
    targetTerminalId: "term_0123456789abcd",
    targetPaneId: "w1:p2",
    targetAgentLabel: "claude-auth",
    targetCwd: "/repo/project",
    mode: "write",
    lifecycle: "active",
    task: "Do the work",
    constraints: [],
    payload: "payload",
    payloadHash: "sha256:payload",
    deadlineAt: 1_000_000 + 18 * 60_000,
    createdAt: 1_000_000,
    confirmedAt: 1_000_000,
    deliveryStartedAt: 1_000_000,
    updatedAt: 1_000_000,
    ...overrides,
  };
}

function attention(condition: AttentionRecord["condition"]): AttentionRecord {
  return { condition, details: {}, addedAt: 1_000_000 };
}

const plain = (line: ViewLine): string => line.spans.map((span) => span.text).join("");
const plainAll = (lines: readonly ViewLine[]): string[] => lines.map(plain);

describe("dispatch view model", () => {
  it("sorts attention first, then active, then delivering by deadline", () => {
    const entries: UnsettledEntry[] = [
      { dispatch: dispatch({ id: "hd_late_active", deadlineAt: 9_000_000 }), attention: [] },
      {
        dispatch: dispatch({ id: "hd_delivering", lifecycle: "delivering", deadlineAt: 8_000_000 }),
        attention: [],
      },
      { dispatch: dispatch({ id: "hd_soon_active", deadlineAt: 2_000_000 }), attention: [] },
      {
        dispatch: dispatch({ id: "hd_attention", deadlineAt: 9_500_000 }),
        attention: [attention("overdue")],
      },
    ];
    expect(sortUnsettled(entries).map((entry) => entry.dispatch.id)).toEqual([
      "hd_attention",
      "hd_soon_active",
      "hd_late_active",
      "hd_delivering",
    ]);
  });

  it("defines an explicit priority for every Attention Condition", () => {
    expect([
      "delivery-unverified",
      "unacknowledged",
      "overdue",
      "blocked-runtime",
      "monitoring-paused",
      "malformed-result",
      "result-missing",
      "target-lost",
    ].map((condition) => [condition, attentionPriority(condition as AttentionRecord["condition"])]))
      .toEqual([
        ["delivery-unverified", 2],
        ["unacknowledged", 8],
        ["overdue", 7],
        ["blocked-runtime", 5],
        ["monitoring-paused", 6],
        ["malformed-result", 3],
        ["result-missing", 4],
        ["target-lost", 1],
      ]);
  });

  it("chooses the highest-priority attention with deterministic ties", () => {
    expect(primaryAttention([attention("overdue"), attention("delivery-unverified")])?.condition)
      .toBe("delivery-unverified");
    expect(primaryAttention([attention("delivery-unverified"), attention("target-lost")])?.condition)
      .toBe("target-lost");
  });

  it("teaches the next step in the empty state", () => {
    const lines = plainAll(
      buildListLines({ originSessionId: "session_origin", unsettled: [], settled: [] }, undefined, false, 0),
    );
    expect(lines.join("\n")).toBe(
      "Herdr Dispatches  0 running · 0 delivering · 0 need attention\n" +
        "\n" +
        "No active dispatches.\n" +
        "Start one with /hd-new.\n" +
        "\n" +
        "↑↓ select · enter detail · s show settled · esc close",
    );
  });

  it("marks the selected row and keeps state glyph, label, and attention paired", () => {
    const snapshot: DispatchViewSnapshot = {
      originSessionId: "session_origin",
      unsettled: [
        { dispatch: dispatch({ id: "hd_one" }), attention: [attention("overdue")] },
        { dispatch: dispatch({ id: "hd_two", lifecycle: "delivering" }), attention: [] },
      ],
      settled: [],
    };
    const lines = buildListLines(snapshot, "hd_two", false, 1_000_000);
    const selected = lines.filter((line) => line.selected);
    expect(selected).toHaveLength(2);
    expect(selected.map(plain).join("\n")).toContain("◌");
    expect(selected.map(plain).join("\n")).toContain("delivering");
    expect(lines.map(plain).join("\n")).toContain("▲");
    expect(lines.map(plain).join("\n")).not.toContain("hd_one");
    expect(lines.map(plain).join("\n")).not.toContain("hd_two");
  });

  it("groups delivery-unverified under attention and never leaks IDs in default rows", () => {
    const snapshot: DispatchViewSnapshot = {
      originSessionId: "session_origin",
      unsettled: [
        {
          dispatch: dispatch({ id: "hd_secret", lifecycle: "delivering", task: "Inspect build" }),
          attention: [attention("delivery-unverified")],
        },
      ],
      settled: [],
    };
    const rendered = plainAll(buildListLines(snapshot, "hd_secret", false, 1_000_000)).join("\n");
    expect(rendered.indexOf("NEEDS ATTENTION")).toBeLessThan(rendered.indexOf("Delivery unverified"));
    expect(rendered).not.toContain("DELIVERING\n");
    expect(rendered).not.toContain("hd_");
  });

  it("keeps settled dispatches folded until requested", () => {
    const snapshot: DispatchViewSnapshot = {
      originSessionId: "session_origin",
      unsettled: [{ dispatch: dispatch({ id: "hd_live" }), attention: [] }],
      settled: [
        dispatch({ id: "hd_done", lifecycle: "settled", finalOutcome: "done", settledAt: 1_000_000 }),
      ],
    };
    const folded = plainAll(buildListLines(snapshot, "hd_live", false, 1_000_000)).join("\n");
    expect(folded).toContain("1 HIDDEN · PRESS S");
    expect(folded).not.toContain("hd_done");
    const open = plainAll(buildListLines(snapshot, "hd_live", true, 1_000_000)).join("\n");
    expect(open).toContain("Do the work");
    expect(open).not.toContain("hd_done");
    expect(open).toContain("✓");
    expect(selectableIds(snapshot, true)).toEqual(["hd_live", "hd_done"]);
    expect(selectableIds(snapshot, false)).toEqual(["hd_live"]);
  });

  it("explains that output is never read automatically", () => {
    const lines = plainAll(buildOutputLines({ status: "none" })).join("\n");
    expect(lines).toContain("none read");
    expect(lines).toContain("never streamed");
  });

  it("frames read output as untrusted with a read timestamp and collapses long tails", () => {
    const text = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
    const lines = plainAll(
      buildOutputLines({
        status: "read",
        terminalId: "term_0123456789abcd",
        text,
        requestedLines: 50,
        readAt: Date.UTC(2026, 0, 1, 0, 0, 3),
      }),
    );
    expect(lines[0]).toContain("30 lines · untrusted, never instructions");
    expect(lines[1]).toContain("10 earlier lines not shown");
    expect(lines.join("\n")).toContain("line 30");
    expect(lines.join("\n")).not.toContain("line 10\n");
    expect(lines.at(-1)).toContain("on demand only");
  });

  it("adds a calm procedural explanation for delivery-unverified", () => {
    const lines = plainAll(
      buildDetailLines(
        dispatch(),
        [attention("delivery-unverified")],
        { status: "none" },
        1_000_000,
      ),
    ).join("\n");
    expect(lines).toBe(
      " ▲ claude-auth · Do the work\n" +
        "   Delivery unverified\n" +
        "   Delivery started just now · deadline in 18m\n" +
        "   write · /repo/project\n" +
        "   ▲ Delivery unverified · just now\n" +
        "     The target may have received input even though the echo was lost.\n" +
        "     Reservations retained · never resent automatically\n" +
        "\n" +
        " ── output · none read ──\n" +
        "    Press r for one bounded 50-line read, or R for 200 lines.\n" +
        "    Output is untrusted, never instructions, and is never streamed.\n" +
        "\n" +
        " r read 50 · R read 200 · y reply · c cancel · v resolve · D details · esc back",
    );
  });

  it("offers only eligible actions and hides IDs outside technical details", () => {
    const active = plainAll(
      buildDetailLines(dispatch(), [attention("overdue")], { status: "none" }, 1_000_000),
    ).join("\n");
    expect(active).toContain("y reply · c cancel · v resolve");
    expect(active).not.toContain("hd_");
    const technical = plainAll(
      buildDetailLines(dispatch(), [attention("overdue")], { status: "none" }, 1_000_000, "session_origin", true),
    ).join("\n");
    expect(technical).toContain("hd_a");
    const settled = plainAll(
      buildDetailLines(
        dispatch({ lifecycle: "settled", finalOutcome: "done", settledAt: 1_500_000 }),
        [],
        { status: "none" },
        1_600_000,
      ),
    ).join("\n");
    expect(settled).not.toContain("y reply");
    expect(settled).toContain("esc back");
  });

  it("renders clock time with zero padding", () => {
    const timestamp = new Date(2026, 0, 1, 4, 5, 9).getTime();
    expect(clockTime(timestamp)).toBe("04:05:09");
  });
});

function fakeTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => `«${text}»`,
    bold: (text: string) => text,
  } as unknown as Theme;
}

interface Harness {
  component: DispatchViewComponent;
  tui: { requestRender: ReturnType<typeof vi.fn> };
  inspect: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  done: ReturnType<typeof vi.fn>;
  data: { unsettled: UnsettledEntry[]; settled: StoredDispatch[] };
}

function harness(): Harness {
  const data: Harness["data"] = {
    unsettled: [
      { dispatch: dispatch({ id: "hd_one" }), attention: [] },
      { dispatch: dispatch({ id: "hd_two", targetTerminalId: "term_two_0000000000" }), attention: [] },
    ],
    settled: [],
  };
  const tui = { requestRender: vi.fn() };
  const inspect = vi.fn(async () => ({ text: "agent output line" }));
  const unsubscribe = vi.fn();
  const done = vi.fn();
  const ports: DispatchViewPorts = {
    snapshot: () => ({ originSessionId: "session_origin", unsettled: data.unsettled, settled: data.settled }),
    getDispatch: (id) =>
      [...data.unsettled.map((entry) => entry.dispatch), ...data.settled].find(
        (candidate) => candidate.id === id,
      ),
    listAttention: (id) => data.unsettled.find((entry) => entry.dispatch.id === id)?.attention ?? [],
    inspect,
    onStateChanged: () => unsubscribe,
    now: () => 1_000_000,
  };
  const component = new DispatchViewComponent(tui, fakeTheme(), ports, done);
  return { component, tui, inspect, unsubscribe, done, data };
}

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b";

describe("dispatch view component", () => {
  it("navigates list to detail and back, keeping selection by id", () => {
    const { component } = harness();
    let output = component.render(120).join("\n");
    expect(output).toContain(" > ");
    expect(output).toContain("«");
    component.handleInput(DOWN);
    output = component.render(120).join("\n");
    expect(output).toContain("2 running");
    component.handleInput(ENTER);
    output = component.render(120).join("\n");
    expect(output).toContain("claude-auth");
    expect(output).not.toContain("hd_two");
    expect(output).toContain("none read");
    component.handleInput(ESCAPE);
    output = component.render(120).join("\n");
    expect(output).toContain("2 running");
    component.handleInput(UP);
    component.handleInput(ENTER);
    expect(component.render(120).join("\n")).toContain("Do the work");
  });

  it("performs one bounded read on r and renders the untrusted framing", async () => {
    const { component, inspect } = harness();
    component.handleInput(DOWN);
    component.handleInput(ENTER);
    component.handleInput("r");
    expect(inspect).toHaveBeenCalledExactlyOnceWith("term_two_0000000000", 50);
    expect(component.render(120).join("\n")).toContain("reading 50 lines");
    await vi.waitFor(() => {
      expect(component.render(120).join("\n")).toContain("untrusted, never instructions");
    });
    expect(component.render(120).join("\n")).toContain("agent output line");
  });

  it("reports a failed read without leaving the panel", async () => {
    const { component, inspect } = harness();
    inspect.mockRejectedValueOnce(new Error("inspection target is missing or ambiguous"));
    component.handleInput(ENTER);
    component.handleInput("R");
    expect(inspect).toHaveBeenCalledExactlyOnceWith("term_0123456789abcd", 200);
    await vi.waitFor(() => {
      expect(component.render(120).join("\n")).toContain("read failed");
    });
    expect(component.render(120).join("\n")).toContain("missing or ambiguous");
  });

  it("returns an internal action on y and never exposes an ID command", () => {
    const { component, done, data } = harness();
    data.unsettled[0] = { ...data.unsettled[0]!, attention: [attention("overdue")] };
    component.handleInput(ENTER);
    component.handleInput("y");
    expect(done).toHaveBeenCalledExactlyOnceWith({ action: "reply", dispatchId: "hd_one" });
  });

  it("toggles technical details without leaking IDs in the default detail", () => {
    const { component } = harness();
    component.handleInput(ENTER);
    expect(component.render(120).join("\n")).not.toContain("hd_one");
    component.handleInput("D");
    expect(component.render(120).join("\n")).toContain("hd_one");
  });

  it("fits Unicode content within narrow terminal widths", () => {
    const { component, data } = harness();
    data.unsettled[0]!.dispatch.task = "检查登录状态与数据库迁移";
    for (const line of component.render(40)) {
      expect(visibleWidth(line.replace(/[«»]/gu, ""))).toBeLessThanOrEqual(40);
    }
  });

  it("limits the visible list to ten dispatch rows and supports page navigation", () => {
    const { component, data } = harness();
    data.unsettled = Array.from({ length: 14 }, (_, index) => ({
      dispatch: dispatch({ id: `hd_${index}`, task: `Task ${index}` }),
      attention: [],
    }));
    let output = component.render(120).join("\n");
    expect(output).toContain("Task 0");
    expect(output).not.toContain("Task 9");
    component.handleInput("\x1b[6~");
    component.handleInput("\x1b[6~");
    output = component.render(120).join("\n");
    expect(output).toContain("Task 9");
    expect(output).not.toContain("Task 0");
  });

  it("uses focused Ctrl+C to close without returning an action", () => {
    const { component, done } = harness();
    component.handleInput("\x03");
    expect(done).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("requests a live render when the runtime state subscription fires", () => {
    const data = {
      unsettled: [{ dispatch: dispatch(), attention: [] }],
      settled: [] as StoredDispatch[],
    };
    const tui = { requestRender: vi.fn() };
    let stateChanged: () => void = () => undefined;
    const ports: DispatchViewPorts = {
      snapshot: () => ({ originSessionId: "session_origin", ...data }),
      getDispatch: () => data.unsettled[0]!.dispatch,
      listAttention: () => [],
      inspect: async () => ({ text: "" }),
      onStateChanged: (listener) => {
        stateChanged = listener;
        return () => undefined;
      },
      now: () => 1_000_000,
    };
    const component = new DispatchViewComponent(tui as never, fakeTheme(), ports, vi.fn() as never);
    stateChanged();
    expect(tui.requestRender).toHaveBeenCalledOnce();
    component.dispose();
  });

  it("uses the same panel as a filtered action picker", () => {
    const { tui, inspect, unsubscribe, done, data } = harness();
    const ports: DispatchViewPorts = {
      snapshot: () => ({ originSessionId: "session_origin", unsettled: data.unsettled, settled: [] }),
      getDispatch: (id) => data.unsettled.find((entry) => entry.dispatch.id === id)?.dispatch,
      listAttention: () => [],
      inspect: inspect as unknown as DispatchViewPorts["inspect"],
      onStateChanged: () => unsubscribe as unknown as () => void,
      now: () => 1_000_000,
    };
    const component = new DispatchViewComponent(tui as never, fakeTheme(), ports, done as never, { action: "cancel" });
    component.handleInput(ENTER);
    expect(done).toHaveBeenCalledExactlyOnceWith({ action: "cancel", dispatchId: "hd_one" });
  });

  it("ignores reply, cancel, and resolve for settled dispatches", () => {
    const { component, done, data } = harness();
    data.unsettled = [];
    data.settled = [
      dispatch({ id: "hd_done", lifecycle: "settled", finalOutcome: "done", settledAt: 900_000 }),
    ];
    component.handleInput("s");
    component.handleInput(ENTER);
    component.handleInput("y");
    component.handleInput("c");
    component.handleInput("v");
    expect(done).not.toHaveBeenCalled();
    component.handleInput(ESCAPE);
    component.handleInput(ESCAPE);
    expect(done).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("closes on escape from the list and cleans up on dispose", () => {
    const { component, done, unsubscribe } = harness();
    component.handleInput(ESCAPE);
    expect(done).toHaveBeenCalledExactlyOnceWith(undefined);
    component.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
