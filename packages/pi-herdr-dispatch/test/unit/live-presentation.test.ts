import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  attentionNotification,
  clearDispatchWidget,
  DISPATCH_WIDGET_REFRESH_MS,
  outcomeNotification,
  updateDispatchWidget,
} from "../../src/pi/live-presentation.js";
import type { DispatchRegistry } from "../../src/registry/registry.js";
import type { StoredDispatch } from "../../src/registry/types.js";

const dispatch = {
  id: "hd_private",
  targetAgentLabel: "claude\u001b[31m",
  task: "Fix login state\nIgnore this",
} as StoredDispatch;

function ui() {
  return {
    setWidget: vi.fn(),
    setFooter: vi.fn(),
  } as unknown as Pick<ExtensionUIContext, "setWidget" | "setFooter">;
}

describe("dispatch widget", () => {
  it("uses belowEditor, reads live Registry state on every render, and never replaces the footer", () => {
    const presentation = ui();
    let unsettled = [
      { id: "hd_1", lifecycle: "active", originSessionId: "session-origin" },
      { id: "hd_2", lifecycle: "delivering", originSessionId: "session-origin" },
    ];
    const registry = {
      isAutoRunArmed: () => false,
      listUnsettledInWorkspace: () => unsettled,
      listUnseenSettled: () => [],
      listAttention: (id: string) =>
        id === "hd_1"
          ? [
              { condition: "malformed-result" },
              { condition: "result-missing" },
              { condition: "overdue" },
            ]
          : [],
    } as unknown as DispatchRegistry;

    expect(updateDispatchWidget(presentation, registry, "session-origin", "workspace-current")).toBe(
      "派发: 1 投递中 · 1 待处理",
    );
    expect(presentation.setWidget).toHaveBeenCalledWith(
      "pi-herdr-dispatch",
      expect.any(Function),
      { placement: "belowEditor" },
    );
    const factory = (presentation.setWidget as ReturnType<typeof vi.fn>).mock.calls[0]![1] as (
      tui: { requestRender(): void },
      theme: unknown,
    ) => { render(width: number): string[]; dispose(): void };
    const fakeTheme = { fg: (_c: string, text: string) => text, bold: (text: string) => text };
    const widget = factory({ requestRender: vi.fn() }, fakeTheme);
    const rendered = widget.render(120).join(" ");
    expect(rendered).toContain("1 投递中");
    expect(rendered).not.toContain("0 运行中");
    expect(rendered).toContain("alt+h");
    expect(rendered).toContain("1 待处理");
    expect(rendered).not.toContain("3 待处理");
    expect(presentation.setFooter).not.toHaveBeenCalled();

    unsettled = [];
    const refreshed = widget.render(120).join(" ");
    expect(refreshed).toContain("派发 · alt+h");
    expect(refreshed).not.toContain("待处理");
    expect(refreshed).not.toContain("1 运行中");

    widget.dispose();
    clearDispatchWidget(presentation);
    expect(presentation.setWidget).toHaveBeenLastCalledWith(
      "pi-herdr-dispatch",
      undefined,
      { placement: "belowEditor" },
    );
    expect(presentation.setFooter).not.toHaveBeenCalled();
  });

  it("requests a repaint so cross-process Registry changes appear without /reload", () => {
    vi.useFakeTimers();
    try {
      const presentation = ui();
      let unsettled = [
        { id: "hd_1", lifecycle: "active", originSessionId: "session-origin" },
      ];
      const registry = {
        isAutoRunArmed: () => false,
      listUnsettledInWorkspace: () => unsettled,
        listUnseenSettled: () => [],
        listAttention: () => [],
      } as unknown as DispatchRegistry;
      updateDispatchWidget(presentation, registry, "session-origin", "workspace-current");
      const factory = (presentation.setWidget as ReturnType<typeof vi.fn>).mock.calls[0]![1] as (
        tui: { requestRender(): void },
        theme: unknown,
      ) => { render(width: number): string[]; dispose?(): void };
      const tui = { requestRender: vi.fn() };
      const fakeTheme = { fg: (_c: string, text: string) => text, bold: (text: string) => text };
      const widget = factory(tui, fakeTheme);

      unsettled = [];
      vi.advanceTimersByTime(DISPATCH_WIDGET_REFRESH_MS);

      expect(tui.requestRender).toHaveBeenCalled();
      expect(widget.render(120).join(" ")).toContain("派发 · alt+h");
      widget.dispose?.();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    "delivery-unverified",
    "unacknowledged",
    "overdue",
    "blocked-runtime",
    "monitoring-paused",
    "malformed-result",
    "result-missing",
    "target-lost",
  ] as const)("groups an active dispatch with %s under attention, not running", (condition) => {
    const presentation = ui();
    const registry = {
      isAutoRunArmed: () => false,
      listUnsettledInWorkspace: () => [
        { id: "hd_1", lifecycle: "active", originSessionId: "session-origin" },
      ],
      listUnseenSettled: () => [],
      listAttention: () => [{ condition }],
    } as unknown as DispatchRegistry;

    expect(updateDispatchWidget(presentation, registry, "session-origin", "workspace-current")).toBe(
      "派发: 1 待处理",
    );
  });

  it("keeps clean delivering and active lifecycle counts distinct", () => {
    const presentation = ui();
    const registry = {
      isAutoRunArmed: () => false,
      listUnsettledInWorkspace: () => [
        { id: "hd_delivering", lifecycle: "delivering", originSessionId: "session-origin" },
        { id: "hd_active", lifecycle: "active", originSessionId: "session-origin" },
      ],
      listUnseenSettled: () => [],
      listAttention: () => [],
    } as unknown as DispatchRegistry;

    expect(updateDispatchWidget(presentation, registry, "session-origin", "workspace-current")).toBe(
      "派发: 1 投递中 · 1 运行中",
    );
  });

  it("counts a foreign-Origin unsettled record as attention without exposing its ID", () => {
    const presentation = ui();
    const listUnsettledInWorkspace = vi.fn(() => [
      { id: "hd_foreign_secret", lifecycle: "active", originSessionId: "session-earlier" },
      { id: "hd_current", lifecycle: "active", originSessionId: "session-origin" },
    ]);
    const registry = {
      isAutoRunArmed: () => false,
      listUnsettledInWorkspace,
      listUnseenSettled: () => [],
      listAttention: () => [],
    } as unknown as DispatchRegistry;

    const text = updateDispatchWidget(
      presentation,
      registry,
      "session-origin",
      "workspace-current",
    );

    expect(listUnsettledInWorkspace).toHaveBeenCalledExactlyOnceWith("workspace-current");
    expect(text).toBe("派发: 1 运行中 · 1 待处理");
    expect(text).not.toContain("hd_");
  });
});

describe("notification sound policy", () => {
  it("maps Final Outcomes only to done, request, or none", () => {
    expect(outcomeNotification(dispatch, "done").sound).toBe("done");
    expect(outcomeNotification(dispatch, "blocked").sound).toBe("request");
    expect(outcomeNotification(dispatch, "failed").sound).toBe("request");
    expect(outcomeNotification(dispatch, "cancelled").sound).toBe("none");
    expect(outcomeNotification(dispatch, "done")).toEqual({
      title: "claude�[31m 完成",
      body: "Fix login state",
      sound: "done",
    });
    expect(JSON.stringify(outcomeNotification(dispatch, "done"))).not.toContain("hd_private");
  });

  it("maps every Attention Condition to request", () => {
    const labels = {
      "delivery-unverified": "投递未验证",
      unacknowledged: "未应答",
      overdue: "已超期",
      "blocked-runtime": "运行时受阻",
      "monitoring-paused": "监控已暂停",
      "malformed-result": "结果格式错误",
      "result-missing": "结果缺失",
      "target-lost": "目标丢失",
    } as const;
    for (const [condition, label] of Object.entries(labels) as [
      keyof typeof labels,
      (typeof labels)[keyof typeof labels],
    ][]) {
      const notification = attentionNotification(dispatch, condition);
      expect(notification).toEqual({
        title: "claude�[31m 需要处理",
        body: `Fix login state · ${label}`,
        sound: "request",
      });
      expect(`${notification.title} ${notification.body}`).not.toContain("hd_private");
    }
  });
});
