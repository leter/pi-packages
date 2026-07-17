import {
  SUPPORTED_AGENT_TYPES,
  type SupportedAgentType,
} from "../dispatch/agent-launch.js";
import type { DispatchConfig } from "../domain/config.js";
import type { TeamCatalog } from "../domain/team.js";
import type { ViewLine, ViewSpan } from "./dispatch-view-model.js";
import { padToDisplayWidth, type SemanticColor } from "./visual.js";
import { UI_COPY } from "./ui-copy.js";

export type ConfigSettingKey =
  | "defaultRunQuota"
  | "defaultLaunchBudget"
  | "maxAutoRunDepth"
  | "defaultDeadlineMinutes";

export interface NumericSettingRow {
  kind: "config";
  key: ConfigSettingKey;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
}

export interface RoleAgentSettingRow {
  kind: "role-agent";
  roleKey: string;
  roleLabel: string;
  agent?: SupportedAgentType;
  agentIndex: number;
}

export type SettingRow = NumericSettingRow | RoleAgentSettingRow;

export interface SettingsViewState {
  rows: readonly SettingRow[];
  cursor: number;
}

export type SettingChange =
  | { kind: "config"; key: ConfigSettingKey; value: number }
  | { kind: "role-agent"; roleKey: string; agent: SupportedAgentType };

export interface SettingAdjustment<Row extends SettingRow> {
  row: Row;
  change: SettingChange;
}

const ROLE_KEYS = [
  "coder",
  "reviewer",
  "bugfix",
  "chore",
  "researcher",
  "advisor",
  "oracle",
] as const;

const span = (text: string, color: SemanticColor = "text", bold = false): ViewSpan =>
  bold ? { text, color, bold } : { text, color };

export function buildSettingsState(
  config: DispatchConfig,
  team: TeamCatalog,
  cursor = 0,
): SettingsViewState {
  const rows: SettingRow[] = [
    numericRow("defaultRunQuota", UI_COPY.settings.runQuota(), config.defaultRunQuota, 1, 50, 1),
    numericRow(
      "defaultLaunchBudget",
      UI_COPY.settings.launchBudget(),
      config.defaultLaunchBudget,
      0,
      10,
      1,
    ),
    numericRow("maxAutoRunDepth", UI_COPY.settings.autoRunDepth(), config.maxAutoRunDepth, 1, 20, 1),
    numericRow(
      "defaultDeadlineMinutes",
      UI_COPY.settings.deadlineMinutes(),
      config.defaultDeadlineMinutes,
      config.minDeadlineMinutes,
      config.maxDeadlineMinutes,
      5,
    ),
    ...ROLE_KEYS.map((roleKey): RoleAgentSettingRow => {
      const role = team.roles[roleKey];
      const agent = role?.agent;
      return {
        kind: "role-agent",
        roleKey,
        roleLabel: UI_COPY.state.role(roleKey),
        ...(agent === undefined ? {} : { agent }),
        agentIndex: agent === undefined ? -1 : SUPPORTED_AGENT_TYPES.indexOf(agent),
      };
    }),
  ];
  return { rows, cursor: clamp(cursor, 0, Math.max(0, rows.length - 1)) };
}

export function moveCursor(state: SettingsViewState, delta: number): SettingsViewState {
  return {
    ...state,
    cursor: clamp(state.cursor + delta, 0, Math.max(0, state.rows.length - 1)),
  };
}

export function stepNumeric(
  row: NumericSettingRow,
  direction: -1 | 1,
): SettingAdjustment<NumericSettingRow> {
  const value = clamp(row.value + row.step * direction, row.min, row.max);
  return {
    row: { ...row, value },
    change: { kind: "config", key: row.key, value },
  };
}

export function cycleAgent(
  row: RoleAgentSettingRow,
  direction: -1 | 1,
): SettingAdjustment<RoleAgentSettingRow> {
  const length = SUPPORTED_AGENT_TYPES.length;
  const agentIndex = row.agentIndex < 0
    ? direction > 0 ? 0 : length - 1
    : (row.agentIndex + direction + length) % length;
  const agent = SUPPORTED_AGENT_TYPES[agentIndex]!;
  return {
    row: { ...row, agent, agentIndex },
    change: { kind: "role-agent", roleKey: row.roleKey, agent },
  };
}

export function buildSettingsLines(state: SettingsViewState): ViewLine[] {
  const lines: ViewLine[] = [];
  for (const [index, row] of state.rows.entries()) {
    if (index === 0) lines.push(groupHeading(UI_COPY.settings.runtimeGroup()));
    if (index === 4) {
      lines.push({ spans: [] });
      lines.push(groupHeading(UI_COPY.settings.rolesGroup()));
    }
    const selected = index === state.cursor;
    const label = row.kind === "config" ? row.label : row.roleLabel;
    const value = row.kind === "config"
      ? String(row.value)
      : row.agent ?? UI_COPY.settings.noAgent();
    lines.push({
      selected,
      spans: [
        span(selected ? " → " : "   ", "accent", selected),
        span(padToDisplayWidth(label, 18), "text", true),
        span(value, "accent", selected),
      ],
    });
    if (row.kind === "config") {
      lines.push({
        selected,
        spans: [
          span("     ", "dim"),
          span(UI_COPY.settings.numericRange(row.min, row.max, row.step), "dim"),
        ],
      });
    }
  }
  if (lines.length === 0 || lines.at(-1)?.spans.length !== 0) lines.push({ spans: [] });
  return lines;
}

function numericRow(
  key: ConfigSettingKey,
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
): NumericSettingRow {
  return { kind: "config", key, label, value, min, max, step };
}

function groupHeading(label: string): ViewLine {
  return { spans: [span(label, "accent", true)] };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
