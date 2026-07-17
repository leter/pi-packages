import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { ProposalTarget } from "../dispatch/proposal.js";
import type { TeamCatalog } from "../domain/team.js";
import type { AttentionRecord, StoredDispatch, StoredTask } from "../registry/types.js";
import {
  ATTENTION_GLYPH,
  agentRow,
  boardTaskRow,
  displayWidth,
  dispatchRow,
  lifecycleMark,
  outcomeMark,
  padToDisplayWidth,
  parseResultCard,
  relativeAge,
  relativeDeadline,
  sanitizeLine,
  shortenId,
  shortenPath,
  type SemanticColor,
  type StateMark,
  taskStateMark,
} from "./visual.js";
import { UI_COPY } from "./ui-copy.js";

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
        paint("muted", UI_COPY.presentation.noEligibleAgents()),
        paint("dim", UI_COPY.presentation.eligibleAgentHelp()),
      ].join("\n"),
      0,
      0,
    );
  }
  const rows = targets.map((target) => {
    const row = agentRow(target);
    return { ...row, worktreeCell: UI_COPY.common.worktree(row.worktree) };
  });
  const labelWidth = Math.max(...rows.map((row) => displayWidth(row.label)));
  const statusWidth = Math.max(...rows.map((row) => displayWidth(`${row.status} ${row.provenance}`)));
  const worktreeWidth = Math.max(...rows.map((row) => displayWidth(row.worktreeCell)));
  const lines = rows.map((row) => {
    const provenance =
      row.provenance === UI_COPY.state.provenance(true)
        ? paint("accent", UI_COPY.state.provenance(true))
        : paint("dim", row.provenance);
    const statusPad = " ".repeat(
      statusWidth - displayWidth(`${row.status} ${row.provenance}`),
    );
    return [
      ` ${mark(theme, row.mark)} ${theme.bold(padToDisplayWidth(row.label, labelWidth))}`,
      `${paint(row.mark.color, row.status)} ${provenance}${statusPad}`,
      paint("muted", padToDisplayWidth(row.worktreeCell, worktreeWidth)),
      paint("dim", row.terminalId),
    ].join("  ");
  });
  const heading = paint(
    "muted",
    UI_COPY.count.eligibleAgents(targets.length),
  );
  return new Text([heading, ...lines].join("\n"), 0, 0);
}

export interface StatusResultDetails {
  dispatch?: StoredDispatch;
  attention?: readonly AttentionRecord[];
  list?: readonly StoredDispatch[];
  listAttention?: Readonly<Record<string, readonly AttentionRecord[]>>;
  tasks?: readonly StoredTask[];
  team?: TeamCatalog;
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
    if (details.list.length === 0 && (details.tasks?.length ?? 0) === 0) {
      return new Text(paint("muted", UI_COPY.presentation.noUnsettledDispatches()), 0, 0);
    }
    const rows = details.list.map((dispatch) =>
      dispatchRow(dispatch, details.listAttention?.[dispatch.id] ?? [], now),
    );
    const targetWidth = Math.max(...rows.map((row) => displayWidth(row.target)));
    const taskWidth = Math.max(...rows.map((row) => displayWidth(row.task)));
    const stateWidth = Math.max(...rows.map((row) => displayWidth(row.state)));
    const modeWidth = Math.max(...rows.map((row) => displayWidth(row.mode)));
    const lines = rows.map((row) =>
      [
        ` ${mark(theme, row.mark)} ${theme.bold(padToDisplayWidth(row.target, targetWidth))}`,
        paint("text", padToDisplayWidth(row.task, taskWidth)),
        paint(row.mark.color, padToDisplayWidth(row.state, stateWidth)),
        paint("muted", padToDisplayWidth(row.mode, modeWidth)),
        paint(row.overdue ? "warning" : "dim", row.deadline),
        row.attention.length > 0
          ? paint("warning", `${ATTENTION_GLYPH} ${row.attention.join(", ")}`)
          : "",
      ]
        .join("  ")
        .trimEnd(),
    );
    const heading = paint(
      "muted",
      UI_COPY.count.unsettledDispatches(details.list.length),
    );
    const taskLines = (details.tasks ?? []).map((task) => {
      const row = boardTaskRow(task, details.team);
      return ` ${mark(theme, row.mark)} ${theme.bold(row.title)}  ${paint(row.mark.color, row.state)}  ${paint("muted", [row.mode, row.role, row.stage].filter(Boolean).join(" · "))}`;
    });
    return new Text(
      [
        ...(taskLines.length > 0
          ? [paint("accent", UI_COPY.manager.taskBoardHeading()), ...taskLines]
          : []),
        heading,
        ...lines,
      ].join("\n"),
      0,
      0,
    );
  }

  const dispatch = details.dispatch;
  if (!dispatch) return undefined;
  const state = lifecycleMark(dispatch);
  const task = sanitizeLine(
    dispatch.task.split(/\r?\n/u).find((line) => line.trim()) ?? UI_COPY.common.untitledDispatch(),
    72,
  );
  const header = [
    `${mark(theme, state)} ${theme.bold(sanitizeLine(dispatch.targetAgentLabel, 24))}`,
    paint("text", task),
    paint(state.color, state.label),
    paint("muted", UI_COPY.state.mode(dispatch.mode)),
  ].join("  ");
  const deadline = relativeDeadline(dispatch.deadlineAt, now);
  const lines = [
    header,
    `   ${paint(now > dispatch.deadlineAt ? "warning" : "dim", UI_COPY.common.deadline(deadline))}  ${paint(
      "muted",
      shortenPath(dispatch.targetCwd, 44),
    )}`,
  ];
  for (const record of details.attention ?? []) {
    lines.push(
      `   ${paint("warning", `${ATTENTION_GLYPH} ${UI_COPY.state.attention(record.condition)}`)}  ${paint(
        "dim",
        relativeAge(record.addedAt, now),
      )}`,
    );
  }
  if (expanded && dispatch.worktreePath) {
    lines.push(`   ${paint("dim", UI_COPY.common.worktree(shortenPath(dispatch.worktreePath, 44)))}`);
  }
  if (expanded) {
    lines.push(`   ${paint("dim", UI_COPY.common.dispatch(sanitizeLine(dispatch.id, 120)))}`);
    lines.push(`   ${paint("dim", UI_COPY.common.terminal(shortenId(dispatch.targetTerminalId)))}`);
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
      : [paint("dim", UI_COPY.presentation.inspectionEarlierLines(body.length - 12))]),
  ];
  return new Text(lines.join("\n"), 0, 0);
}

export interface ConfirmationResultDetails {
  status?: string;
  dispatchId?: string;
  outcome?: string;
  reason?: string;
  remainingQuota?: number;
}

export function renderConfirmationResult(
  details: ConfirmationResultDetails | undefined,
  theme: Theme,
): Text | undefined {
  if (!details?.status) return undefined;
  const paint = fg(theme);
  switch (details.status) {
    case "active":
      return new Text(
        `${paint("success", "✓")} ${paint("success", UI_COPY.presentation.dispatchActive())} ${paint("dim", UI_COPY.presentation.deliveryEchoVerified())}`,
        0,
        0,
      );
    case "delivery-unverified":
      return new Text(
        [
          `${paint("warning", "◌")} ${paint("warning", UI_COPY.presentation.dispatchDeliveryUnverified())}`,
          paint("dim", UI_COPY.presentation.reservationsNeverResent()),
        ].join("\n"),
        0,
        0,
      );
    case "failed":
      return new Text(
        `${paint("error", "✗")} ${paint("error", UI_COPY.presentation.dispatchNotSent())} ${paint(
          "dim",
          `· ${sanitizeLine(details.reason ?? UI_COPY.presentation.deliveryRejected(), 80)}`,
        )}`,
        0,
        0,
      );
    case "already-settled": {
      const state = outcomeMark(details.outcome ?? "?");
      return new Text(
        `${mark(theme, state)} ${paint("muted", UI_COPY.presentation.dispatchAlreadySettled(state.label))}`,
        0,
        0,
      );
    }
    case "cancelled":
      return new Text(paint("muted", UI_COPY.presentation.proposalCancelled()), 0, 0);
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
  if (!card) return new Text(paint("dim", content || UI_COPY.presentation.dispatchResultFallback()), 0, 0);

  const state = outcomeMark(card.outcome);
  const summary = card.summary ? sanitizeLine(card.summary, 160) : "";
  const agent = sanitizeLine(card.agentLabel ?? UI_COPY.common.dispatchFallback(), 24);
  const headline = `${mark(theme, state)} ${paint(state.color, `${agent} ${state.label}`)}`;

  const lines = [headline];
  if (card.taskSummary) lines.push(`   ${paint("text", sanitizeLine(card.taskSummary, 100))}`);
  if (summary) lines.push(`   ${paint("text", summary)}`);
  if (card.blocker) {
    lines.push(`   ${paint("warning", UI_COPY.presentation.blocker(sanitizeLine(card.blocker, 160)))}`);
  }
  if (expanded) {
    for (const [label, items] of [
      [UI_COPY.presentation.resultListLabel("tests"), card.tests],
      [UI_COPY.presentation.resultListLabel("files"), card.changedFiles],
      [UI_COPY.presentation.resultListLabel("artifacts"), card.artifacts],
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
    lines.push(
      paint("dim", `   ${UI_COPY.common.dispatch(sanitizeLine(card.dispatchId, 120))}`),
    );
  } else if (card.tests?.length || card.changedFiles?.length) {
    lines.push(
      paint(
        "dim",
        `   ${UI_COPY.presentation.resultCounts(card.changedFiles?.length ?? 0, card.tests?.length ?? 0)}`,
      ),
    );
  }
  return new Text(lines.join("\n"), 0, 0);
}

export interface WidgetCounts {
  delivering: number;
  active: number;
  attention: number;
  unseenDone: number;
  autoRunArmed: boolean;
  draftTasks?: number;
  reviewTasks?: number;
}

/** Themed one-line widget: counts colored only when they demand attention; an armed Auto Run stays visible even when quiet. */
export function renderDispatchWidget(counts: WidgetCounts, theme: Theme): Text {
  const paint = fg(theme);
  const copy = UI_COPY.presentation.widget(counts);
  const label = copy.autoRun
    ? `${paint("dim", UI_COPY.presentation.widgetLabel())} ${paint("accent", copy.autoRun)}`
    : paint("dim", UI_COPY.presentation.widgetLabel());
  const segments = [
    copy.drafts
      ? paint(taskStateMark("draft").color, `${taskStateMark("draft").glyph} ${copy.drafts}`)
      : "",
    copy.reviews
      ? paint(taskStateMark("review").color, `${taskStateMark("review").glyph} ${copy.reviews}`)
      : "",
    copy.delivering ? paint("warning", `◌ ${copy.delivering}`) : "",
    copy.running ? paint("accent", `● ${copy.running}`) : "",
    copy.attention ? paint("warning", `${ATTENTION_GLYPH} ${copy.attention}`) : "",
    copy.done ? paint("success", `✓ ${copy.done}`) : "",
  ].filter(Boolean);
  if (segments.length === 0) {
    if (!copy.autoRun) return new Text(paint("dim", UI_COPY.presentation.widgetQuiet()), 0, 0);
    return new Text(`${label}${paint("dim", UI_COPY.presentation.widgetManagerHint())}`, 0, 0);
  }
  return new Text(
    `${label}  ${segments.join(
      paint("dim", UI_COPY.presentation.widgetSeparator()),
    )}${paint("dim", UI_COPY.presentation.widgetManagerHint())}`,
    0,
    0,
  );
}
