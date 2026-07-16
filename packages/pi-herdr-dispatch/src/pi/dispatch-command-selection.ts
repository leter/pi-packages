import type { AutocompleteItem } from "@earendil-works/pi-tui";

import type { AttentionRecord, StoredDispatch } from "../registry/types.js";
import {
  agentDisplayName,
  availableActions,
  primaryAttention,
  taskSummary,
  type DispatchAction,
} from "./dispatch-view-model.js";
import { UI_COPY } from "./ui-copy.js";

export interface DispatchSelectorLookup {
  getDispatch(id: string): StoredDispatch | undefined;
  listByIdPrefix(prefix: string): readonly StoredDispatch[];
}

export type DispatchSelectorResolution =
  | { status: "not-found" }
  | { status: "matched"; dispatch: StoredDispatch }
  | { status: "ambiguous"; matches: readonly StoredDispatch[] };

export function resolveDispatchSelector(
  lookup: DispatchSelectorLookup,
  selector: string,
): DispatchSelectorResolution {
  if (!/^hd_[A-Za-z0-9_-]+$/u.test(selector)) {
    throw new Error(UI_COPY.command.invalidDispatchSelector());
  }
  const exact = lookup.getDispatch(selector);
  if (exact) return { status: "matched", dispatch: exact };
  const matches = lookup.listByIdPrefix(selector);
  if (matches.length === 0) return { status: "not-found" };
  if (matches.length === 1) return { status: "matched", dispatch: matches[0]! };
  return { status: "ambiguous", matches };
}

export function actionCandidates(
  action: DispatchAction,
  dispatches: readonly StoredDispatch[],
  originSessionId: string,
  attentionFor: (dispatchId: string) => readonly AttentionRecord[],
): StoredDispatch[] {
  return dispatches.filter((dispatch) =>
    availableActions(dispatch, attentionFor(dispatch.id), originSessionId).includes(action),
  );
}

export function actionIneligibility(
  action: DispatchAction,
  dispatch: StoredDispatch,
  originSessionId: string,
  attention: readonly AttentionRecord[],
): string | undefined {
  if (dispatch.lifecycle === "settled") {
    return UI_COPY.command.alreadySettled(dispatch.finalOutcome);
  }
  if (dispatch.originSessionId !== originSessionId && action !== "resolve") {
    return UI_COPY.command.originOnlyFollowup();
  }
  if (
    action !== "resolve" &&
    attention.some((record) => record.condition === "target-lost" || record.condition === "target-moved")
  ) {
    return UI_COPY.command.lostOrMovedResolutionOnly();
  }
  if (action === "reply" && dispatch.lifecycle !== "active") {
    return UI_COPY.command.replyRequiresActive();
  }
  if (action === "reply" && attention.length === 0) {
    return UI_COPY.command.replyRequiresAttention();
  }
  return undefined;
}

export function dispatchChoiceLabel(dispatch: StoredDispatch): string {
  const state = dispatch.lifecycle === "settled"
    ? UI_COPY.state.outcome(dispatch.finalOutcome ?? "settled")
    : UI_COPY.state.lifecycle(dispatch.lifecycle);
  return `${agentDisplayName(dispatch)} · ${taskSummary(dispatch.task, 56)} · ${state} · ${new Date(
    dispatch.createdAt,
  ).toISOString()}`;
}

export function dispatchCompletions(
  prefix: string,
  action: DispatchAction,
  dispatches: readonly StoredDispatch[],
  originSessionId: string,
  attentionFor: (dispatchId: string) => readonly AttentionRecord[],
): AutocompleteItem[] | null {
  const items = actionCandidates(action, dispatches, originSessionId, attentionFor)
    .filter((dispatch) => dispatch.id.startsWith(prefix))
    .map((dispatch) => {
      const attention = primaryAttention(attentionFor(dispatch.id));
      return {
        value: dispatch.id,
        label: `${agentDisplayName(dispatch)} · ${taskSummary(dispatch.task, 56)}`,
        description: attention?.condition ?? dispatch.lifecycle,
      };
    });
  return items.length === 0 ? null : items;
}
