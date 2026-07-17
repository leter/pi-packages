import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import type { HerdrNotification } from "../herdr/adapter.js";
import type { DispatchRegistry } from "../registry/registry.js";
import type { AttentionCondition, FinalOutcome } from "../registry/types.js";
import { renderDispatchWidget } from "./renderers.js";
import { agentDisplayName, attentionLabel, taskSummary } from "./dispatch-view-model.js";
import type { StoredDispatch } from "../registry/types.js";
import { UI_COPY } from "./ui-copy.js";

export const DISPATCH_WIDGET_KEY = "pi-herdr-dispatch";
export const DISPATCH_WIDGET_REFRESH_MS = 1_000;

export function updateDispatchWidget(
  ui: Pick<ExtensionUIContext, "setWidget">,
  registry: DispatchRegistry,
  originSessionId: string,
  targetWorkspaceId: string,
): string {
  const counts = readWidgetCounts(registry, originSessionId, targetWorkspaceId);
  const text = UI_COPY.presentation.widget(counts).plain;
  ui.setWidget(
    DISPATCH_WIDGET_KEY,
    (tui, theme) => {
      const refreshTimer = setInterval(() => tui.requestRender(), DISPATCH_WIDGET_REFRESH_MS);
      refreshTimer.unref();
      return {
        render(width: number): string[] {
          return renderDispatchWidget(
            readWidgetCounts(registry, originSessionId, targetWorkspaceId),
            theme,
          ).render(width);
        },
        invalidate(): void {},
        dispose(): void {
          clearInterval(refreshTimer);
        },
      };
    },
    { placement: "belowEditor" },
  );
  return text;
}

function readWidgetCounts(
  registry: DispatchRegistry,
  originSessionId: string,
  targetWorkspaceId: string,
) {
  const entries = registry.listUnsettledInWorkspace(targetWorkspaceId).map((dispatch) => ({
    dispatch,
    needsAttention:
      dispatch.originSessionId !== originSessionId || registry.listAttention(dispatch.id).length > 0,
  }));
  const tasks = registry.listTasks?.(targetWorkspaceId) ?? [];
  return {
    draftTasks: tasks.filter((task) => task.state === "draft").length,
    reviewTasks: tasks.filter((task) => task.state === "review").length,
    delivering: entries.filter(
      ({ dispatch, needsAttention }) =>
        dispatch.lifecycle === "delivering" && !needsAttention,
    ).length,
    active: entries.filter(
      ({ dispatch, needsAttention }) => dispatch.lifecycle === "active" && !needsAttention,
    ).length,
    attention: entries.filter(({ needsAttention }) => needsAttention).length,
    unseenDone: registry.listUnseenSettled(targetWorkspaceId).length,
    autoRunArmed: registry.isAutoRunArmed(originSessionId),
  };
}

export function clearDispatchWidget(ui: Pick<ExtensionUIContext, "setWidget">): void {
  ui.setWidget(DISPATCH_WIDGET_KEY, undefined, { placement: "belowEditor" });
}

export function outcomeNotification(
  dispatch: StoredDispatch,
  outcome: FinalOutcome,
): HerdrNotification {
  return {
    title: UI_COPY.notification.outcomeTitle(agentDisplayName(dispatch), outcome),
    body: taskSummary(dispatch.task, 100),
    sound: outcome === "done" ? "done" : outcome === "cancelled" ? "none" : "request",
  };
}

export function attentionNotification(
  dispatch: StoredDispatch,
  condition: AttentionCondition,
): HerdrNotification {
  return {
    title: UI_COPY.notification.attentionTitle(agentDisplayName(dispatch)),
    body: UI_COPY.notification.attentionBody(
      taskSummary(dispatch.task, 80),
      attentionLabel(condition),
    ),
    sound: "request",
  };
}
