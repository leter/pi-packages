import { DispatchFollowupService, type FollowupProposal } from "../dispatch/followup.js";
import type { FinalOutcome } from "../registry/types.js";
import type { ProposalUI } from "./dispatch-controller.js";
import { formatInspectionData } from "./presentation.js";

export interface FollowupContext {
  mode: "tui" | "rpc" | "json" | "print";
  ui: ProposalUI;
  sessionId: string;
}

export class FollowupController {
  readonly #service: () => DispatchFollowupService | undefined;

  constructor(service: () => DispatchFollowupService | undefined) {
    this.#service = service;
  }

  async reply(dispatchId: string, context: FollowupContext): Promise<string> {
    this.#assertTui(context);
    const reply = await context.ui.editor("Reply to the dispatch target");
    if (reply === undefined) return "Reply cancelled.";
    const proposal = await this.#service()!.prepareReply(dispatchId, context.sessionId, reply);
    return this.#confirmFollowup(proposal, context);
  }

  async cancel(dispatchId: string, context: FollowupContext): Promise<string> {
    this.#assertTui(context);
    const proposal = await this.#service()!.prepareCancellation(dispatchId, context.sessionId);
    return this.#confirmFollowup(proposal, context);
  }

  async resolve(dispatchId: string, context: FollowupContext): Promise<string> {
    this.#assertTui(context);
    const service = this.#service()!;
    const evidence = await service.resolutionEvidence(dispatchId);
    const emergency = evidence.dispatch.originSessionId !== context.sessionId;
    const evidenceText = `${formatInspectionData(evidence.dispatch.targetTerminalId, evidence.tail)}
Target status: ${evidence.targetStatus}
Worktree: ${evidence.dispatch.worktreePath ?? "none"}`;
    if (emergency) {
      const attested = await context.ui.confirm(
        "Emergency resolution attestation",
        `${evidenceText}

Origin Session: ${evidence.dispatch.originSessionId}
Attest that you have personally judged the Origin Session unavailable. No process-liveness inference was performed.`,
      );
      if (!attested) return "Emergency resolution cancelled before attestation.";
    }
    const outcome = await context.ui.select("Manual Final Outcome", ["failed", "cancelled"]);
    if (outcome !== "failed" && outcome !== "cancelled") return "Resolution cancelled.";
    const summary = await context.ui.editor("Bounded resolution summary");
    if (summary === undefined) return "Resolution cancelled.";
    const confirmed = await context.ui.confirm(
      emergency ? "Confirm emergency reservation release" : "Confirm manual reservation release",
      `${evidenceText}

Record ${outcome}, atomically release reservations, and accept first-wins settlement?${
        emergency ? " This does not transfer monitoring or inject context into this resolver." : ""
      }`,
    );
    if (!confirmed) return "Resolution cancelled at final confirmation.";
    const result = service.resolve({
      dispatchId,
      actorSessionId: context.sessionId,
      emergency,
      outcome,
      summary,
    });
    return result.status === "settled"
      ? `Dispatch ${dispatchId} settled ${result.outcome}.`
      : `Dispatch ${dispatchId} was already settled ${result.outcome}; first settlement won.`;
  }

  async #confirmFollowup(proposal: FollowupProposal, context: FollowupContext): Promise<string> {
    const preview = `${formatInspectionData(
      proposal.evidence.dispatch.targetTerminalId,
      proposal.evidence.tail,
    )}

${proposal.focusWarning}

Exact outbound bytes:
${proposal.payload}`;
    const choice = await context.ui.select(preview, ["Approve", "Cancel"]);
    if (choice !== "Approve") {
      this.#service()!.cancel(proposal);
      return `${proposal.kind === "reply" ? "Reply" : "Cancellation request"} cancelled.`;
    }
    const result = await this.#service()!.confirm(proposal);
    if (result.status === "verified") return `${proposal.kind} request delivery echo verified.`;
    if (result.status === "ambiguous") {
      return `${proposal.kind} request delivery is ambiguous; it was not resent.`;
    }
    return `${proposal.kind} request was proven not sent: ${result.reason}.`;
  }

  #assertTui(context: FollowupContext): void {
    if (context.mode !== "tui") throw new Error("Dispatch follow-up actions are available only in TUI mode");
    if (!this.#service()) throw new Error("Dispatch follow-up runtime is unavailable");
  }
}

export type { FinalOutcome };
