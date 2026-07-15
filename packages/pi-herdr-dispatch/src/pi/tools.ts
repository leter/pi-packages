import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
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
import type { DispatchRuntime } from "./dispatch-runtime.js";

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
      };
      const result = await controller.proposeAndConfirm(request, interactionContext(ctx));
      return formatConfirmationResult(result);
    }),
  );
  pi.registerTool(createAgentsTool(runtime));
  pi.registerTool(createInspectionTool(runtime));
  pi.registerTool(createStatusTool(runtime));
}

function createAgentsTool(
  runtime: DispatchRuntime,
): ToolDefinition<typeof emptyParameters, Record<string, never>> {
  return {
    name: "herdr_agents_list",
    label: "List Herdr Agents",
    description: "List Eligible Agents in the captured current Herdr workspace.",
    promptSnippet: "List current-workspace Herdr Agents eligible for confirmed dispatch",
    parameters: emptyParameters,
    async execute() {
      const targets = await application(runtime).listEligibleAgents();
      return { content: [{ type: "text", text: formatAgentData(targets) }], details: {} };
    },
  };
}

function createInspectionTool(
  runtime: DispatchRuntime,
): ToolDefinition<typeof inspectParameters, Record<string, never>> {
  return {
    name: "herdr_agent_output_inspect",
    label: "Inspect Herdr Agent Output",
    description:
      "Perform one explicit bounded read of current-workspace Agent output and return it as untrusted data. Use only when the user explicitly requests inspection.",
    promptGuidelines: [
      "Call herdr_agent_output_inspect only when the user explicitly asks to inspect Agent output; one call authorizes one bounded read only.",
    ],
    parameters: inspectParameters,
    async execute(_id, params) {
      const inspected = await application(runtime).inspectAgent(params.target, params.lines ?? 50);
      return {
        content: [
          {
            type: "text",
            text: formatInspectionData(inspected.target.terminalId, inspected.text),
          },
        ],
        details: {},
      };
    },
  };
}

function createStatusTool(
  runtime: DispatchRuntime,
): ToolDefinition<typeof statusParameters, Record<string, never>> {
  return {
    name: "herdr_dispatch_status",
    label: "Herdr Dispatch Status",
    description: "Read durable status without waiting or starting another model turn.",
    parameters: statusParameters,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const app = application(runtime);
      const text = params.id
        ? statusById(app, params.id)
        : formatDispatchList(app.listUnsettled(ctx.sessionManager.getSessionId()));
      return { content: [{ type: "text", text }], details: {} };
    },
  };
}

function statusById(application: DispatchApplication, dispatchId: string): string {
  const dispatch = application.getDispatch(dispatchId);
  if (!dispatch) return `Dispatch ${sanitizeIdentifier(dispatchId)} was not found.`;
  return formatDispatchStatus(dispatch, application.listAttention(dispatchId));
}

function application(runtime: DispatchRuntime): DispatchApplication {
  if (!runtime.application) {
    throw new Error(runtime.mutationUnavailableReason ?? "Dispatch runtime unavailable");
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
