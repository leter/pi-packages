import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolCallEventResult,
  UserBashEvent,
  UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

import {
  classifyHerdrShell,
  guardWorktreeOperation,
  type LeaseGuardContext,
  type SafetyDecision,
} from "../safety/policy.js";

export interface SafetyGateDependencies {
  currentPaneId(): string | undefined;
  getLeaseContext(request: {
    cwd: string;
    currentPaneId?: string;
  }): Promise<LeaseGuardContext> | LeaseGuardContext;
}

export interface SafetyEventContext {
  cwd: string;
}

export interface SafetyGate {
  onToolCall(
    event: ToolCallEvent,
    context: SafetyEventContext,
  ): Promise<ToolCallEventResult | undefined>;
  onUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined>;
}

export function createSafetyGate(dependencies: SafetyGateDependencies): SafetyGate {
  const currentPaneId = () => dependencies.currentPaneId();

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

        const leaseDecision = guardWorktreeOperation(
          { kind: "bash", cwd: context.cwd, command: event.input.command },
          await leaseContext(context.cwd),
        );
        if (leaseDecision.action === "deny") return blockTool(leaseDecision);
        return undefined;
      }

      if (isToolCallEventType("edit", event)) {
        const leaseDecision = guardWorktreeOperation(
          { kind: "edit", cwd: context.cwd, path: event.input.path },
          await leaseContext(context.cwd),
        );
        if (leaseDecision.action === "deny") return blockTool(leaseDecision);
      }

      if (isToolCallEventType("write", event)) {
        const leaseDecision = guardWorktreeOperation(
          { kind: "write", cwd: context.cwd, path: event.input.path },
          await leaseContext(context.cwd),
        );
        if (leaseDecision.action === "deny") return blockTool(leaseDecision);
      }

      return undefined;
    },

    async onUserBash(event) {
      const herdrDecision = classifyHerdrShell(event.command, {
        currentPaneId: currentPaneId(),
      });
      if (herdrDecision.action === "deny") return replaceUserBash(herdrDecision);

      const leaseDecision = guardWorktreeOperation(
        { kind: "bash", cwd: event.cwd, command: event.command },
        await leaseContext(event.cwd),
      );
      return leaseDecision.action === "deny" ? replaceUserBash(leaseDecision) : undefined;
    },
  };
}

export function registerSafetyGate(pi: ExtensionAPI, dependencies: SafetyGateDependencies): void {
  const gate = createSafetyGate(dependencies);
  pi.on("tool_call", gate.onToolCall);
  pi.on("user_bash", gate.onUserBash);
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
