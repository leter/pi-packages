import { HerdrProtocolError } from "./socket-client.js";

export const HERDR_PROTOCOL_VERSION = 16;

export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export type HerdrReadSource = "visible" | "recent" | "recent_unwrapped" | "detection";

export interface HerdrWorkspace {
  workspaceId: string;
  label: string;
  focused: boolean;
}

export interface HerdrAgentSession {
  source?: string;
  kind?: string;
  value?: string;
}

export interface HerdrPane {
  paneId: string;
  terminalId: string;
  workspaceId: string;
  tabId: string;
  focused: boolean;
  agentStatus: HerdrAgentStatus;
  revision: number;
  agent?: string;
  label?: string;
  cwd?: string;
  agentSession?: HerdrAgentSession;
}

export interface HerdrAgent extends HerdrPane {
  name?: string;
  screenDetectionSkipped: boolean;
}

export interface HerdrSnapshot {
  version: string;
  protocol: number;
  focusedWorkspaceId?: string;
  workspaces: HerdrWorkspace[];
  panes: HerdrPane[];
  agents: HerdrAgent[];
}

export interface HerdrPaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HerdrPaneLayout {
  workspaceId: string;
  tabId: string;
  panes: readonly { paneId: string; focused: boolean; rect: HerdrPaneRect }[];
}

export interface HerdrCreatedTab {
  tabId: string;
  workspaceId: string;
  focused: boolean;
  rootPane: HerdrPane;
}

export interface HerdrPaneRead {
  paneId: string;
  workspaceId: string;
  tabId: string;
  source: HerdrReadSource;
  format: "text" | "ansi";
  text: string;
  revision: number;
  truncated: boolean;
}

const AGENT_STATUSES = new Set<HerdrAgentStatus>(["idle", "working", "blocked", "done", "unknown"]);
const READ_SOURCES = new Set<HerdrReadSource>(["visible", "recent", "recent_unwrapped", "detection"]);

export function parseSnapshotResult(result: Record<string, unknown>): HerdrSnapshot {
  const snapshot = record(result.snapshot, "session_snapshot.snapshot");
  const protocol = nonnegativeInteger(snapshot.protocol, "snapshot.protocol");
  if (protocol !== HERDR_PROTOCOL_VERSION) {
    throw new HerdrProtocolError(
      `Herdr protocol ${protocol} is incompatible; protocol ${HERDR_PROTOCOL_VERSION} is required`,
    );
  }
  const focusedWorkspaceId = optionalString(snapshot.focused_workspace_id, "snapshot.focused_workspace_id");
  return {
    version: string(snapshot.version, "snapshot.version"),
    protocol,
    ...(focusedWorkspaceId === undefined ? {} : { focusedWorkspaceId }),
    workspaces: array(snapshot.workspaces, "snapshot.workspaces").map(parseWorkspace),
    panes: array(snapshot.panes, "snapshot.panes").map((pane, index) =>
      parsePane(record(pane, `snapshot.panes[${index}]`)),
    ),
    agents: array(snapshot.agents, "snapshot.agents").map((agent, index) =>
      parseAgent(record(agent, `snapshot.agents[${index}]`)),
    ),
  };
}

export function parsePaneInfoResult(result: Record<string, unknown>): HerdrPane {
  return parsePane(record(result.pane, "pane_info.pane"));
}

export function parsePaneReadResult(result: Record<string, unknown>): HerdrPaneRead {
  return parsePaneRead(record(result.read, "pane_read.read"));
}

export function parsePaneLayoutResult(result: Record<string, unknown>): HerdrPaneLayout {
  const layout = record(result.layout, "pane_layout.layout");
  return {
    workspaceId: string(layout.workspace_id, "pane layout workspace_id"),
    tabId: string(layout.tab_id, "pane layout tab_id"),
    panes: array(layout.panes, "pane layout panes").map((value, index) => {
      const pane = record(value, `pane layout panes[${index}]`);
      return {
        paneId: string(pane.pane_id, "pane layout pane_id"),
        focused: boolean(pane.focused, "pane layout focused"),
        rect: parsePaneRect(record(pane.rect, "pane layout rect")),
      };
    }),
  };
}

export function parseTabCreatedResult(result: Record<string, unknown>): HerdrCreatedTab {
  const tab = record(result.tab, "tab_created.tab");
  return {
    tabId: string(tab.tab_id, "tab_created tab_id"),
    workspaceId: string(tab.workspace_id, "tab_created workspace_id"),
    focused: boolean(tab.focused, "tab_created focused"),
    rootPane: parsePane(record(result.root_pane, "tab_created.root_pane")),
  };
}

export function parsePaneRead(value: Record<string, unknown>): HerdrPaneRead {
  const source = string(value.source, "pane read source");
  if (!READ_SOURCES.has(source as HerdrReadSource)) {
    throw new HerdrProtocolError(`unknown pane read source ${source}`);
  }
  const format = string(value.format, "pane read format");
  if (format !== "text" && format !== "ansi") {
    throw new HerdrProtocolError(`unknown pane read format ${format}`);
  }
  return {
    paneId: string(value.pane_id, "pane read pane_id"),
    workspaceId: string(value.workspace_id, "pane read workspace_id"),
    tabId: string(value.tab_id, "pane read tab_id"),
    source: source as HerdrReadSource,
    format,
    text: string(value.text, "pane read text"),
    revision: nonnegativeInteger(value.revision, "pane read revision"),
    truncated: boolean(value.truncated, "pane read truncated"),
  };
}

function parseWorkspace(value: unknown, index: number): HerdrWorkspace {
  const workspace = record(value, `snapshot.workspaces[${index}]`);
  return {
    workspaceId: string(workspace.workspace_id, "workspace.workspace_id"),
    label: string(workspace.label, "workspace.label"),
    focused: boolean(workspace.focused, "workspace.focused"),
  };
}

export function parsePane(value: Record<string, unknown>): HerdrPane {
  const status = string(value.agent_status, "pane.agent_status");
  if (!AGENT_STATUSES.has(status as HerdrAgentStatus)) {
    throw new HerdrProtocolError(`unknown pane agent_status ${status}`);
  }
  const agent = optionalString(value.agent, "pane.agent");
  const label = optionalString(value.label, "pane.label");
  const cwd = optionalString(value.cwd, "pane.cwd");
  const agentSession = optionalAgentSession(value.agent_session, "pane.agent_session");
  return {
    paneId: string(value.pane_id, "pane.pane_id"),
    terminalId: string(value.terminal_id, "pane.terminal_id"),
    workspaceId: string(value.workspace_id, "pane.workspace_id"),
    tabId: string(value.tab_id, "pane.tab_id"),
    focused: boolean(value.focused, "pane.focused"),
    agentStatus: status as HerdrAgentStatus,
    revision: nonnegativeInteger(value.revision, "pane.revision"),
    ...(agent === undefined ? {} : { agent }),
    ...(label === undefined ? {} : { label }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(agentSession === undefined ? {} : { agentSession }),
  };
}

function parseAgent(value: Record<string, unknown>): HerdrAgent {
  if (value.screen_detection_skipped !== undefined && typeof value.screen_detection_skipped !== "boolean") {
    throw new HerdrProtocolError("agent.screen_detection_skipped must be a boolean when present");
  }
  const name = optionalString(value.name, "agent.name");
  return {
    ...parsePane(value),
    ...(name === undefined ? {} : { name }),
    screenDetectionSkipped: value.screen_detection_skipped === true,
  };
}

function parsePaneRect(value: Record<string, unknown>): HerdrPaneRect {
  return {
    x: nonnegativeInteger(value.x, "pane rect x"),
    y: nonnegativeInteger(value.y, "pane rect y"),
    width: nonnegativeInteger(value.width, "pane rect width"),
    height: nonnegativeInteger(value.height, "pane rect height"),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HerdrProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new HerdrProtocolError(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new HerdrProtocolError(`${label} must be a string`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return string(value, label);
}

function optionalAgentSession(value: unknown, label: string): HerdrAgentSession | undefined {
  if (value === undefined) return undefined;
  const session = record(value, label);
  const source = optionalString(session.source, `${label}.source`);
  const kind = optionalString(session.kind, `${label}.kind`);
  const sessionValue = optionalString(session.value, `${label}.value`);
  return {
    ...(source === undefined ? {} : { source }),
    ...(kind === undefined ? {} : { kind }),
    ...(sessionValue === undefined ? {} : { value: sessionValue }),
  };
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new HerdrProtocolError(`${label} must be a boolean`);
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new HerdrProtocolError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}
