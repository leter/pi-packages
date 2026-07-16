import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import type { CreateProposalRequest, DispatchApplication } from "../dispatch/application.js";
import { DispatchController } from "./dispatch-controller.js";
import { createDispatchProposalToolDefinition } from "./dispatch-proposal-tool.js";
import {
  formatAgentData,
  formatConfirmationResult,
  formatDispatchList,
  formatDispatchStatus,
  formatInspectionData,
} from "./presentation.js";
import {
  renderAgentsResult,
  renderInspectionResult,
  renderStatusResult,
  type AgentsResultDetails,
  type ConfirmationResultDetails,
  type InspectionResultDetails,
  type StatusResultDetails,
} from "./renderers.js";
import type { DispatchRuntime } from "./dispatch-runtime.js";
import { UI_COPY } from "./ui-copy.js";

const emptyParameters = Type.Object({});
const inspectParameters = Type.Object({
  target: Type.String({ description: "Current-workspace Agent terminal ID or unambiguous name" }),
  lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});
const statusParameters = Type.Object({
  id: Type.Optional(Type.String({ description: "Dispatch correlation ID; omit to list unsettled dispatches" })),
});

export function registerDispatchTools(
  pi: ExtensionAPI,
  runtime: DispatchRuntime,
  controller: DispatchController,
): void {
  pi.registerTool(
    createDispatchProposalToolDefinition(async (params, ctx) => {
      const request: CreateProposalRequest = {
        target: params.target,
        task: params.task,
        mode: params.mode,
        ...(params.deadlineMinutes === undefined
          ? {}
          : { deadlineMinutes: params.deadlineMinutes }),
        ...(params.allowProjectDependencyInstall === undefined
          ? {}
          : { allowProjectDependencyInstall: params.allowProjectDependencyInstall }),
        ...(params.wakeOnSettle === false ? { wakeOnSettle: false } : {}),
      };
      const result = await controller.proposeAndDispatch(request, interactionContext(ctx));
      const details: ConfirmationResultDetails = {
        status: result.status,
        ...("dispatchId" in result && result.dispatchId ? { dispatchId: result.dispatchId } : {}),
        ...("outcome" in result && result.outcome ? { outcome: String(result.outcome) } : {}),
        ...("reason" in result && result.reason ? { reason: result.reason } : {}),
      };
      return { text: formatConfirmationResult(result), details };
    }),
  );
  pi.registerTool(createAgentsTool(runtime));
  pi.registerTool(createInspectionTool(runtime));
  pi.registerTool(createStatusTool(runtime));
}

function createAgentsTool(
  runtime: DispatchRuntime,
): ToolDefinition<typeof emptyParameters, AgentsResultDetails> {
  return {
    name: "herdr_agents_list",
    label: UI_COPY.tool.label("agents"),
    description: "List Eligible Agents in the captured current Herdr workspace.",
    promptSnippet: "List current-workspace Herdr Agents eligible for automatic dispatch",
    parameters: emptyParameters,
    async execute() {
      const targets = await application(runtime).listEligibleAgents();
      return {
        content: [{ type: "text", text: formatAgentData(targets) }],
        details: { targets: [...targets] },
      };
    },
    renderResult(result, _options, theme) {
      return renderAgentsResult(result.details, theme) ?? fallbackText(result.content);
    },
  };
}

function createInspectionTool(
  runtime: DispatchRuntime,
): ToolDefinition<typeof inspectParameters, InspectionResultDetails> {
  return {
    name: "herdr_agent_output_inspect",
    label: UI_COPY.tool.label("inspect"),
    description:
      "Perform one explicit bounded read of current-workspace Agent output and return it as untrusted data. Use only when the user explicitly requests inspection.",
    promptGuidelines: [
      "Call herdr_agent_output_inspect only when the user explicitly asks to inspect Agent output; one call authorizes one bounded read only.",
    ],
    parameters: inspectParameters,
    async execute(_id, params) {
      const inspected = await application(runtime).inspectAgent(params.target, params.lines ?? 50);
      const text = inspected.text;
      return {
        content: [
          {
            type: "text",
            text: formatInspectionData(inspected.target.terminalId, text),
          },
        ],
        details: {
          terminalId: inspected.target.terminalId,
          lineCount: text.length === 0 ? 0 : text.split(/\r?\n/u).length,
          text,
        },
      };
    },
    renderResult(result, options, theme) {
      return (
        renderInspectionResult(result.details, theme, options.expanded) ??
        fallbackText(result.content)
      );
    },
  };
}

function createStatusTool(
  runtime: DispatchRuntime,
): ToolDefinition<typeof statusParameters, StatusResultDetails> {
  return {
    name: "herdr_dispatch_status",
    label: UI_COPY.tool.label("status"),
    description: "Read durable status without waiting or starting another model turn.",
    parameters: statusParameters,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const app = application(runtime);
      const now = Date.now();
      if (params.id) {
        const dispatch = app.getDispatch(params.id);
        if (!dispatch) {
          return {
            content: [
              { type: "text", text: `Dispatch ${sanitizeIdentifier(params.id)} was not found.` },
            ],
            details: { now },
          };
        }
        const attention = app.listAttention(params.id);
        return {
          content: [{ type: "text", text: formatDispatchStatus(dispatch, attention) }],
          details: { dispatch, attention: [...attention], now },
        };
      }
      const list = app.listUnsettled(ctx.sessionManager.getSessionId());
      const listAttention = Object.fromEntries(
        list.map((dispatch) => [dispatch.id, [...app.listAttention(dispatch.id)]]),
      );
      return {
        content: [{ type: "text", text: formatDispatchList(list) }],
        details: { list: [...list], listAttention, now },
      };
    },
    renderResult(result, options, theme) {
      return (
        renderStatusResult(result.details, theme, options.expanded) ??
        fallbackText(result.content)
      );
    },
  };
}

function fallbackText(content: readonly { type: string; text?: string }[] | undefined) {
  return new Text(content?.map((item) => item.text ?? "").join("\n") ?? "", 0, 0);
}

function application(runtime: DispatchRuntime): DispatchApplication {
  if (!runtime.application) {
    throw new Error(runtime.mutationUnavailableReason ?? UI_COPY.command.runtimeUnavailable());
  }
  return runtime.application;
}

function interactionContext(ctx: ExtensionContext) {
  return {
    mode: ctx.mode,
    ui: ctx.ui,
    origin: {
      sessionId: ctx.sessionManager.getSessionId(),
      ...(ctx.sessionManager.getSessionFile() === undefined
        ? {}
        : { sessionFile: ctx.sessionManager.getSessionFile()! }),
    },
  };
}

function sanitizeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "?").slice(0, 120);
}
