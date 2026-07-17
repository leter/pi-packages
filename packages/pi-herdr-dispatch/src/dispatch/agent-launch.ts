import type { CurrentWorkspaceSnapshot } from "../herdr/adapter.js";
import type {
  HerdrAgentSession,
  HerdrCreatedTab,
  HerdrPane,
  HerdrPaneLayout,
} from "../herdr/protocol.js";
import type { ProposalTarget } from "./proposal.js";

export const SUPPORTED_AGENT_TYPES = [
  "pi",
  "claude",
  "codex",
  "opencode",
  "amp",
  "droid",
  "grok",
] as const;

export type SupportedAgentType = (typeof SUPPORTED_AGENT_TYPES)[number];

export const SCREEN_DETECTION_AGENT_TYPES = new Set<SupportedAgentType>([
  "amp",
  "droid",
  "grok",
]);

export interface ReportedProvenanceEvidence {
  screenDetectionSkipped: boolean;
  agentSession?: HerdrAgentSession;
}

export function hasReportedProvenance(
  agent: ReportedProvenanceEvidence,
  expectedAgentType: string,
): boolean {
  return agent.screenDetectionSkipped === true ||
    agent.agentSession?.source === `herdr:${expectedAgentType}`;
}

export type AgentLaunchLayout = "adaptive" | "right" | "down" | "new-tab";
export type AgentSplitDirection = "right" | "down";

export interface HerdrAgentLaunchPort {
  paneLayout(paneId: string): Promise<HerdrPaneLayout>;
  createSplitPane(input: {
    targetPaneId: string;
    direction: AgentSplitDirection;
    cwd: string;
    ratio: number;
  }): Promise<HerdrPane>;
  createTab(input: { cwd: string; label: string }): Promise<HerdrCreatedTab>;
  renamePane(paneId: string, label: string): Promise<void>;
  startAgentExecutable(paneId: string, executable: string): Promise<void>;
  currentWorkspaceSnapshot(): Promise<CurrentWorkspaceSnapshot>;
}

export interface AgentLaunchRequest {
  agentType: SupportedAgentType;
  layout: AgentLaunchLayout;
  cwd: string;
  label: string;
  signal?: AbortSignal;
}

export interface AgentLaunchServiceOptions {
  herdr: HerdrAgentLaunchPort;
  workspaceId: string;
  originPaneId: string;
  startupTimeoutMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class AgentLaunchError extends Error {
  readonly createdPane?: HerdrPane;

  constructor(message: string, createdPane?: HerdrPane, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentLaunchError";
    this.createdPane = createdPane;
  }
}

export class AgentLaunchCancelledError extends AgentLaunchError {
  constructor(createdPane?: HerdrPane) {
    super("Agent startup wait was cancelled", createdPane);
    this.name = "AgentLaunchCancelledError";
  }
}

export class AgentLaunchTimeoutError extends AgentLaunchError {
  constructor(createdPane: HerdrPane) {
    super("Agent did not become eligible before the startup timeout", createdPane);
    this.name = "AgentLaunchTimeoutError";
  }
}

export class AgentLaunchService {
  readonly #herdr: HerdrAgentLaunchPort;
  readonly #workspaceId: string;
  readonly #originPaneId: string;
  readonly #startupTimeoutMs: number;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(options: AgentLaunchServiceOptions) {
    this.#herdr = options.herdr;
    this.#workspaceId = required(options.workspaceId, "workspaceId");
    this.#originPaneId = required(options.originPaneId, "originPaneId");
    if (
      !Number.isSafeInteger(options.startupTimeoutMs) ||
      options.startupTimeoutMs < 5_000 ||
      options.startupTimeoutMs > 300_000
    ) {
      throw new RangeError("startupTimeoutMs must be an integer from 5000 to 300000");
    }
    this.#startupTimeoutMs = options.startupTimeoutMs;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async launch(request: AgentLaunchRequest): Promise<ProposalTarget> {
    validateRequest(request);
    assertNotAborted(request.signal);

    let createdPane: HerdrPane | undefined;
    try {
      if (request.layout === "new-tab") {
        const created = await this.#herdr.createTab({ cwd: request.cwd, label: request.label });
        createdPane = created.rootPane;
      } else {
        const direction = await this.#splitDirection(request.layout);
        assertNotAborted(request.signal);
        createdPane = await this.#herdr.createSplitPane({
          targetPaneId: this.#originPaneId,
          direction,
          cwd: request.cwd,
          ratio: 0.5,
        });
      }
      assertNotAborted(request.signal, createdPane);
      await this.#herdr.renamePane(createdPane.paneId, request.label);
      assertNotAborted(request.signal, createdPane);
      await this.#herdr.startAgentExecutable(createdPane.paneId, request.agentType);
      assertNotAborted(request.signal, createdPane);
      return await this.#waitUntilEligible(createdPane, request.agentType, request.signal);
    } catch (error) {
      if (error instanceof AgentLaunchError) throw error;
      throw new AgentLaunchError(errorMessage(error), createdPane, { cause: error });
    }
  }

  async #splitDirection(layout: Exclude<AgentLaunchLayout, "new-tab">): Promise<AgentSplitDirection> {
    if (layout !== "adaptive") return layout;
    const current = await this.#herdr.paneLayout(this.#originPaneId);
    if (current.workspaceId !== this.#workspaceId) {
      throw new AgentLaunchError("Origin pane layout escaped the captured workspace");
    }
    const origin = current.panes.find((pane) => pane.paneId === this.#originPaneId);
    if (!origin) throw new AgentLaunchError("Origin pane is absent from its current layout");
    return adaptiveSplitDirection(origin.rect);
  }

  async #waitUntilEligible(
    createdPane: HerdrPane,
    expectedAgent: SupportedAgentType,
    signal?: AbortSignal,
  ): Promise<ProposalTarget> {
    const deadline = this.#now() + this.#startupTimeoutMs;
    while (true) {
      assertNotAborted(signal, createdPane);
      if (this.#now() >= deadline) throw new AgentLaunchTimeoutError(createdPane);
      const snapshot = await this.#herdr.currentWorkspaceSnapshot();
      if (this.#now() >= deadline) throw new AgentLaunchTimeoutError(createdPane);
      if (snapshot.workspace.workspaceId !== this.#workspaceId) {
        throw new AgentLaunchError("Herdr returned a different workspace while waiting", createdPane);
      }
      const pane = snapshot.panes.find((candidate) => candidate.terminalId === createdPane.terminalId);
      if (!pane || pane.paneId !== createdPane.paneId || pane.cwd !== createdPane.cwd) {
        throw new AgentLaunchError("Created Agent pane disappeared or changed identity", createdPane);
      }
      const agent = snapshot.agents.find((candidate) => candidate.terminalId === createdPane.terminalId);
      if (agent) {
        if (agent.paneId !== createdPane.paneId || agent.cwd !== createdPane.cwd) {
          throw new AgentLaunchError("Created Agent cwd or pane identity changed", createdPane);
        }
        const agentLabel = agent.agent ?? agent.name ?? agent.label;
        if (agentLabel !== expectedAgent) {
          throw new AgentLaunchError("Created pane reported a different Agent type", createdPane);
        }
        if (agent.agentStatus === "blocked") {
          throw new AgentLaunchError("Created Agent requires input before it can receive a dispatch", createdPane);
        }
        const reportedProvenance = hasReportedProvenance(agent, expectedAgent);
        if (
          (agent.agentStatus === "idle" || agent.agentStatus === "done") &&
          (reportedProvenance || SCREEN_DETECTION_AGENT_TYPES.has(expectedAgent))
        ) {
          assertNotAborted(signal, createdPane);
          return Object.freeze({
            terminalId: agent.terminalId,
            paneId: agent.paneId,
            workspaceId: agent.workspaceId,
            agentLabel,
            ...(agent.name === undefined ? {} : { displayName: agent.name }),
            cwd: agent.cwd!,
            status: agent.agentStatus,
            statusProvenance: reportedProvenance ? "reported" : "screen-detected",
          });
        }
      }
      const remainingMs = deadline - this.#now();
      if (remainingMs <= 0) throw new AgentLaunchTimeoutError(createdPane);
      await this.#sleep(Math.min(100, remainingMs));
    }
  }
}

export function adaptiveSplitDirection(rect: { width: number; height: number }): AgentSplitDirection {
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width < 0 || rect.height <= 0) {
    throw new RangeError("pane rectangle must have finite non-negative width and positive height");
  }
  return rect.width / rect.height >= 2 ? "right" : "down";
}

function assertNotAborted(signal?: AbortSignal, createdPane?: HerdrPane): void {
  if (signal?.aborted) throw new AgentLaunchCancelledError(createdPane);
}

function validateRequest(request: AgentLaunchRequest): void {
  if (!SUPPORTED_AGENT_TYPES.includes(request.agentType)) {
    throw new TypeError("agentType is not supported");
  }
  if (!["adaptive", "right", "down", "new-tab"].includes(request.layout)) {
    throw new TypeError("layout is not supported");
  }
  required(request.cwd, "cwd");
  required(request.label, "label");
}

function required(value: string, label: string): string {
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must not be empty or contain control characters`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
