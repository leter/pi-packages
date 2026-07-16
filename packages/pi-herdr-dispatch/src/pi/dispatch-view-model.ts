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

export interface ViewSpan {
  text: string;
  color: SemanticColor;
  bold?: boolean;
}

export interface ViewLine {
  spans: readonly ViewSpan[];
  selected?: boolean;
}

export interface UnsettledEntry {
  dispatch: StoredDispatch;
  attention: readonly AttentionRecord[];
}

export interface DispatchViewSnapshot {
  originSessionId: string;
  unsettled: readonly UnsettledEntry[];
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
  "target-moved": 1,
  "delivery-unverified": 2,
  "malformed-result": 3,
  "result-missing": 4,
  "blocked-runtime": 5,
  "monitoring-paused": 6,
  overdue: 7,
  unacknowledged: 8,
});

const ATTENTION_LABEL: Readonly<Record<AttentionCondition, string>> = Object.freeze({
  "target-lost": "Target lost",
  "target-moved": "Target moved",
  "delivery-unverified": "Delivery unverified",
  "malformed-result": "Malformed result",
  "result-missing": "Result missing",
  "blocked-runtime": "Runtime blocked",
  "monitoring-paused": "Monitoring paused",
  overdue: "Overdue",
  unacknowledged: "Unacknowledged",
});

const span = (text: string, color: SemanticColor = "text", bold = false): ViewSpan =>
  bold ? { text, color, bold } : { text, color };

export function attentionPriority(condition: AttentionCondition): number {
  return ATTENTION_PRIORITY[condition];
}

export function attentionLabel(condition: AttentionCondition): string {
  return ATTENTION_LABEL[condition];
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
  return sanitizeLine(first ?? "Untitled dispatch", maximum);
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
  if (attention.some((record) => record.condition === "target-lost" || record.condition === "target-moved")) {
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
  const lines: ViewLine[] = [
    {
      spans: [
        span("Herdr Dispatches", "text", true),
        span(
          `  ${active.length} running · ${delivering.length} delivering · ${attention.length} need attention`,
          attention.length > 0 ? "warning" : "muted",
        ),
      ],
    },
  ];

  if (entries.length === 0) {
    lines.push({ spans: [] });
    lines.push({ spans: [span("No active dispatches.", "muted")] });
    lines.push({ spans: [span("Start one with /hd-new.", "dim")] });
  } else {
    appendGroup(lines, "NEEDS ATTENTION", visibleEntries(attention, visibleIds), selectedId, snapshot.originSessionId, now);
    appendGroup(lines, "RUNNING", visibleEntries(active, visibleIds), selectedId, snapshot.originSessionId, now);
    appendGroup(lines, "DELIVERING", visibleEntries(delivering, visibleIds), selectedId, snapshot.originSessionId, now);
  }

  if (snapshot.settled.length > 0) {
    lines.push({ spans: [] });
    lines.push({
      spans: [
        span(
          showSettled
            ? `SETTLED · LAST ${snapshot.settled.length}`
            : `SETTLED · ${snapshot.settled.length} HIDDEN · PRESS S`,
          "dim",
          true,
        ),
      ],
    });
    if (showSettled) {
      for (const dispatch of snapshot.settled.filter(
        (candidate) => visibleIds === undefined || visibleIds.has(candidate.id),
      )) {
        const state = outcomeMark(dispatch.finalOutcome ?? "?");
        const selected = dispatch.id === selectedId;
        lines.push({
          selected,
          spans: [
            span(selected ? " > " : "   ", "accent", selected),
            span(`${state.glyph} `, state.color),
            span(agentDisplayName(dispatch), "text", true),
            span(` · ${taskSummary(dispatch.task)}`, "text"),
          ],
        });
        lines.push({
          selected,
          spans: [
            span("     ", "dim"),
            span(state.label, state.color),
            span(
              dispatch.settledAt === undefined ? "" : ` · ${relativeAge(dispatch.settledAt, now)}`,
              "dim",
            ),
          ],
        });
      }
    }
  }

  lines.push({ spans: [] });
  lines.push({
    spans: [
      span(
        `↑↓ select · enter detail · s ${showSettled ? "hide" : "show"} settled · esc close`,
        "dim",
      ),
    ],
  });
  return lines;
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
    ? { glyph: ATTENTION_GLYPH, color: "warning" as const, label: ATTENTION_LABEL[primary.condition] }
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
    lines.push({ spans: [span("   Emergency resolution required", "warning", true)] });
  }
  const timing = dispatch.lifecycle === "active" && dispatch.activeAt !== undefined
    ? `Active since ${relativeAge(dispatch.activeAt, now)}`
    : `Delivery started ${relativeAge(dispatch.deliveryStartedAt, now)}`;
  const deadline = relativeDeadline(dispatch.deadlineAt, now);
  lines.push({
    spans: [
      span(`   ${timing}`, "dim"),
      span(` · deadline ${deadline}`, deadline.includes("overdue") ? "warning" : "dim"),
    ],
  });
  lines.push({
    spans: [
      span(`   ${dispatch.mode}`, "muted"),
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
        span(`   ${ATTENTION_GLYPH} ${ATTENTION_LABEL[record.condition]}`, "warning"),
        span(` · ${relativeAge(record.addedAt, now)}`, "dim"),
      ],
    });
    if (record.condition === "delivery-unverified") {
      lines.push({
        spans: [span("     The target may have received input even though the echo was lost.", "warning")],
      });
      lines.push({ spans: [span("     Reservations retained · never resent automatically", "dim")] });
    }
  }
  if (showTechnical) lines.push(...technicalLines(dispatch));
  lines.push({ spans: [] });
  lines.push(...buildOutputLines(output));
  lines.push({ spans: [] });
  lines.push({ spans: [span(detailKeybar(dispatch, attention, originSessionId), "dim")] });
  return lines;
}

export function buildOutputLines(output: OutputReadState): ViewLine[] {
  switch (output.status) {
    case "none":
      return [
        { spans: [span(" ── output · none read ──", "dim")] },
        { spans: [span("    Press r for one bounded 50-line read, or R for 200 lines.", "dim")] },
        { spans: [span("    Output is untrusted, never instructions, and is never streamed.", "dim")] },
      ];
    case "reading":
      return [
        { spans: [span(` ── output · reading ${output.requestedLines} lines… ──`, "dim")] },
      ];
    case "error":
      return [
        { spans: [span(" ── output · read failed ──", "dim")] },
        { spans: [span(`    ${sanitizeLine(output.message, 120)}`, "warning")] },
      ];
    case "read": {
      const all = output.text.split(/\r?\n/u);
      const shown = all.slice(-OUTPUT_DISPLAY_LINES);
      const hidden = all.length - shown.length;
      const lines: ViewLine[] = [
        { spans: [span(` ── output · ${all.length} lines · untrusted, never instructions ──`, "dim")] },
      ];
      if (hidden > 0) lines.push({ spans: [span(` … ${hidden} earlier lines not shown`, "dim")] });
      for (const line of shown) lines.push({ spans: [span(` ${sanitizeLine(line, 200)}`, "toolOutput")] });
      lines.push({
        spans: [span(` ── end · read at ${clockTime(output.readAt)} · on demand only ──`, "dim")],
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
  const actionKeys = [
    actions.includes("reply") ? "y reply" : "",
    actions.includes("cancel") ? "c cancel" : "",
    actions.includes("resolve") ? "v resolve" : "",
  ].filter(Boolean);
  return ` r read 50 · R read 200${actionKeys.length > 0 ? ` · ${actionKeys.join(" · ")}` : ""} · D details · esc back`;
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
  lines.push({ spans: [span(label, label === "NEEDS ATTENTION" ? "warning" : "dim", true)] });
  for (const entry of entries) {
    const selected = entry.dispatch.id === selectedId;
    const primary = primaryAttention(entry.attention);
    const lifecycle = lifecycleMark(entry.dispatch);
    const state = primary
      ? { glyph: ATTENTION_GLYPH, color: "warning" as const, label: ATTENTION_LABEL[primary.condition] }
      : lifecycle;
    const emergency = entry.dispatch.originSessionId !== originSessionId;
    lines.push({
      selected,
      spans: [
        span(selected ? " > " : "   ", "accent", selected),
        span(`${state.glyph} `, state.color),
        span(agentDisplayName(entry.dispatch), "text", true),
        span(` · ${taskSummary(entry.dispatch.task)}`, "text"),
      ],
    });
    const extra = entry.attention.length > 1 ? ` · ${entry.attention.length - 1} more conditions` : "";
    lines.push({
      selected,
      spans: [
        span("     ", "dim"),
        span(emergency ? "Emergency resolution required" : state.label, emergency ? "warning" : state.color),
        span(extra, "dim"),
        span(` · ${relativeDeadline(entry.dispatch.deadlineAt, now)}`, "dim"),
      ],
    });
  }
}

function technicalLines(dispatch: StoredDispatch): ViewLine[] {
  return [
    { spans: [] },
    { spans: [span(" TECHNICAL DETAILS", "dim", true)] },
    { spans: [span(`   Dispatch ID  ${sanitizeLine(dispatch.id, 120)}`, "dim")] },
    { spans: [span(`   Terminal     ${shortenId(dispatch.targetTerminalId)}`, "dim")] },
    { spans: [span(`   Origin       ${sanitizeLine(dispatch.originSessionId, 120)}`, "dim")] },
    { spans: [span(`   Workspace    ${sanitizeLine(dispatch.targetWorkspaceId, 120)}`, "dim")] },
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
