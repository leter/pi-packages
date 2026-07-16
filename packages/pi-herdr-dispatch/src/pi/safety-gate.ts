import {
  createLocalBashOperations,
  isToolCallEventType,
  type BashOperations,
  type ExtensionAPI,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ToolResultEvent,
  type UserBashEvent,
  type UserBashEventResult,
} from "@earendil-works/pi-coding-agent";

import {
  classifyHerdrShell,
  guardDispatchRegistryAccess,
  guardWorktreeOperation,
  type CoveredPiOperation,
  type LeaseGuardContext,
  type SafetyDecision,
} from "../safety/policy.js";
import { defaultRegistryPath } from "./registry-runtime.js";

export interface SafetyGateDependencies {
  currentPaneId(): string | undefined;
  getLeaseContext(request: {
    cwd: string;
    currentPaneId?: string;
  }): Promise<LeaseGuardContext> | LeaseGuardContext;
  /** Actual Registry database path; defaults to the standard state location. */
  registryDatabasePath?(): string;
  createLocalBashOperations?(): BashOperations;
}

export interface SafetyEventContext {
  cwd: string;
}

export interface SafetyToolResultPatch {
  content?: ToolResultEvent["content"];
  details?: unknown;
  isError?: boolean;
}

export interface SafetyGate {
  onToolCall(
    event: ToolCallEvent,
    context: SafetyEventContext,
  ): Promise<ToolCallEventResult | undefined>;
  onToolResult(event: ToolResultEvent): Promise<SafetyToolResultPatch | undefined>;
  onUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined>;
}

export const UNTRUSTED_HERDR_OUTPUT_OPEN = "<untrusted-herdr-cli-output>";
export const UNTRUSTED_HERDR_OUTPUT_CLOSE = "</untrusted-herdr-cli-output>";

export function createSafetyGate(dependencies: SafetyGateDependencies): SafetyGate {
  const currentPaneId = () => dependencies.currentPaneId();
  const framedToolCalls = new Set<string>();
  const registryGuard = (operation: CoveredPiOperation): SafetyDecision =>
    guardDispatchRegistryAccess(
      operation,
      dependencies.registryDatabasePath?.() ?? defaultRegistryPath(),
    );

  const leaseContext = async (cwd: string): Promise<LeaseGuardContext> => {
    try {
      return await dependencies.getLeaseContext({ cwd, currentPaneId: currentPaneId() });
    } catch (error) {
      return {
        leaseSnapshot: {
          status: "unavailable",
          reason: error instanceof Error ? error.message : "unknown Registry error",
        },
      };
    }
  };

  return {
    async onToolCall(event, context) {
      if (isToolCallEventType("bash", event)) {
        const herdrDecision = classifyHerdrShell(event.input.command, {
          currentPaneId: currentPaneId(),
        });
        if (herdrDecision.action === "deny") return blockTool(herdrDecision);

        const operation: CoveredPiOperation = {
          kind: "bash",
          cwd: context.cwd,
          command: event.input.command,
        };
        const registryDecision = registryGuard(operation);
        if (registryDecision.action === "deny") return blockTool(registryDecision);
        const leaseDecision = guardWorktreeOperation(operation, await leaseContext(context.cwd));
        if (leaseDecision.action === "deny") return blockTool(leaseDecision);
        if (herdrDecision.frameHerdrOutput) framedToolCalls.add(event.toolCallId);
        return undefined;
      }

      if (isToolCallEventType("edit", event)) {
        const operation: CoveredPiOperation = {
          kind: "edit",
          cwd: context.cwd,
          path: event.input.path,
        };
        const registryDecision = registryGuard(operation);
        if (registryDecision.action === "deny") return blockTool(registryDecision);
        const leaseDecision = guardWorktreeOperation(operation, await leaseContext(context.cwd));
        if (leaseDecision.action === "deny") return blockTool(leaseDecision);
      }

      if (isToolCallEventType("write", event)) {
        const operation: CoveredPiOperation = {
          kind: "write",
          cwd: context.cwd,
          path: event.input.path,
        };
        const registryDecision = registryGuard(operation);
        if (registryDecision.action === "deny") return blockTool(registryDecision);
        const leaseDecision = guardWorktreeOperation(operation, await leaseContext(context.cwd));
        if (leaseDecision.action === "deny") return blockTool(leaseDecision);
      }

      return undefined;
    },

    async onToolResult(event) {
      if (event.toolName !== "bash" || !framedToolCalls.delete(event.toolCallId)) {
        return undefined;
      }

      return {
        content: [
          { type: "text", text: `${UNTRUSTED_HERDR_OUTPUT_OPEN}\n` },
          ...event.content,
          { type: "text", text: `\n${UNTRUSTED_HERDR_OUTPUT_CLOSE}` },
        ],
      };
    },

    async onUserBash(event) {
      const herdrDecision = classifyHerdrShell(event.command, {
        currentPaneId: currentPaneId(),
      });
      if (herdrDecision.action === "deny") return replaceUserBash(herdrDecision);

      const operation: CoveredPiOperation = { kind: "bash", cwd: event.cwd, command: event.command };
      const registryDecision = registryGuard(operation);
      if (registryDecision.action === "deny") return replaceUserBash(registryDecision);
      const leaseDecision = guardWorktreeOperation(operation, await leaseContext(event.cwd));
      if (leaseDecision.action === "deny") return replaceUserBash(leaseDecision);
      if (!herdrDecision.frameHerdrOutput || event.excludeFromContext) return undefined;

      return {
        operations: frameBashOperations(
          dependencies.createLocalBashOperations?.() ?? createLocalBashOperations(),
        ),
      };
    },
  };
}

export function registerSafetyGate(pi: ExtensionAPI, dependencies: SafetyGateDependencies): void {
  const gate = createSafetyGate(dependencies);
  pi.on("tool_call", gate.onToolCall);
  pi.on("tool_result", gate.onToolResult);
  pi.on("user_bash", gate.onUserBash);
}

function frameBashOperations(operations: BashOperations): BashOperations {
  return {
    async exec(command, cwd, options) {
      options.onData(Buffer.from(`${UNTRUSTED_HERDR_OUTPUT_OPEN}\n`));
      try {
        return await operations.exec(command, cwd, options);
      } finally {
        options.onData(Buffer.from(`\n${UNTRUSTED_HERDR_OUTPUT_CLOSE}`));
      }
    },
  };
}

function blockTool(decision: Extract<SafetyDecision, { action: "deny" }>): ToolCallEventResult {
  return { block: true, reason: formatDenial(decision) };
}

function replaceUserBash(
  decision: Extract<SafetyDecision, { action: "deny" }>,
): UserBashEventResult {
  return {
    result: {
      output: `${formatDenial(decision)}\n`,
      exitCode: 126,
      cancelled: false,
      truncated: false,
    },
  };
}

function formatDenial(decision: Extract<SafetyDecision, { action: "deny" }>): string {
  const redirect = decision.redirect ? ` Use ${decision.redirect}.` : "";
  return `[pi-herdr-dispatch:${decision.code}] ${decision.reason}${redirect}`;
}
