import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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
});

export function createDispatchProposalToolDefinition(): ToolDefinition<
  typeof proposalParameters,
  Record<string, never>
> {
  return {
    name: "herdr_dispatch_propose",
    label: "Propose Herdr Dispatch",
    description:
      "Prepare a human-confirmed proposal to send work to an existing Agent in the current Herdr workspace.",
    promptSnippet: "Propose confirmed work for an existing Agent in the current Herdr workspace",
    promptGuidelines: [HERDR_DISPATCH_PROMPT_GUIDELINE],
    parameters: proposalParameters,
    async execute() {
      throw new Error("herdr_dispatch_propose is not available until Phase 4 is implemented");
    },
  };
}
