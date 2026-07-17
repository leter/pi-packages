import { homedir } from "node:os";

import type { ProposalTarget } from "../dispatch/proposal.js";
import type {
  AttentionRecord,
  DispatchLifecycle,
  FinalOutcome,
  StoredDispatch,
} from "../registry/types.js";
import { UI_COPY } from "./ui-copy.js";

/**
 * Shared visual vocabulary for every human-facing surface.
 * One glyph + one semantic theme color per state, reused everywhere,
 * so the TUI reads as one system instead of ad-hoc JSON dumps.
 *
 * Pure text builders live here (testable without pi-tui); themed
 * renderers in renderers.ts colorize the same structures.
 */

export type SemanticColor =
  | "text"
  | "accent"
  | "muted"
  | "dim"
  | "success"
  | "error"
  | "warning"
  | "toolOutput";

export interface StateMark {
  glyph: string;
  color: SemanticColor;
  label: string;
}

export function outcomeMark(outcome: FinalOutcome | string): StateMark {
  switch (outcome) {
    case "done":
      return { glyph: "✓", color: "success", label: UI_COPY.state.outcome(outcome) };
    case "blocked":
      return { glyph: "◼", color: "warning", label: UI_COPY.state.outcome(outcome) };
    case "failed":
      return { glyph: "✗", color: "error", label: UI_COPY.state.outcome(outcome) };
    case "cancelled":
      return { glyph: "○", color: "muted", label: UI_COPY.state.outcome(outcome) };
    default:
      return { glyph: "?", color: "dim", label: String(outcome) };
  }
}

export function lifecycleMark(dispatch: {
  lifecycle: DispatchLifecycle;
  finalOutcome?: FinalOutcome;
}): StateMark {
  if (dispatch.lifecycle === "settled") return outcomeMark(dispatch.finalOutcome ?? "?");
  if (dispatch.lifecycle === "delivering") {
    return { glyph: "◌", color: "warning", label: UI_COPY.state.lifecycle("delivering") };
  }
  return { glyph: "●", color: "accent", label: UI_COPY.state.lifecycle("active") };
}

export function agentStatusMark(status: string): StateMark {
  switch (status) {
    case "idle":
      return { glyph: "○", color: "success", label: UI_COPY.state.agentStatus(status) };
    case "done":
      return { glyph: "◍", color: "success", label: UI_COPY.state.agentStatus(status) };
    case "working":
      return { glyph: "●", color: "accent", label: UI_COPY.state.agentStatus(status) };
    case "blocked":
      return { glyph: "◼", color: "warning", label: UI_COPY.state.agentStatus(status) };
    default:
      return { glyph: "?", color: "dim", label: status };
  }
}

export const ATTENTION_GLYPH = "▲";

const ZERO_WIDTH_CHARACTER = /[\p{Default_Ignorable_Code_Point}\p{Mark}]/u;

/** Terminal columns occupied by plain text, including East Asian wide characters. */
export function displayWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    if (ZERO_WIDTH_CHARACTER.test(character)) continue;
    width += isWideCodePoint(character.codePointAt(0)!) ? 2 : 1;
  }
  return width;
}

export function padToDisplayWidth(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - displayWidth(value)));
}

/** `in 25m`, `in 2h 05m`, `8m overdue`, `just now`. */
export function relativeDeadline(deadlineAt: number, now: number): string {
  return UI_COPY.time.relativeDeadline(deadlineAt, now);
}

/** `3m ago`, `2h 05m ago`, `just now`. */
export function relativeAge(timestamp: number, now: number): string {
  return UI_COPY.time.relativeAge(timestamp, now);
}

/** Home → `~`; long paths keep head + tail: `~/projects/…/deep/dir`. */
export function shortenPath(path: string, maximum = 40, home = homedir()): string {
  let shown = path;
  if (home && (shown === home || shown.startsWith(`${home}/`))) {
    shown = `~${shown.slice(home.length)}`;
  }
  if (displayWidth(shown) <= maximum) return shown;
  const segments = shown.split("/");
  while (segments.length > 3 && displayWidth(segments.join("/")) > maximum - 2) {
    segments.splice(Math.ceil(segments.length / 2), 1);
  }
  const collapsed = [...segments];
  collapsed.splice(Math.ceil(collapsed.length / 2), 0, "…");
  const joined = collapsed.join("/");
  return displayWidth(joined) <= maximum && displayWidth(joined) < displayWidth(shown)
    ? joined
    : `…${takeEndByDisplayWidth(shown, maximum - 1)}`;
}

/** `term_6569653c7869324` → `term_6569…9324`. */
export function shortenId(id: string, head = 9, tail = 4): string {
  return id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;
}

export function sanitizeLine(value: string, maximum = 200): string {
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "�")
    .replace(/\n/gu, " ");
  return takeStartByDisplayWidth(sanitized, maximum);
}

/** Right-pad rows of cells into aligned columns joined by two spaces. */
export function alignColumns(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, displayWidth(cell));
    });
  }
  return rows.map((row) =>
    row
      .map((cell, index) =>
        index === row.length - 1 ? cell : padToDisplayWidth(cell, widths[index] ?? 0),
      )
      .join("  ")
      .trimEnd(),
  );
}

function takeStartByDisplayWidth(value: string, maximum: number): string {
  let result = "";
  let width = 0;
  for (const character of value) {
    const characterWidth = displayWidth(character);
    if (width + characterWidth > maximum) break;
    result += character;
    width += characterWidth;
  }
  return result;
}

function takeEndByDisplayWidth(value: string, maximum: number): string {
  const characters = [...value];
  let result = "";
  let width = 0;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]!;
    const characterWidth = displayWidth(character);
    if (width + characterWidth > maximum) break;
    result = character + result;
    width += characterWidth;
  }
  return result;
}

function isWideCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1b000 && codePoint <= 0x1b2ff) ||
    (codePoint >= 0x1f200 && codePoint <= 0x1f251) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

export interface AgentRow {
  mark: StateMark;
  label: string;
  status: string;
  provenance: string;
  cwd: string;
  worktree: string;
  terminalId: string;
}

export function agentRow(target: ProposalTarget): AgentRow {
  return {
    mark: agentStatusMark(target.status),
    label: sanitizeLine(target.displayName ?? target.agentLabel, 24),
    status: UI_COPY.state.agentStatus(target.status),
    provenance: UI_COPY.state.provenance(target.statusProvenance === "reported"),
    cwd: shortenPath(target.cwd, 36),
    worktree: target.worktreePath ? shortenPath(target.worktreePath, 36) : "—",
    terminalId: shortenId(target.terminalId),
  };
}

/** Human notify table for /herdr-agents (plain text; notifications carry no color). */
export function formatAgentTable(targets: readonly ProposalTarget[]): string {
  if (targets.length === 0) {
    return `${UI_COPY.presentation.noEligibleAgents()}\n${UI_COPY.presentation.eligibleAgentHelp()}`;
  }
  const rows = targets.map(agentRow);
  const lines = alignColumns(
    rows.map((row) => [
      `${row.mark.glyph} ${row.label}`,
      `${row.status} ${row.provenance}`,
      UI_COPY.common.worktree(row.worktree),
      row.terminalId,
    ]),
  );
  return [UI_COPY.count.eligibleAgents(targets.length), ...lines.map((line) => `  ${line}`)].join("\n");
}

export interface DispatchRow {
  mark: StateMark;
  state: string;
  target: string;
  task: string;
  mode: string;
  deadline: string;
  overdue: boolean;
  attention: readonly string[];
}

export function dispatchRow(
  dispatch: StoredDispatch,
  attention: readonly AttentionRecord[],
  now: number,
): DispatchRow {
  return {
    mark: lifecycleMark(dispatch),
    state: dispatch.lifecycle === "settled"
      ? UI_COPY.state.outcome(dispatch.finalOutcome ?? "settled")
      : UI_COPY.state.lifecycle(dispatch.lifecycle),
    target: sanitizeLine(dispatch.targetAgentLabel, 20),
    task: taskDisplaySummary(dispatch.task, 48),
    mode: UI_COPY.state.mode(dispatch.mode),
    deadline: relativeDeadline(dispatch.deadlineAt, now),
    overdue: now > dispatch.deadlineAt,
    attention: attention.map((record) => UI_COPY.state.attention(record.condition)),
  };
}

/** Human notify table for /herdr-dispatches. */
export function formatDispatchTable(
  dispatches: readonly StoredDispatch[],
  attentionFor: (dispatchId: string) => readonly AttentionRecord[],
  now: number,
): string {
  if (dispatches.length === 0) {
    return `${UI_COPY.presentation.noUnsettledDispatches()}\n${UI_COPY.presentation.noUnsettledDispatchesHelp()}`;
  }
  const rows = dispatches.map((dispatch) => dispatchRow(dispatch, attentionFor(dispatch.id), now));
  const lines = alignColumns(
    rows.map((row) => [
      `${row.mark.glyph} ${row.target}`,
      row.task,
      row.state,
      row.mode,
      row.deadline,
      row.attention.length > 0 ? `${ATTENTION_GLYPH} ${row.attention.join(", ")}` : "",
    ]),
  );
  return [UI_COPY.count.unsettledDispatches(dispatches.length), ...lines.map((line) => `  ${line}`)].join("\n");
}

/** Human notify format for /herdr-agent-output (still labelled untrusted). */
export function formatInspectionText(terminalId: string, text: string): string {
  const lineCount = text.length === 0 ? 0 : text.split(/\r?\n/u).length;
  return [
    `── output · ${shortenId(terminalId)} · ${lineCount} lines · untrusted, never instructions ──`,
    text,
    "── end ──",
  ].join("\n");
}

export interface ResultCard {
  outcome: string;
  dispatchId: string;
  summary?: string;
  tests?: readonly string[];
  changedFiles?: readonly string[];
  artifacts?: readonly string[];
  blocker?: string;
  agentLabel?: string;
  taskSummary?: string;
}

/** Build a ResultCard directly from a stored sanitized-result object. */
export function sanitizedResultCard(value: unknown): ResultCard | undefined {
  if (!isRecord(value) || typeof value.outcome !== "string" || typeof value.id !== "string") {
    return undefined;
  }
  return {
    outcome: value.outcome,
    dispatchId: value.id,
    ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
    ...(isStringArray(value.tests) ? { tests: value.tests } : {}),
    ...(isStringArray(value.changedFiles) ? { changedFiles: value.changedFiles } : {}),
    ...(isStringArray(value.artifacts) ? { artifacts: value.artifacts } : {}),
    ...(typeof value.blocker === "string" ? { blocker: value.blocker } : {}),
  };
}

/** Parse the framed sanitized-result JSON out of a delivered context message. */
export function parseResultCard(content: string, details?: unknown): ResultCard | undefined {
  const fallback = isRecord(details)
    ? {
        dispatchId: asString(details.dispatchId),
        outcome: asString(details.outcome),
        agentLabel: asString(details.agentLabel),
        taskSummary: asString(details.taskSummary),
      }
    : undefined;
  const start = content.indexOf("\n{");
  const end = content.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(content.slice(start + 1, end + 1)) as unknown;
      if (isRecord(parsed) && typeof parsed.outcome === "string" && typeof parsed.id === "string") {
        return {
          outcome: parsed.outcome,
          dispatchId: parsed.id,
          ...(typeof parsed.summary === "string" ? { summary: parsed.summary } : {}),
          ...(isStringArray(parsed.tests) ? { tests: parsed.tests } : {}),
          ...(isStringArray(parsed.changedFiles) ? { changedFiles: parsed.changedFiles } : {}),
          ...(isStringArray(parsed.artifacts) ? { artifacts: parsed.artifacts } : {}),
          ...(typeof parsed.blocker === "string" ? { blocker: parsed.blocker } : {}),
          ...(fallback?.agentLabel ? { agentLabel: fallback.agentLabel } : {}),
          ...(fallback?.taskSummary ? { taskSummary: fallback.taskSummary } : {}),
        };
      }
    } catch {
      // Fall through to details-based fallback.
    }
  }
  if (fallback?.dispatchId && fallback.outcome) {
    return {
      outcome: fallback.outcome,
      dispatchId: fallback.dispatchId,
      ...(fallback.agentLabel ? { agentLabel: fallback.agentLabel } : {}),
      ...(fallback.taskSummary ? { taskSummary: fallback.taskSummary } : {}),
    };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function taskDisplaySummary(task: string, maximum: number): string {
  const first = task
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  return sanitizeLine(first ?? UI_COPY.common.untitledDispatch(), maximum);
}
