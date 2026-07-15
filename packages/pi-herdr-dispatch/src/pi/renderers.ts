import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { ProposalTarget } from "../dispatch/proposal.js";
import type { AttentionRecord, StoredDispatch } from "../registry/types.js";
import {
  ATTENTION_GLYPH,
  agentRow,
  dispatchRow,
  lifecycleMark,
  outcomeMark,
  parseResultCard,
  relativeAge,
  relativeDeadline,
  sanitizeLine,
  shortenId,
  shortenPath,
  type SemanticColor,
  type StateMark,
} from "./visual.js";

/**
 * Themed TUI renderers. These change only what humans see; the framed,
 * untrusted content sent to the model is produced elsewhere and untouched.
 *
 * Styling is deliberately restrained (product register): semantic status
 * colors on glyphs and states, muted metadata, no decoration. Colors are
 * re-applied per render, never cached, so theme switches stay correct.
 */

type Fg = (color: SemanticColor, text: string) => string;

function fg(theme: Theme): Fg {
  return (color, text) => theme.fg(color, text);
}

function mark(theme: Theme, state: StateMark): string {
  return theme.fg(state.color, state.glyph);
}

export interface AgentsResultDetails {
  targets?: readonly ProposalTarget[];
}

export function renderAgentsResult(
  details: AgentsResultDetails | undefined,
  theme: Theme,
): Text | undefined {
  const targets = details?.targets;
  if (!targets) return undefined;
  const paint = fg(theme);
  if (targets.length === 0) {
    return new Text(
      [
        paint("muted", "No eligible Agents right now — the others are working, blocked, or occupied."),
        paint("dim", "Agents become eligible when their status is idle or done."),
      ].join("\n"),
      0,
      0,
    );
  }
  const rows = targets.map(agentRow);
  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  const statusWidth = Math.max(...rows.map((row) => `${row.status} ${row.provenance}`.length));
  const cwdWidth = Math.max(...rows.map((row) => row.cwd.length));
  const lines = rows.map((row) => {
    const provenance =
      row.provenance === "reported" ? paint("accent", "reported") : paint("dim", row.provenance);
    const statusPad = " ".repeat(statusWidth - `${row.status} ${row.provenance}`.length);
    return [
      ` ${mark(theme, row.mark)} ${theme.bold(row.label.padEnd(labelWidth))}`,
      `${paint(row.mark.color, row.status)} ${provenance}${statusPad}`,
      paint("muted", row.cwd.padEnd(cwdWidth)),
      paint("dim", row.terminalId),
    ].join("  ");
  });
  const heading = paint(
    "muted",
    `${targets.length} eligible ${targets.length === 1 ? "Agent" : "Agents"}`,
  );
  return new Text([heading, ...lines].join("\n"), 0, 0);
}

export interface StatusResultDetails {
  dispatch?: StoredDispatch;
  attention?: readonly AttentionRecord[];
  list?: readonly StoredDispatch[];
  listAttention?: Readonly<Record<string, readonly AttentionRecord[]>>;
  now?: number;
}

export function renderStatusResult(
  details: StatusResultDetails | undefined,
  theme: Theme,
  expanded: boolean,
): Text | undefined {
  if (!details) return undefined;
  const now = details.now ?? Date.now();
  const paint = fg(theme);

  if (details.list) {
    if (details.list.length === 0) {
      return new Text(paint("muted", "No unsettled dispatches."), 0, 0);
    }
    const rows = details.list.map((dispatch) =>
      dispatchRow(dispatch, details.listAttention?.[dispatch.id] ?? [], now),
    );
    const idWidth = Math.max(...rows.map((row) => row.id.length));
    const stateWidth = Math.max(...rows.map((row) => row.state.length));
    const targetWidth = Math.max(...rows.map((row) => row.target.length));
    const modeWidth = Math.max(...rows.map((row) => row.mode.length));
    const lines = rows.map((row) =>
      [
        ` ${mark(theme, row.mark)} ${theme.bold(row.id.padEnd(idWidth))}`,
        paint(row.mark.color, row.state.padEnd(stateWidth)),
        paint("text", row.target.padEnd(targetWidth)),
        paint("muted", row.mode.padEnd(modeWidth)),
        paint(row.deadline.includes("overdue") ? "warning" : "dim", row.deadline),
        row.attention.length > 0
          ? paint("warning", `${ATTENTION_GLYPH} ${row.attention.join(", ")}`)
          : "",
      ]
        .join("  ")
        .trimEnd(),
    );
    const heading = paint(
      "muted",
      `${details.list.length} unsettled ${details.list.length === 1 ? "dispatch" : "dispatches"}`,
    );
    return new Text([heading, ...lines].join("\n"), 0, 0);
  }

  const dispatch = details.dispatch;
  if (!dispatch) return undefined;
  const state = lifecycleMark(dispatch);
  const header = [
    `${mark(theme, state)} ${theme.bold(dispatch.id)}`,
    paint(state.color, state.label),
    paint("muted", dispatch.mode),
    `${paint("dim", "→")} ${paint("text", sanitizeLine(dispatch.targetAgentLabel, 24))} ${paint(
      "dim",
      `(${shortenId(dispatch.targetTerminalId)})`,
    )}`,
  ].join("  ");
  const deadline = relativeDeadline(dispatch.deadlineAt, now);
  const lines = [
    header,
    `   ${paint(deadline.includes("overdue") ? "warning" : "dim", `deadline ${deadline}`)}  ${paint(
      "muted",
      shortenPath(dispatch.targetCwd, 44),
    )}`,
  ];
  for (const record of details.attention ?? []) {
    lines.push(
      `   ${paint("warning", `${ATTENTION_GLYPH} ${record.condition}`)}  ${paint(
        "dim",
        relativeAge(record.addedAt, now),
      )}`,
    );
  }
  if (expanded && dispatch.worktreePath) {
    lines.push(`   ${paint("dim", `worktree ${shortenPath(dispatch.worktreePath, 44)}`)}`);
  }
  return new Text(lines.join("\n"), 0, 0);
}

export interface InspectionResultDetails {
  terminalId?: string;
  lineCount?: number;
  text?: string;
}

export function renderInspectionResult(
  details: InspectionResultDetails | undefined,
  theme: Theme,
  expanded: boolean,
): Text | undefined {
  if (!details?.terminalId || details.text === undefined) return undefined;
  const paint = fg(theme);
  const header = paint(
    "dim",
    `── output · ${shortenId(details.terminalId)} · ${details.lineCount ?? 0} lines · untrusted ──`,
  );
  const body = details.text.split(/\r?\n/u);
  const shown = expanded ? body : body.slice(-12);
  const lines = [
    header,
    ...shown.map((line) => paint("toolOutput", line)),
    ...(expanded || body.length <= 12
      ? []
      : [paint("dim", `… ${body.length - 12} earlier lines (expand to view)`)]),
  ];
  return new Text(lines.join("\n"), 0, 0);
}

export interface ConfirmationResultDetails {
  status?: string;
  dispatchId?: string;
  outcome?: string;
  reason?: string;
}

export function renderConfirmationResult(
  details: ConfirmationResultDetails | undefined,
  theme: Theme,
): Text | undefined {
  if (!details?.status) return undefined;
  const paint = fg(theme);
  const id = details.dispatchId ? theme.bold(details.dispatchId) : "";
  switch (details.status) {
    case "active":
      return new Text(
        `${paint("success", "✓")} ${id} ${paint("success", "active")} ${paint("dim", "· delivery echo verified")}`,
        0,
        0,
      );
    case "delivery-unverified":
      return new Text(
        [
          `${paint("warning", "◌")} ${id} ${paint("warning", "delivery unverified")}`,
          paint("dim", "   reservations retained · never resent automatically"),
        ].join("\n"),
        0,
        0,
      );
    case "failed":
      return new Text(
        `${paint("error", "✗")} ${id} ${paint("error", "not sent")} ${paint(
          "dim",
          `· ${sanitizeLine(details.reason ?? "delivery rejected", 80)}`,
        )}`,
        0,
        0,
      );
    case "already-settled": {
      const state = outcomeMark(details.outcome ?? "?");
      return new Text(
        `${mark(theme, state)} ${id} ${paint("muted", `already settled ${state.label}`)}`,
        0,
        0,
      );
    }
    case "cancelled":
      return new Text(paint("muted", "○ proposal cancelled — nothing was sent"), 0, 0);
    default:
      return undefined;
  }
}

/** Transcript card for a delivered dispatch result (registerMessageRenderer). */
export function renderDispatchResultMessage(
  message: { content: string | unknown; details?: unknown },
  expanded: boolean,
  theme: Theme,
): Text {
  const paint = fg(theme);
  const content = typeof message.content === "string" ? message.content : "";
  const card = parseResultCard(content, message.details);
  if (!card) return new Text(paint("dim", content || "dispatch result"), 0, 0);

  const state = outcomeMark(card.outcome);
  const summary = card.summary ? sanitizeLine(card.summary, 160) : "";
  const headline = [
    `${mark(theme, state)} ${paint(state.color, `dispatch ${state.label}`)}`,
    paint("dim", card.dispatchId),
    summary ? paint("text", summary) : "",
  ]
    .filter(Boolean)
    .join("  ");

  const lines = [headline];
  if (card.blocker) {
    lines.push(`   ${paint("warning", `blocker: ${sanitizeLine(card.blocker, 160)}`)}`);
  }
  if (expanded) {
    for (const [label, items] of [
      ["tests", card.tests],
      ["files", card.changedFiles],
      ["artifacts", card.artifacts],
    ] as const) {
      if (items && items.length > 0) {
        lines.push(
          `   ${paint("muted", label)} ${paint(
            "dim",
            items.map((item) => sanitizeLine(item, 60)).join(" · "),
          )}`,
        );
      }
    }
    lines.push(paint("dim", "   untrusted data · agent-reported, not verified"));
  } else if (card.tests?.length || card.changedFiles?.length) {
    const counts = [
      card.changedFiles?.length ? `${card.changedFiles.length} files` : "",
      card.tests?.length ? `${card.tests.length} tests` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(paint("dim", `   ${counts} (expand for details)`));
  }
  return new Text(lines.join("\n"), 0, 0);
}

export interface WidgetCounts {
  delivering: number;
  active: number;
  attention: number;
}

/** Themed one-line widget: counts colored only when they demand attention. */
export function renderDispatchWidget(counts: WidgetCounts, theme: Theme): Text {
  const paint = fg(theme);
  const segments = [
    counts.delivering > 0 ? paint("warning", `◌ ${counts.delivering} delivering`) : "",
    paint(counts.active > 0 ? "accent" : "dim", `● ${counts.active} active`),
    counts.attention > 0
      ? paint("warning", `${ATTENTION_GLYPH} ${counts.attention} attention`)
      : paint("dim", "no attention"),
  ].filter(Boolean);
  return new Text(
    `${paint("dim", "dispatches")}  ${segments.join(paint("dim", "  ·  "))}`,
    0,
    0,
  );
}
