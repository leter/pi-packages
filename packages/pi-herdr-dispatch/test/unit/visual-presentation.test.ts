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
  agentRow,
  alignColumns,
  dispatchRow,
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
    expect(relativeDeadline(1_000_000 + 22 * 60_000, 1_000_000)).toBe("22 分钟后");
    expect(relativeDeadline(1_000_000, 1_000_000 + 8 * 60_000)).toBe("超期 8 分钟");
    expect(relativeDeadline(1_000_000 + 125 * 60_000, 1_000_000)).toBe("2 小时 05 分后");
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

  it("aligns eligible Agent columns by CJK display width", () => {
    const table = formatAgentTable([
      {
        terminalId: "term_chinese",
        paneId: "w1:p2",
        workspaceId: "w1",
        agentLabel: "codex",
        displayName: "调度助手",
        cwd: "/repo",
        status: "idle",
        statusProvenance: "screen-detected",
      },
      {
        terminalId: "term_ascii",
        paneId: "w1:p3",
        workspaceId: "w1",
        agentLabel: "claude",
        cwd: "/repo",
        status: "idle",
        statusProvenance: "screen-detected",
      },
    ]);

    expect(table).toBe(
      "2 个可用 Agent\n" +
        "  ○ 调度助手  空闲 ~屏测  /repo  term_chinese\n" +
        "  ○ claude    空闲 ~屏测  /repo  term_ascii",
    );
  });

  it("truncates Agent display names by terminal columns", () => {
    expect(agentRow({
      terminalId: "term_chinese",
      paneId: "w1:p2",
      workspaceId: "w1",
      agentLabel: "codex",
      displayName: "调".repeat(13),
      cwd: "/repo",
      status: "idle",
      statusProvenance: "screen-detected",
    }).label).toBe("调".repeat(12));
  });

  it("truncates CJK dispatch-row cells by terminal columns", () => {
    const row = dispatchRow(
      {
        ...dispatch,
        targetAgentLabel: "调".repeat(11),
        task: "检".repeat(25),
      },
      [],
      1_000_000,
    );

    expect(row.target).toBe("调".repeat(10));
    expect(row.task).toBe("检".repeat(24));
  });

  it("aligns dispatch rows containing CJK target names and tasks", () => {
    const table = formatDispatchTable(
      [
        { ...dispatch, id: "hd_chinese", targetAgentLabel: "调度助手", task: "检查登录状态" },
        { ...dispatch, id: "hd_ascii" },
      ],
      () => [],
      1_000_000,
    );

    expect(table).toBe(
      "2 条未结算派发\n" +
        "  ● 调度助手  检查登录状态  运行中  写入  22 分钟后\n" +
        "  ● claude    Do work       运行中  写入  22 分钟后",
    );
  });

  it("renders human agent and dispatch tables with teaching empty states", () => {
    expect(formatAgentTable([])).toBe(
      "当前没有可用 Agent——其余的正在工作、受阻或已被占用。\n" +
        "Agent 的状态为空闲或完成时即成为可用 Agent。",
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
    ])).toBe("1 个可用 Agent\n  ○ claude  空闲 ~屏测  /repo  term_6569…9324");
    expect(formatDispatchTable([], () => [], 0)).toBe(
      "没有未结算的派发。\n" +
        "用 /hd-new 发起一个,或直接让模型派发工作。",
    );
    const table = formatDispatchTable(
      [dispatch],
      () => [{ condition: "overdue", details: undefined, addedAt: 0 }],
      1_000_000,
    );
    expect(table).toBe(
      "1 条未结算派发\n  ● claude  Do work  运行中  写入  22 分钟后  ▲ 已超期",
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
    expect(rendered).toContain("<dim>~屏测</dim>");
  });

  it("pads themed eligible Agent labels by CJK display width", () => {
    const rendered = renderAgentsResult(
      {
        targets: [
          {
            terminalId: "term_chinese",
            paneId: "w1:p2",
            workspaceId: "w1",
            agentLabel: "codex",
            displayName: "调度助手",
            cwd: "/repo",
            status: "idle",
            statusProvenance: "screen-detected",
          },
          {
            terminalId: "term_ascii",
            paneId: "w1:p3",
            workspaceId: "w1",
            agentLabel: "claude",
            cwd: "/repo",
            status: "idle",
            statusProvenance: "screen-detected",
          },
        ],
      },
      fakeTheme,
    )!.render(120).join("\n");

    expect(rendered).toContain("<b>调度助手</b>");
    expect(rendered).toContain("<b>claude  </b>");
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
    expect(rendered).toContain("<warning>▲ 运行时受阻</warning>");
    expect(rendered).toContain("截止 22 分钟后");
    expect(rendered).not.toContain("hd_view");
    expect(rendered).not.toContain("term_6569");
    const expanded = renderStatusResult(
      { dispatch, attention: [], now: 1_000_000 },
      fakeTheme,
      true,
    )!.render(120).join("\n");
    expect(expanded).toContain("派发 hd_view");
    expect(expanded).toContain("终端 term_6569");
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
    expect(collapsed).toContain("claude 失败");
    expect(collapsed).toContain("Fix login state");
    expect(collapsed).not.toContain("hd_1");
    expect(collapsed).toContain("展开查看详情");
    const expanded = renderDispatchResultMessage(message, true, fakeTheme).render(120).join("\n");
    expect(expanded).toContain("a.ts");
    expect(expanded).toContain("untrusted data");
    expect(expanded).toContain("派发 hd_1");
  });

  it("renders confirmation outcomes and the widget", () => {
    const active = renderConfirmationResult(
      { status: "active", dispatchId: "hd_1" },
      fakeTheme,
    )!.render(120).join("\n");
    expect(active).toContain("<success>✓</success>");
    const widget = renderDispatchWidget(
      { delivering: 1, active: 2, attention: 1, unseenDone: 1 },
      fakeTheme,
    ).render(200).join("\n");
    expect(widget).toContain("<warning>◌ 1 投递中</warning>");
    expect(widget).toContain("<accent>● 2 运行中</accent>");
    expect(widget).toContain("<warning>▲ 1 待处理</warning>");
    expect(widget).toContain("<success>✓ 1 已完成</success>");
    const quiet = renderDispatchWidget({ delivering: 0, active: 0, attention: 0, unseenDone: 0 }, fakeTheme)
      .render(200)
      .join("\n");
    expect(quiet).toContain("<dim>派发 · alt+h</dim>");
    expect(quiet).not.toContain("运行中");
  });
});
