import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  attentionNotification,
  clearDispatchWidget,
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
  it("uses belowEditor and never replaces the existing custom footer", () => {
    const presentation = ui();
    const registry = {
      listUnsettled: () => [
        { id: "hd_1", lifecycle: "active" },
        { id: "hd_2", lifecycle: "delivering" },
      ],
      listAttention: (id: string) => (id === "hd_1" ? [{ condition: "overdue" }] : []),
    } as unknown as DispatchRegistry;

    expect(updateDispatchWidget(presentation, registry, "session-origin")).toBe(
      "dispatches: 1 delivering · 1 running · 1 attention",
    );
    expect(presentation.setWidget).toHaveBeenCalledWith(
      "pi-herdr-dispatch",
      expect.any(Function),
      { placement: "belowEditor" },
    );
    const factory = (presentation.setWidget as ReturnType<typeof vi.fn>).mock.calls[0]![1] as (
      tui: unknown,
      theme: unknown,
    ) => { render(width: number): string[] };
    const fakeTheme = { fg: (_c: string, text: string) => text, bold: (text: string) => text };
    const rendered = factory(undefined, fakeTheme).render(120).join(" ");
    expect(rendered).toContain("1 delivering");
    expect(rendered).toContain("1 running");
    expect(rendered).toContain("alt+h manager");
    expect(rendered).toContain("1 attention");
    expect(presentation.setFooter).not.toHaveBeenCalled();

    clearDispatchWidget(presentation);
    expect(presentation.setWidget).toHaveBeenLastCalledWith(
      "pi-herdr-dispatch",
      undefined,
      { placement: "belowEditor" },
    );
    expect(presentation.setFooter).not.toHaveBeenCalled();
  });
});

describe("notification sound policy", () => {
  it("maps Final Outcomes only to done, request, or none", () => {
    expect(outcomeNotification(dispatch, "done").sound).toBe("done");
    expect(outcomeNotification(dispatch, "blocked").sound).toBe("request");
    expect(outcomeNotification(dispatch, "failed").sound).toBe("request");
    expect(outcomeNotification(dispatch, "cancelled").sound).toBe("none");
    expect(outcomeNotification(dispatch, "done")).toMatchObject({
      title: "claude�[31m done",
      body: "Fix login state",
    });
    expect(JSON.stringify(outcomeNotification(dispatch, "done"))).not.toContain("hd_private");
  });

  it("maps every Attention Condition to request", () => {
    for (const condition of [
      "delivery-unverified",
      "unacknowledged",
      "overdue",
      "blocked-runtime",
      "monitoring-paused",
      "malformed-result",
      "result-missing",
      "target-lost",
      "target-moved",
    ] as const) {
      const notification = attentionNotification(dispatch, condition);
      expect(notification.sound).toBe("request");
      expect(`${notification.title} ${notification.body}`).not.toContain("hd_private");
    }
  });
});
