import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  attentionNotification,
  clearDispatchWidget,
  outcomeNotification,
  updateDispatchWidget,
} from "../../src/pi/live-presentation.js";
import type { DispatchRegistry } from "../../src/registry/registry.js";

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
      "dispatches: 1 delivering · 1 active · 1 attention",
    );
    expect(presentation.setWidget).toHaveBeenCalledWith(
      "pi-herdr-dispatch",
      ["dispatches: 1 delivering · 1 active · 1 attention"],
      { placement: "belowEditor" },
    );
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
    expect(outcomeNotification("hd_1", "done").sound).toBe("done");
    expect(outcomeNotification("hd_1", "blocked").sound).toBe("request");
    expect(outcomeNotification("hd_1", "failed").sound).toBe("request");
    expect(outcomeNotification("hd_1", "cancelled").sound).toBe("none");
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
      expect(attentionNotification("hd_1", condition).sound).toBe("request");
    }
  });
});
