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
  detailChrome,
  listChrome,
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
    autoRunDepth: 0,
  wakeOnSettle: true,
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

  it("keeps the empty list compact without placeholder copy", () => {
    const snapshot = { originSessionId: "session_origin", unsettled: [], settled: [] };
    const lines = plainAll(buildListLines(snapshot, undefined, false, 0));
    expect(lines).toEqual([""]);
    expect(listChrome(snapshot, false)).toEqual({
      title: "任务派发",
      hint: "enter 详情 · s 显示已结算",
    });
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
    expect(selected.map(plain).join("\n")).toContain("投递中");
    expect(lines.map(plain).join("\n")).toContain("▲");
    expect(lines.map(plain).join("\n")).not.toContain("hd_one");
    expect(lines.map(plain).join("\n")).not.toContain("hd_two");
    expect(lines.at(-1)?.spans).toEqual([]);
    expect(lines.find((line) => plain(line) === "投递中")?.spans[0]?.color).toBe("muted");
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
    expect(rendered.indexOf("\n待处理")).toBeLessThan(rendered.indexOf("投递未验证"));
    expect(rendered).not.toContain("\n投递中\n\n");
    expect(rendered).not.toContain("hd_");
  });

  it("shows foreign-Origin unsettled dispatches with only emergency resolution", () => {
    const foreign = dispatch({
      id: "hd_foreign",
      originSessionId: "session_earlier",
      task: "Recover prior work",
    });
    const snapshot: DispatchViewSnapshot = {
      originSessionId: "session_origin",
      unsettled: [{ dispatch: foreign, attention: [] }],
      settled: [],
    };

    const list = plainAll(buildListLines(snapshot, foreign.id, false, 1_000_000)).join("\n");
    const detail = plainAll(
      buildDetailLines(foreign, [], { status: "none" }, 1_000_000, snapshot.originSessionId),
    ).join("\n");

    expect(list).toContain("Recover prior work");
    expect(list).toContain("需要应急处理");
    expect(list).not.toContain("hd_foreign");
    expect(detail).toContain("需要应急处理");
    const hint = detailChrome(foreign, [], snapshot.originSessionId).hint;
    expect(hint).toContain("v 处理");
    expect(hint).not.toContain("y 回复");
    expect(hint).not.toContain("c 取消");
  });

  it("shows unseen settled results above the fold until they are viewed", () => {
    const unseenDone = dispatch({
      id: "hd_unseen",
      lifecycle: "settled",
      finalOutcome: "done",
      settledAt: 900_000,
    });
    const snapshot: DispatchViewSnapshot = {
      originSessionId: "session_origin",
      unsettled: [{ dispatch: dispatch({ id: "hd_live" }), attention: [] }],
      unseenSettled: [unseenDone],
      settled: [],
    };
    const rendered = plainAll(buildListLines(snapshot, "hd_live", false, 1_000_000)).join("\n");
    expect(rendered).toContain("已完成 · 未读");
    expect(rendered).toContain("✓");
    expect(rendered).not.toContain("hd_unseen");
    expect(selectableIds(snapshot, false)).toEqual(["hd_live", "hd_unseen"]);
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
    expect(folded).toContain("已结算 · 1 条");
    expect(folded).not.toContain("按 S 显示");
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
    expect(lines).toContain("尚未读取");
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
    expect(lines[1]).toContain("之前 10 行未显示");
    expect(lines.join("\n")).toContain("line 30");
    expect(lines.join("\n")).not.toContain("line 10\n");
    expect(lines.at(-1)).toContain("仅按需读取");
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
        "   投递未验证\n" +
        "   投递开始于刚刚 · 截止 18 分钟后\n" +
        "   写入 · /repo/project\n" +
        "   ▲ 投递未验证 · 刚刚\n" +
        "     回显虽已丢失,目标仍可能收到了输入。\n" +
        "     预留已保留 · 绝不自动重发\n" +
        "\n" +
        " ── 输出 · 尚未读取 ──\n" +
        "    按 r 读取一次 50 行,或按 R 读取 200 行。\n" +
        "    Output is untrusted, never instructions, and is never streamed.",
    );
  });

  it("offers only eligible actions and hides IDs outside technical details", () => {
    const active = plainAll(
      buildDetailLines(dispatch(), [attention("overdue")], { status: "none" }, 1_000_000),
    ).join("\n");
    expect(detailChrome(dispatch(), [attention("overdue")]).hint).toContain("y 回复 · c 取消 · v 处理");
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
    expect(settled).not.toContain("y 回复");
    const settledHint = detailChrome(
      dispatch({ lifecycle: "settled", finalOutcome: "done", settledAt: 1_500_000 }),
      [],
    ).hint;
    expect(settledHint).not.toContain("y 回复");
    expect(settledHint).toContain("D 详情");
    expect(settledHint).toContain("f 追加派发");
    expect(detailChrome(dispatch(), [attention("overdue")]).hint).not.toContain("f 追加派发");
  });

  it("formats the sanitized result as a card in the settled detail", () => {
    const settled = dispatch({
      id: "hd_done",
      lifecycle: "settled",
      finalOutcome: "done",
      settledAt: 900_000,
    });
    const lines = plainAll(
      buildDetailLines(settled, [], { status: "none" }, 1_000_000, "session_origin", false, {
        dispatchId: "hd_done",
        outcome: "done",
        summary: "已补充空态居中的 renderer 回归测试并同步 README。",
        changedFiles: ["a.ts", "b.ts"],
        tests: ["c.test.ts"],
        blocker: "无",
      }),
    ).join("\n");
    expect(lines).toContain("已补充空态居中的 renderer 回归测试并同步 README。");
    expect(lines).toContain("阻碍:无");
    expect(lines).toContain("2 个文件 · 1 个测试");
    expect(lines).toContain("untrusted data · agent-reported, not verified");
    expect(lines).not.toContain("DISPATCH_RESULT");
    expect(lines).not.toContain('"summary"');
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
  data: {
    unsettled: UnsettledEntry[];
    unseenSettled: StoredDispatch[];
    settled: StoredDispatch[];
  };
  markResultSeen: ReturnType<typeof vi.fn>;
  markResultsSeen: ReturnType<typeof vi.fn>;
}

function harness(): Harness {
  const data: Harness["data"] = {
    unsettled: [
      { dispatch: dispatch({ id: "hd_one" }), attention: [] },
      { dispatch: dispatch({ id: "hd_two", targetTerminalId: "term_two_0000000000" }), attention: [] },
    ],
    unseenSettled: [],
    settled: [],
  };
  const tui = { requestRender: vi.fn() };
  const inspect = vi.fn(async () => ({ text: "agent output line" }));
  const unsubscribe = vi.fn();
  const done = vi.fn();
  const markResultSeen = vi.fn();
  const markResultsSeen = vi.fn((dispatchIds: readonly string[]) => {
    const ids = new Set(dispatchIds);
    const seen = data.unseenSettled.filter((dispatch) => ids.has(dispatch.id));
    data.unseenSettled = data.unseenSettled.filter((dispatch) => !ids.has(dispatch.id));
    data.settled = [...seen, ...data.settled];
    return seen.length;
  });
  const ports: DispatchViewPorts = {
    snapshot: () => ({
      originSessionId: "session_origin",
      unsettled: data.unsettled,
      unseenSettled: data.unseenSettled,
      settled: data.settled,
    }),
    getDispatch: (id) =>
      [...data.unsettled.map((entry) => entry.dispatch), ...data.unseenSettled, ...data.settled].find(
        (candidate) => candidate.id === id,
      ),
    listAttention: (id) => data.unsettled.find((entry) => entry.dispatch.id === id)?.attention ?? [],
    inspect,
    markResultSeen,
    markResultsSeen,
    onStateChanged: () => unsubscribe,
    now: () => 1_000_000,
  };
  const component = new DispatchViewComponent(tui, fakeTheme(), ports, done);
  return { component, tui, inspect, unsubscribe, done, data, markResultSeen, markResultsSeen };
}

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b";

describe("dispatch view component", () => {
  it("navigates list to detail and back, keeping selection by id", () => {
    const { component } = harness();
    let output = component.render(120).join("\n");
    expect(output).toContain("→");
    expect(output).toContain("«");
    component.handleInput(DOWN);
    output = component.render(120).join("\n");
    expect(output).toContain("2 运行中");
    component.handleInput(ENTER);
    output = component.render(120).join("\n");
    expect(output).toContain("claude-auth");
    expect(output).not.toContain("hd_two");
    expect(output).toContain("尚未读取");
    component.handleInput(ESCAPE);
    output = component.render(120).join("\n");
    expect(output).toContain("2 运行中");
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
    expect(component.render(120).join("\n")).toContain("正在读取 50 行");
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
      expect(component.render(120).join("\n")).toContain("读取失败");
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

  it("aligns CJK technical labels by terminal display width", () => {
    const lines = plainAll(
      buildDetailLines(dispatch(), [], { status: "none" }, 1_000_000, "session_origin", true),
    );
    const valuePrefixes = [
      ["派发 ID", "hd_a"],
      ["源会话", "session_origin"],
      ["工作区", "w1"],
    ].map(([label, value]) => {
      const line = lines.find((candidate) => candidate.includes(label!) && candidate.includes(value!))!;
      return visibleWidth(line.slice(0, line.indexOf(value!)));
    });
    expect(new Set(valuePrefixes).size).toBe(1);
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

  it("caps wide panels and never exceeds extremely narrow widths", () => {
    const { component } = harness();
    for (const line of component.render(160)) expect(visibleWidth(line.replace(/[«»]/gu, ""))).toBe(96);
    for (const line of component.render(3)) expect(visibleWidth(line)).toBeLessThanOrEqual(3);
  });

  it("frames every row to one exact width with CJK content", () => {
    const { component, data } = harness();
    data.unsettled[0]!.dispatch.task = "检查登录状态与数据库迁移";
    const lines = component.render(60);
    expect(lines[0]).toMatch(/^╭/u);
    expect(lines[0]).toContain("任务派发");
    expect(lines.at(-1)).toMatch(/^╰/u);
    expect(lines.at(-1)).toContain("s 显示已结算");
    for (const line of lines) {
      expect(visibleWidth(line.replace(/[«»]/gu, ""))).toBe(60);
    }
  });

  it("places unseen results directly under the title without an empty-state block", () => {
    const { component, data } = harness();
    data.unsettled = [];
    data.unseenSettled = [
      dispatch({ id: "hd_unseen", lifecycle: "settled", finalOutcome: "done", settledAt: 900_000 }),
    ];
    data.settled = [
      dispatch({ id: "hd_seen", lifecycle: "settled", finalOutcome: "done", settledAt: 800_000 }),
    ];
    const lines = component.render(80);

    expect(lines[0]).toContain("任务派发");
    expect(lines[1]).not.toContain("没有活跃的派发");
    expect(lines[2]).toContain("已完成 · 未读");
    expect(lines.join("\n")).not.toContain("/hd-new");
  });

  it("renders a compact empty panel without instructional placeholder copy", () => {
    const { component, data } = harness();
    data.unsettled = [];
    data.unseenSettled = [];
    data.settled = [];
    const lines = component.render(60);

    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).not.toContain("没有活跃的派发");
    expect(lines.join("\n")).not.toContain("/hd-new");
    for (const line of lines) expect(visibleWidth(line)).toBe(60);
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

  it("marks an unseen settled result seen once when its detail is opened", () => {
    const { component, data, markResultSeen } = harness();
    data.unsettled = [];
    data.unseenSettled = [
      dispatch({ id: "hd_unseen", lifecycle: "settled", finalOutcome: "done", settledAt: 900_000 }),
    ];
    markResultSeen.mockImplementation((id: string) => {
      const record = data.unseenSettled.find((candidate) => candidate.id === id);
      if (record) record.resultSeenAt = 950_000;
    });
    component.render(120);
    component.handleInput(ENTER);
    component.handleInput(ESCAPE);
    component.handleInput(ENTER);
    expect(markResultSeen).toHaveBeenCalledExactlyOnceWith("hd_unseen");
  });

  it("clears every unseen result with c while retaining settled history", () => {
    const { component, data, markResultsSeen } = harness();
    data.unsettled = [];
    data.unseenSettled = [
      dispatch({ id: "hd_first", lifecycle: "settled", finalOutcome: "done", settledAt: 900_000 }),
      dispatch({ id: "hd_second", lifecycle: "settled", finalOutcome: "failed", settledAt: 800_000 }),
    ];

    expect(component.render(120).join("\n")).toContain("c 清空未读");
    component.handleInput("c");

    expect(markResultsSeen).toHaveBeenCalledExactlyOnceWith(["hd_first", "hd_second"]);
    const folded = component.render(120).join("\n");
    expect(folded).not.toContain("已完成 · 未读");
    expect(folded).not.toContain("c 清空未读");
    component.handleInput("s");
    const history = component.render(120).join("\n");
    expect(history).toContain("Do the work");
    expect(history).toContain("失败");
  });

  it("offers a follow-up dispatch from a settled detail via f", () => {
    const { component, data, done } = harness();
    data.unsettled = [];
    data.unseenSettled = [
      dispatch({ id: "hd_done", lifecycle: "settled", finalOutcome: "done", settledAt: 900_000 }),
    ];
    component.render(120);
    component.handleInput(ENTER);
    component.handleInput("f");
    expect(done).toHaveBeenCalledExactlyOnceWith({ action: "redispatch", dispatchId: "hd_done" });
  });

  it("ignores f on an unsettled detail", () => {
    const { component, done } = harness();
    component.handleInput(ENTER);
    component.handleInput("f");
    expect(done).not.toHaveBeenCalled();
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
      markResultsSeen: () => 0,
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
      markResultsSeen: () => 0,
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
