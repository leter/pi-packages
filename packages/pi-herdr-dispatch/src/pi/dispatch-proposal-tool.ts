import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { renderConfirmationResult, type ConfirmationResultDetails } from "./renderers.js";
import { UI_COPY } from "./ui-copy.js";

export const HERDR_DISPATCH_PROMPT_GUIDELINE =
  "Use herdr_dispatch_propose for every request to task another Herdr Agent. Do not use bash, user_bash, or raw herdr pane / herdr agent / herdr wait commands to send work or wait for it.";

const proposalParameters = Type.Object({
  target: Type.String({ description: "Existing Herdr Agent terminal ID or unambiguous Agent name" }),
  task: Type.String({ description: "Self-contained work request" }),
  mode: StringEnum(["non-mutating", "write"] as const, {
    description: "Whether local worktree changes are permitted",
  }),
  deadlineMinutes: Type.Optional(
    Type.Number({ minimum: 1, maximum: 1440, description: "Requested deadline in minutes" }),
  ),
  allowProjectDependencyInstall: Type.Optional(
    Type.Boolean({ description: "Explicitly allow project-local dependency installation" }),
  ),
  wakeOnSettle: Type.Optional(
    Type.Boolean({
      description:
        "Set false to downgrade this dispatch so its settlement never triggers an Auto Run turn; it cannot enable Auto Run, which only the user arms",
    }),
  ),
  taskId: Type.Optional(
    Type.String({
      pattern: "^hdt_[A-Za-z0-9_-]{1,100}$",
      description: "Exact approved Board Task ID to bind to this fresh dispatch",
    }),
  ),
});

export interface DispatchProposalToolParams {
  target: string;
  task: string;
  mode: "non-mutating" | "write";
  deadlineMinutes?: number;
  allowProjectDependencyInstall?: boolean;
  wakeOnSettle?: boolean;
  taskId?: string;
}

export interface DispatchProposalToolOutcome {
  text: string;
  details: ConfirmationResultDetails;
}

export type DispatchProposalToolHandler = (
  params: DispatchProposalToolParams,
  ctx: ExtensionContext,
) => Promise<DispatchProposalToolOutcome>;

export function createDispatchProposalToolDefinition(
  handler?: DispatchProposalToolHandler,
): ToolDefinition<typeof proposalParameters, ConfirmationResultDetails> {
  return {
    name: "herdr_dispatch_propose",
    label: UI_COPY.tool.label("propose"),
    description:
      "Send work to an existing Agent in the current Herdr workspace without a confirmation prompt.",
    promptSnippet: "Send work to an existing Agent in the current Herdr workspace",
    promptGuidelines: [HERDR_DISPATCH_PROMPT_GUIDELINE],
    parameters: proposalParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!handler) throw new Error("herdr_dispatch_propose handler is not configured");
      const outcome = await handler(params, ctx);
      return { content: [{ type: "text", text: outcome.text }], details: outcome.details };
    },
    renderResult(result, _options, theme) {
      return (
        renderConfirmationResult(result.details, theme) ??
        new Text(resultText(result.content), 0, 0)
      );
    },
  };
}

function resultText(content: readonly { type: string; text?: string }[] | undefined): string {
  return content?.map((item) => item.text ?? "").join("\n") ?? "";
}
