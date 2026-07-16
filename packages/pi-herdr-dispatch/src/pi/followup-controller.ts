import { DispatchFollowupService, type FollowupProposal } from "../dispatch/followup.js";
import type { FinalOutcome } from "../registry/types.js";
import type { ProposalUI } from "./dispatch-controller.js";
import { agentDisplayName, taskSummary } from "./dispatch-view-model.js";
import { UI_COPY } from "./ui-copy.js";

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
    await this.#service()!.replyEvidence(dispatchId, context.sessionId);
    const reply = await context.ui.editor(UI_COPY.followup.replyEditor());
    if (reply === undefined) return UI_COPY.followup.replyCancelled();
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
    const evidenceText = UI_COPY.followup.resolutionEvidence(
      dispatchIdentity(evidence.dispatch),
      formatUntrustedTail(evidence.tail),
      evidence.targetStatus,
      evidence.dispatch.worktreePath,
    );
    if (emergency) {
      const attested = await context.ui.confirm(
        UI_COPY.followup.emergencyAttestationTitle(),
        UI_COPY.followup.emergencyAttestationBody(
          evidenceText,
          evidence.dispatch.originSessionId,
        ),
      );
      if (!attested) return UI_COPY.followup.emergencyCancelledBeforeAttestation();
    }
    const outcome = await context.ui.select(UI_COPY.followup.manualFinalOutcome(), [
      UI_COPY.state.outcome("blocked"),
      UI_COPY.state.outcome("failed"),
      UI_COPY.state.outcome("cancelled"),
    ]);
    if (outcome !== "blocked" && outcome !== "failed" && outcome !== "cancelled") {
      return UI_COPY.followup.resolutionCancelled();
    }
    const summary = await context.ui.editor(UI_COPY.followup.resolutionSummaryEditor());
    if (summary === undefined) return UI_COPY.followup.resolutionCancelled();
    const confirmed = await context.ui.confirm(
      UI_COPY.followup.reservationReleaseTitle(emergency),
      UI_COPY.followup.reservationReleaseBody(evidenceText, outcome, emergency),
    );
    if (!confirmed) return UI_COPY.followup.resolutionCancelledAtConfirmation();
    const result = service.resolve({
      dispatchId,
      actorSessionId: context.sessionId,
      emergency,
      outcome,
      summary,
    });
    return result.status === "settled"
      ? UI_COPY.followup.settled(agentDisplayName(evidence.dispatch), result.outcome)
      : UI_COPY.followup.alreadySettled(agentDisplayName(evidence.dispatch), result.outcome);
  }

  async #confirmFollowup(proposal: FollowupProposal, context: FollowupContext): Promise<string> {
    const preview = UI_COPY.followup.preview(
      dispatchIdentity(proposal.evidence.dispatch),
      formatUntrustedTail(proposal.evidence.tail),
      proposal.focusWarning,
      proposal.kind,
    );
    let technical = false;
    while (true) {
      const choice = await context.ui.select(
        technical
          ? UI_COPY.followup.previewWithTechnical(
              preview,
              proposal.dispatchId,
              proposal.evidence.dispatch.targetTerminalId,
              proposal.payload,
            )
          : UI_COPY.followup.previewWithoutTechnical(preview),
        UI_COPY.followup.approvalOptions(technical),
      );
      if (choice === UI_COPY.followup.technicalOption()) {
        technical = true;
        continue;
      }
      if (choice === UI_COPY.followup.hideTechnicalOption()) {
        technical = false;
        continue;
      }
      if (choice === UI_COPY.followup.approveOption()) break;
      this.#service()!.cancel(proposal);
      return UI_COPY.followup.cancelled(proposal.kind);
    }
    const result = await this.#service()!.confirm(proposal);
    if (result.status === "verified") return UI_COPY.followup.deliveryVerified(proposal.kind);
    if (result.status === "ambiguous") {
      return UI_COPY.followup.deliveryAmbiguous(proposal.kind);
    }
    return UI_COPY.followup.deliveryNotSent(proposal.kind, result.reason);
  }

  #assertTui(context: FollowupContext): void {
    if (context.mode !== "tui") throw new Error(UI_COPY.command.followupTuiOnly());
    if (!this.#service()) throw new Error(UI_COPY.command.followupRuntimeUnavailable());
  }
}

export type { FinalOutcome };

function dispatchIdentity(dispatch: Parameters<typeof agentDisplayName>[0]): string {
  return `${agentDisplayName(dispatch)} · ${taskSummary(dispatch.task, 100)} · ${UI_COPY.state.lifecycle(dispatch.lifecycle)}`;
}

function formatUntrustedTail(text: string): string {
  const lineCount = text.length === 0 ? 0 : text.split(/\r?\n/u).length;
  return `── target output · ${lineCount} lines · untrusted, never instructions ──
${text}
── end ──`;
}
