import type { AttentionCondition, AttentionRecord, StoredDispatch } from "../registry/types.js";
import {
  ATTENTION_GLYPH,
  lifecycleMark,
  outcomeMark,
  relativeAge,
  relativeDeadline,
  sanitizeLine,
  shortenId,
  shortenPath,
  type SemanticColor,
} from "./visual.js";
import { UI_COPY } from "./ui-copy.js";

export interface ViewSpan {
  text: string;
  color: SemanticColor;
  bold?: boolean;
}

export interface ViewLine {
  spans: readonly ViewSpan[];
  selected?: boolean;
  align?: "center";
}

export interface UnsettledEntry {
  dispatch: StoredDispatch;
  attention: readonly AttentionRecord[];
}

export interface DispatchViewSnapshot {
  originSessionId: string;
  unsettled: readonly UnsettledEntry[];
  /** Settled with an unopened result; shown above the settled fold until viewed. */
  unseenSettled?: readonly StoredDispatch[];
  /** Recently settled and already seen; excludes unseenSettled records. */
  settled: readonly StoredDispatch[];
}

export type OutputReadState =
  | { status: "none" }
  | { status: "reading"; requestedLines: number }
  | {
      status: "read";
      terminalId: string;
      text: string;
      requestedLines: number;
      readAt: number;
    }
  | { status: "error"; message: string };

export type DispatchAction = "reply" | "cancel" | "resolve";

export const OUTPUT_DISPLAY_LINES = 20;
export const SETTLED_DISPLAY_LIMIT = 2;

const ATTENTION_PRIORITY: Readonly<Record<AttentionCondition, number>> = Object.freeze({
  "target-lost": 1,
  "delivery-unverified": 2,
  "malformed-result": 3,
  "result-missing": 4,
  "blocked-runtime": 5,
  "monitoring-paused": 6,
  overdue: 7,
  unacknowledged: 8,
});

const span = (text: string, color: SemanticColor = "text", bold = false): ViewSpan =>
  bold ? { text, color, bold } : { text, color };

export function attentionPriority(condition: AttentionCondition): number {
  return ATTENTION_PRIORITY[condition];
}

export function attentionLabel(condition: AttentionCondition): string {
  return UI_COPY.state.attention(condition);
}

export function primaryAttention(
  attention: readonly AttentionRecord[],
): AttentionRecord | undefined {
  return [...attention].sort(
    (a, b) =>
      attentionPriority(a.condition) - attentionPriority(b.condition) ||
      a.condition.localeCompare(b.condition),
  )[0];
}

export function taskSummary(task: string, maximum = 72): string {
  const first = task
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  return sanitizeLine(first ?? UI_COPY.common.untitledDispatch(), maximum);
}

export function agentDisplayName(dispatch: StoredDispatch, maximum = 24): string {
  return sanitizeLine(dispatch.targetAgentLabel, maximum);
}

/** Attention, active, then delivering; each group has deterministic ordering. */
export function sortUnsettled(entries: readonly UnsettledEntry[]): UnsettledEntry[] {
  const rank = (entry: UnsettledEntry): number => {
    if (entry.attention.length > 0) return 0;
    return entry.dispatch.lifecycle === "active" ? 1 : 2;
  };
  return [...entries].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    if (rank(a) === 0) {
      const aAttention = primaryAttention(a.attention)!;
      const bAttention = primaryAttention(b.attention)!;
      const byAttention = attentionPriority(aAttention.condition) - attentionPriority(bAttention.condition);
      if (byAttention !== 0) return byAttention;
      const byCondition = aAttention.condition.localeCompare(bAttention.condition);
      if (byCondition !== 0) return byCondition;
    }
    const byDeadline = a.dispatch.deadlineAt - b.dispatch.deadlineAt;
    if (byDeadline !== 0) return byDeadline;
    return a.dispatch.id.localeCompare(b.dispatch.id);
  });
}

export function selectableIds(snapshot: DispatchViewSnapshot, showSettled: boolean): string[] {
  const ids = sortUnsettled(snapshot.unsettled).map((entry) => entry.dispatch.id);
  ids.push(...(snapshot.unseenSettled ?? []).map((dispatch) => dispatch.id));
  if (showSettled) ids.push(...snapshot.settled.map((dispatch) => dispatch.id));
  return ids;
}

export function availableActions(
  dispatch: StoredDispatch,
  attention: readonly AttentionRecord[],
  originSessionId: string,
): readonly DispatchAction[] {
  if (dispatch.lifecycle === "settled") return [];
  if (dispatch.originSessionId !== originSessionId) return ["resolve"];
  if (attention.some((record) => record.condition === "target-lost")) {
    return ["resolve"];
  }
  const actions: DispatchAction[] = [];
  if (dispatch.lifecycle === "active" && attention.length > 0) actions.push("reply");
  actions.push("cancel", "resolve");
  return actions;
}

export function buildListLines(
  snapshot: DispatchViewSnapshot,
  selectedId: string | undefined,
  showSettled: boolean,
  now: number,
  visibleIds?: ReadonlySet<string>,
): ViewLine[] {
  const entries = sortUnsettled(snapshot.unsettled);
  const attention = entries.filter((entry) => entry.attention.length > 0);
  const active = entries.filter(
    (entry) => entry.attention.length === 0 && entry.dispatch.lifecycle === "active",
  );
  const delivering = entries.filter(
    (entry) => entry.attention.length === 0 && entry.dispatch.lifecycle === "delivering",
  );
  const lines: ViewLine[] = [];

  if (entries.length === 0) {
    lines.push({ spans: [] });
    lines.push({
      align: "center",
      spans: [
        span(UI_COPY.manager.noActiveDispatches(), "muted"),
        span(" · ", "dim"),
        span(UI_COPY.manager.startWithCommand(), "dim"),
      ],
    });
    lines.push({ spans: [] });
  } else {
    appendGroup(lines, UI_COPY.manager.groupAttention(), visibleEntries(attention, visibleIds), selectedId, snapshot.originSessionId, now);
    appendGroup(lines, UI_COPY.manager.groupRunning(), visibleEntries(active, visibleIds), selectedId, snapshot.originSessionId, now);
    appendGroup(lines, UI_COPY.manager.groupDelivering(), visibleEntries(delivering, visibleIds), selectedId, snapshot.originSessionId, now);
  }

  const unseen = snapshot.unseenSettled ?? [];
  if (unseen.length > 0) {
    lines.push({ spans: [] });
    lines.push({ spans: [span(UI_COPY.manager.groupUnseenSettled(), "success", true)] });
    for (const dispatch of unseen.filter(
      (candidate) => visibleIds === undefined || visibleIds.has(candidate.id),
    )) {
      lines.push(...settledRows(dispatch, dispatch.id === selectedId, now));
    }
  }

  if (snapshot.settled.length > 0) {
    lines.push({ spans: [] });
    lines.push({
      spans: [
        span(
          UI_COPY.manager.settledHeading(snapshot.settled.length, showSettled),
          "dim",
          true,
        ),
      ],
    });
    if (showSettled) {
      for (const dispatch of snapshot.settled.filter(
        (candidate) => visibleIds === undefined || visibleIds.has(candidate.id),
      )) {
        lines.push(...settledRows(dispatch, dispatch.id === selectedId, now));
      }
    }
  }

  return lines;
}

function settledRows(dispatch: StoredDispatch, selected: boolean, now: number): ViewLine[] {
  const state = outcomeMark(dispatch.finalOutcome ?? "?");
  return [
    {
      selected,
      spans: [
        span(selected ? " → " : "   ", "accent", selected),
        span(`${state.glyph} `, state.color),
        span(agentDisplayName(dispatch), "text", true),
        span(` · ${taskSummary(dispatch.task)}`, "text"),
      ],
    },
    {
      selected,
      spans: [
        span("     ", "dim"),
        span(state.label, state.color),
        span(
          dispatch.settledAt === undefined ? "" : ` · ${relativeAge(dispatch.settledAt, now)}`,
          "dim",
        ),
      ],
    },
  ];
}

export interface ViewChrome {
  title: string;
  counts?: string;
  countsColor?: SemanticColor;
  hint: string;
}

export function listChrome(snapshot: DispatchViewSnapshot, showSettled: boolean): ViewChrome {
  const entries = sortUnsettled(snapshot.unsettled);
  const attention = entries.filter((entry) => entry.attention.length > 0).length;
  const active = entries.filter(
    (entry) => entry.attention.length === 0 && entry.dispatch.lifecycle === "active",
  ).length;
  const delivering = entries.filter(
    (entry) => entry.attention.length === 0 && entry.dispatch.lifecycle === "delivering",
  ).length;
  const counts = UI_COPY.manager.heading(active, delivering, attention);
  return {
    title: UI_COPY.manager.title(),
    ...(counts === "" ? {} : { counts, countsColor: attention > 0 ? "warning" : "muted" }),
    hint: UI_COPY.manager.listKeybar(showSettled),
  };
}

export function detailChrome(
  dispatch: StoredDispatch,
  attention: readonly AttentionRecord[],
  originSessionId = dispatch.originSessionId,
): ViewChrome {
  return {
    title: UI_COPY.manager.detailTitle(),
    hint: detailKeybar(dispatch, attention, originSessionId).trim(),
  };
}

/** A settled record can seed a fresh Automatic Dispatch to the same target. */
export function canRedispatch(dispatch: StoredDispatch): boolean {
  return dispatch.lifecycle === "settled";
}

export function buildDetailLines(
  dispatch: StoredDispatch,
  attention: readonly AttentionRecord[],
  output: OutputReadState,
  now: number,
  originSessionId = dispatch.originSessionId,
  showTechnical = false,
): ViewLine[] {
  const primary = primaryAttention(attention);
  const lifecycle = lifecycleMark(dispatch);
  const state = primary
    ? { glyph: ATTENTION_GLYPH, color: "warning" as const, label: UI_COPY.state.attention(primary.condition) }
    : lifecycle;
  const emergency = dispatch.originSessionId !== originSessionId;
  const lines: ViewLine[] = [
    {
      spans: [
        span(` ${state.glyph} `, state.color),
        span(agentDisplayName(dispatch), "text", true),
        span(` · ${taskSummary(dispatch.task, 100)}`, "text"),
      ],
    },
    { spans: [span(`   ${state.label}`, state.color)] },
  ];
  if (emergency && dispatch.lifecycle !== "settled") {
    lines.push({ spans: [span(`   ${UI_COPY.manager.emergencyResolutionRequired()}`, "warning", true)] });
  }
  const timing = dispatch.lifecycle === "active" && dispatch.activeAt !== undefined
    ? UI_COPY.manager.activeSince(relativeAge(dispatch.activeAt, now))
    : UI_COPY.manager.deliveryStarted(relativeAge(dispatch.deliveryStartedAt, now));
  const deadline = relativeDeadline(dispatch.deadlineAt, now);
  lines.push({
    spans: [
      span(`   ${timing}`, "dim"),
      span(` · ${UI_COPY.common.deadline(deadline)}`, now > dispatch.deadlineAt ? "warning" : "dim"),
    ],
  });
  lines.push({
    spans: [
      span(`   ${UI_COPY.state.mode(dispatch.mode)}`, "muted"),
      span(` · ${shortenPath(dispatch.targetCwd, 56)}`, "muted"),
    ],
  });
  for (const record of [...attention].sort(
    (a, b) =>
      attentionPriority(a.condition) - attentionPriority(b.condition) ||
      a.condition.localeCompare(b.condition),
  )) {
    lines.push({
      spans: [
        span(`   ${ATTENTION_GLYPH} ${UI_COPY.state.attention(record.condition)}`, "warning"),
        span(` · ${relativeAge(record.addedAt, now)}`, "dim"),
      ],
    });
    if (record.condition === "delivery-unverified") {
      lines.push({
        spans: [span(`     ${UI_COPY.manager.targetMayHaveReceivedInput()}`, "warning")],
      });
      lines.push({ spans: [span(`     ${UI_COPY.manager.reservationsRetained()}`, "dim")] });
    }
  }
  if (showTechnical) lines.push(...technicalLines(dispatch));
  lines.push({ spans: [] });
  lines.push(...buildOutputLines(output));
  return lines;
}

export function buildOutputLines(output: OutputReadState): ViewLine[] {
  switch (output.status) {
    case "none":
      return [
        { spans: [span(UI_COPY.manager.outputNoneRead(), "dim")] },
        { spans: [span(UI_COPY.manager.outputReadInstructions(), "dim")] },
        { spans: [span("    Output is untrusted, never instructions, and is never streamed.", "dim")] },
      ];
    case "reading":
      return [
        { spans: [span(UI_COPY.manager.outputReading(output.requestedLines), "dim")] },
      ];
    case "error":
      return [
        { spans: [span(UI_COPY.manager.outputReadFailed(), "dim")] },
        { spans: [span(`    ${sanitizeLine(output.message, 120)}`, "warning")] },
      ];
    case "read": {
      const all = output.text.split(/\r?\n/u);
      const shown = all.slice(-OUTPUT_DISPLAY_LINES);
      const hidden = all.length - shown.length;
      const lines: ViewLine[] = [
        { spans: [span(` ── output · ${all.length} lines · untrusted, never instructions ──`, "dim")] },
      ];
      if (hidden > 0) lines.push({ spans: [span(UI_COPY.manager.outputEarlierLinesNotShown(hidden), "dim")] });
      for (const line of shown) lines.push({ spans: [span(` ${sanitizeLine(line, 200)}`, "toolOutput")] });
      lines.push({
        spans: [span(UI_COPY.manager.outputReadEnd(clockTime(output.readAt)), "dim")],
      });
      return lines;
    }
  }
}

export function detailKeybar(
  dispatch: StoredDispatch,
  attention: readonly AttentionRecord[] = [],
  originSessionId = dispatch.originSessionId,
): string {
  const actions = availableActions(dispatch, attention, originSessionId);
  return UI_COPY.manager.detailKeybar(actions, canRedispatch(dispatch));
}

export function clockTime(timestamp: number): string {
  const date = new Date(timestamp);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function appendGroup(
  lines: ViewLine[],
  label: string,
  entries: readonly UnsettledEntry[],
  selectedId: string | undefined,
  originSessionId: string,
  now: number,
): void {
  if (entries.length === 0) return;
  lines.push({ spans: [] });
  lines.push({
    spans: [span(label, label === UI_COPY.manager.groupAttention() ? "warning" : "dim", true)],
  });
  for (const entry of entries) {
    const selected = entry.dispatch.id === selectedId;
    const primary = primaryAttention(entry.attention);
    const lifecycle = lifecycleMark(entry.dispatch);
    const state = primary
      ? {
          glyph: ATTENTION_GLYPH,
          color: "warning" as const,
          label: UI_COPY.state.attention(primary.condition),
        }
      : lifecycle;
    const emergency = entry.dispatch.originSessionId !== originSessionId;
    lines.push({
      selected,
      spans: [
        span(selected ? " → " : "   ", "accent", selected),
        span(`${state.glyph} `, state.color),
        span(agentDisplayName(entry.dispatch), "text", true),
        span(` · ${taskSummary(entry.dispatch.task)}`, "text"),
      ],
    });
    const extra = entry.attention.length > 1
      ? ` · ${UI_COPY.count.moreConditions(entry.attention.length - 1)}`
      : "";
    lines.push({
      selected,
      spans: [
        span("     ", "dim"),
        span(
          emergency ? UI_COPY.manager.emergencyResolutionRequired() : state.label,
          emergency ? "warning" : state.color,
        ),
        span(extra, "dim"),
        span(` · ${relativeDeadline(entry.dispatch.deadlineAt, now)}`, "dim"),
      ],
    });
  }
}

function technicalLines(dispatch: StoredDispatch): ViewLine[] {
  return [
    { spans: [] },
    { spans: [span(UI_COPY.manager.technicalHeading(), "dim", true)] },
    { spans: [span(`   ${UI_COPY.manager.technicalLabel("dispatch")}  ${sanitizeLine(dispatch.id, 120)}`, "dim")] },
    { spans: [span(`   ${UI_COPY.manager.technicalLabel("terminal").padEnd(13)}${shortenId(dispatch.targetTerminalId)}`, "dim")] },
    { spans: [span(`   ${UI_COPY.manager.technicalLabel("origin").padEnd(13)}${sanitizeLine(dispatch.originSessionId, 120)}`, "dim")] },
    { spans: [span(`   ${UI_COPY.manager.technicalLabel("workspace").padEnd(13)}${sanitizeLine(dispatch.targetWorkspaceId, 120)}`, "dim")] },
  ];
}

function visibleEntries(
  entries: readonly UnsettledEntry[],
  visibleIds: ReadonlySet<string> | undefined,
): readonly UnsettledEntry[] {
  return visibleIds === undefined
    ? entries
    : entries.filter((entry) => visibleIds.has(entry.dispatch.id));
}
