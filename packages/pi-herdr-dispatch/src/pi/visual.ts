import { homedir } from "node:os";

import type { ProposalTarget } from "../dispatch/proposal.js";
import type {
  AttentionRecord,
  DispatchLifecycle,
  FinalOutcome,
  StoredDispatch,
} from "../registry/types.js";

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
      return { glyph: "✓", color: "success", label: "done" };
    case "blocked":
      return { glyph: "◼", color: "warning", label: "blocked" };
    case "failed":
      return { glyph: "✗", color: "error", label: "failed" };
    case "cancelled":
      return { glyph: "○", color: "muted", label: "cancelled" };
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
    return { glyph: "◌", color: "warning", label: "delivering" };
  }
  return { glyph: "●", color: "accent", label: "active" };
}

export function agentStatusMark(status: string): StateMark {
  switch (status) {
    case "idle":
      return { glyph: "○", color: "success", label: "idle" };
    case "done":
      return { glyph: "◍", color: "success", label: "done" };
    case "working":
      return { glyph: "●", color: "accent", label: "working" };
    case "blocked":
      return { glyph: "◼", color: "warning", label: "blocked" };
    default:
      return { glyph: "?", color: "dim", label: status };
  }
}

export const ATTENTION_GLYPH = "▲";

/** `in 25m`, `in 2h 05m`, `8m overdue`, `just now`. */
export function relativeDeadline(deadlineAt: number, now: number): string {
  const delta = deadlineAt - now;
  const magnitude = Math.abs(delta);
  if (magnitude < 60_000) return delta >= 0 ? "in <1m" : "just overdue";
  const minutes = Math.round(magnitude / 60_000);
  const text =
    minutes < 60
      ? `${minutes}m`
      : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
  return delta >= 0 ? `in ${text}` : `${text} overdue`;
}

/** `3m ago`, `2h 05m ago`, `just now`. */
export function relativeAge(timestamp: number, now: number): string {
  const magnitude = Math.max(0, now - timestamp);
  if (magnitude < 60_000) return "just now";
  const minutes = Math.round(magnitude / 60_000);
  return minutes < 60
    ? `${minutes}m ago`
    : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m ago`;
}

/** Home → `~`; long paths keep head + tail: `~/projects/…/deep/dir`. */
export function shortenPath(path: string, maximum = 40, home = homedir()): string {
  let shown = path;
  if (home && (shown === home || shown.startsWith(`${home}/`))) {
    shown = `~${shown.slice(home.length)}`;
  }
  if (shown.length <= maximum) return shown;
  const segments = shown.split("/");
  while (segments.length > 3 && segments.join("/").length > maximum - 2) {
    segments.splice(Math.ceil(segments.length / 2), 1);
  }
  const collapsed = [...segments];
  collapsed.splice(Math.ceil(collapsed.length / 2), 0, "…");
  const joined = collapsed.join("/");
  return joined.length < shown.length ? joined : `…${shown.slice(-(maximum - 1))}`;
}

/** `term_6569653c7869324` → `term_6569…9324`. */
export function shortenId(id: string, head = 9, tail = 4): string {
  return id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;
}

export function sanitizeLine(value: string, maximum = 200): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "�")
    .replace(/\n/gu, " ")
    .slice(0, maximum);
}

/** Left-pad rows of cells into aligned columns joined by two spaces. */
export function alignColumns(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join("  ")
      .trimEnd(),
  );
}

export interface AgentRow {
  mark: StateMark;
  label: string;
  status: string;
  provenance: string;
  cwd: string;
  terminalId: string;
}

export function agentRow(target: ProposalTarget): AgentRow {
  return {
    mark: agentStatusMark(target.status),
    label: sanitizeLine(target.displayName ?? target.agentLabel, 24),
    status: target.status,
    provenance: target.statusProvenance === "reported" ? "reported" : "~screen",
    cwd: shortenPath(target.cwd, 36),
    terminalId: shortenId(target.terminalId),
  };
}

/** Human notify table for /herdr-agents (plain text; notifications carry no color). */
export function formatAgentTable(targets: readonly ProposalTarget[]): string {
  if (targets.length === 0) {
    return "No eligible Agents right now — the others are working, blocked, or occupied.\nAgents become eligible when their status is idle or done.";
  }
  const rows = targets.map(agentRow);
  const lines = alignColumns(
    rows.map((row) => [
      `${row.mark.glyph} ${row.label}`,
      `${row.status} ${row.provenance}`,
      row.cwd,
      row.terminalId,
    ]),
  );
  const plural = targets.length === 1 ? "Agent" : "Agents";
  return [`${targets.length} eligible ${plural}`, ...lines.map((line) => `  ${line}`)].join("\n");
}

export interface DispatchRow {
  mark: StateMark;
  state: string;
  target: string;
  task: string;
  mode: string;
  deadline: string;
  attention: readonly string[];
}

export function dispatchRow(
  dispatch: StoredDispatch,
  attention: readonly AttentionRecord[],
  now: number,
): DispatchRow {
  return {
    mark: lifecycleMark(dispatch),
    state: dispatch.lifecycle === "settled" ? (dispatch.finalOutcome ?? "settled") : dispatch.lifecycle,
    target: sanitizeLine(dispatch.targetAgentLabel, 20),
    task: taskDisplaySummary(dispatch.task, 48),
    mode: dispatch.mode,
    deadline: relativeDeadline(dispatch.deadlineAt, now),
    attention: attention.map((record) => record.condition),
  };
}

/** Human notify table for /herdr-dispatches. */
export function formatDispatchTable(
  dispatches: readonly StoredDispatch[],
  attentionFor: (dispatchId: string) => readonly AttentionRecord[],
  now: number,
): string {
  if (dispatches.length === 0) {
    return "No unsettled dispatches.\nStart one with /hd-new, or just ask for work to be dispatched.";
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
  const plural = dispatches.length === 1 ? "dispatch" : "dispatches";
  return [`${dispatches.length} unsettled ${plural}`, ...lines.map((line) => `  ${line}`)].join("\n");
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
  return sanitizeLine(first ?? "Untitled dispatch", maximum);
}
