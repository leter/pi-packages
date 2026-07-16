import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import type { HerdrNotification } from "../herdr/adapter.js";
import type { DispatchRegistry } from "../registry/registry.js";
import type { AttentionCondition, FinalOutcome } from "../registry/types.js";
import { renderDispatchWidget } from "./renderers.js";
import { agentDisplayName, attentionLabel, taskSummary } from "./dispatch-view-model.js";
import type { StoredDispatch } from "../registry/types.js";

export const DISPATCH_WIDGET_KEY = "pi-herdr-dispatch";

export function updateDispatchWidget(
  ui: Pick<ExtensionUIContext, "setWidget">,
  registry: DispatchRegistry,
  originSessionId: string,
): string {
  const dispatches = registry.listUnsettled(originSessionId);
  const counts = {
    delivering: dispatches.filter((dispatch) => dispatch.lifecycle === "delivering").length,
    active: dispatches.filter((dispatch) => dispatch.lifecycle === "active").length,
    attention: dispatches.reduce(
      (total, dispatch) => total + registry.listAttention(dispatch.id).length,
      0,
    ),
  };
  const segments = [
    counts.delivering > 0 ? `${counts.delivering} delivering` : undefined,
    `${counts.active} running`,
    `${counts.attention} attention`,
  ].filter((segment): segment is string => segment !== undefined);
  const text = `dispatches: ${segments.join(" · ")}`;
  ui.setWidget(DISPATCH_WIDGET_KEY, (_tui, theme) => renderDispatchWidget(counts, theme), {
    placement: "belowEditor",
  });
  return text;
}

export function clearDispatchWidget(ui: Pick<ExtensionUIContext, "setWidget">): void {
  ui.setWidget(DISPATCH_WIDGET_KEY, undefined, { placement: "belowEditor" });
}

export function outcomeNotification(
  dispatch: StoredDispatch,
  outcome: FinalOutcome,
): HerdrNotification {
  return {
    title: `${agentDisplayName(dispatch)} ${outcome}`,
    body: taskSummary(dispatch.task, 100),
    sound: outcome === "done" ? "done" : outcome === "cancelled" ? "none" : "request",
  };
}

export function attentionNotification(
  dispatch: StoredDispatch,
  condition: AttentionCondition,
): HerdrNotification {
  return {
    title: `${agentDisplayName(dispatch)} needs attention`,
    body: `${taskSummary(dispatch.task, 80)} · ${attentionLabel(condition)}`,
    sound: "request",
  };
}
