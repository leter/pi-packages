import { randomBytes } from "node:crypto";

import type { DispatchConfig } from "../domain/config.js";
import type { HerdrDeliveryResult } from "../herdr/delivery.js";
import type { DispatchRegistry } from "../registry/registry.js";
import type { FinalOutcome, StoredDispatch } from "../registry/types.js";
import type { HerdrDispatchPort } from "./application.js";

export interface FollowupEvidence {
  dispatch: StoredDispatch;
  targetStatus: string;
  tail: string;
}

export interface FollowupProposal {
  readonly nonce: string;
  readonly dispatchId: string;
  readonly kind: "reply" | "cancel";
  readonly payload: string;
  readonly evidence: FollowupEvidence;
  readonly focusWarning: string;
}

export const FOLLOWUP_FOCUS_WARNING =
  "Focused-input warning: this text is sent to whatever prompt or dialog currently owns the target pane. It may be consumed as dialog keystrokes; there is no compare-and-send primitive.";

export class DispatchFollowupService {
  readonly #registry: DispatchRegistry;
  readonly #herdr: HerdrDispatchPort;
  readonly #config: DispatchConfig;
  readonly #workspaceId: string;
  readonly #now: () => number;
  readonly #nextNonce: () => string;
  readonly #onSettled: (dispatchId: string, outcome: FinalOutcome) => void;
  readonly #proposals = new Map<string, FollowupProposal>();

  constructor(options: {
    registry: DispatchRegistry;
    herdr: HerdrDispatchPort;
    config: DispatchConfig;
    workspaceId: string;
    now?: () => number;
    nextNonce?: () => string;
    onSettled?: (dispatchId: string, outcome: FinalOutcome) => void;
  }) {
    this.#registry = options.registry;
    this.#herdr = options.herdr;
    this.#config = options.config;
    this.#workspaceId = options.workspaceId;
    this.#now = options.now ?? Date.now;
    this.#nextNonce =
      options.nextNonce ?? (() => `hd_followup_${this.#now().toString(36)}_${randomBytes(8).toString("base64url")}`);
    this.#onSettled = options.onSettled ?? (() => undefined);
  }

  async prepareReply(
    dispatchId: string,
    actorSessionId: string,
    reply: string,
  ): Promise<FollowupProposal> {
    const evidence = await this.#evidence(dispatchId);
    this.#assertOrigin(evidence.dispatch, actorSessionId);
    if (evidence.dispatch.lifecycle !== "active") throw new Error("Replies require an Active Dispatch");
    if (this.#registry.listAttention(dispatchId).length === 0) {
      throw new Error("Replies require an Active Dispatch with an Attention Condition");
    }
    const text = boundedText(reply, "reply", 8_000);
    return this.#proposal(
      dispatchId,
      "reply",
      `[HERDR DISPATCH REPLY]\nDispatch ID: ${dispatchId}\nID: $NONCE\n\n${text}`,
      evidence,
    );
  }

  async replyEvidence(dispatchId: string, actorSessionId: string): Promise<FollowupEvidence> {
    const evidence = await this.#evidence(dispatchId);
    this.#assertOrigin(evidence.dispatch, actorSessionId);
    this.#assertReplyEligible(evidence.dispatch, dispatchId);
    return evidence;
  }

  async prepareCancellation(
    dispatchId: string,
    actorSessionId: string,
  ): Promise<FollowupProposal> {
    const evidence = await this.#evidence(dispatchId);
    this.#assertOrigin(evidence.dispatch, actorSessionId);
    this.#assertCancellationEligible(dispatchId);
    return this.#proposal(
      dispatchId,
      "cancel",
      `[HERDR DISPATCH CANCELLATION REQUEST]\nDispatch ID: ${dispatchId}\nID: $NONCE\n\nStop safely and print a cancelled Result Envelope for this dispatch. Do not run destructive cleanup.`,
      evidence,
    );
  }

  async confirm(proposal: FollowupProposal): Promise<HerdrDeliveryResult> {
    if (this.#proposals.get(proposal.nonce) !== proposal) {
      throw new Error("Follow-up proposal is stale, cancelled, or already consumed");
    }
    this.#proposals.delete(proposal.nonce);
    const current = this.#registry.getDispatch(proposal.dispatchId);
    if (!current || current.lifecycle === "settled") throw new Error("Dispatch is already settled");
    this.#assertWorkspace(current);
    if (proposal.kind === "reply") this.#assertReplyEligible(current, current.id);
    else this.#assertCancellationEligible(current.id);
    let result: HerdrDeliveryResult;
    try {
      result = await this.#herdr.deliverAndVerify(
        {
          target: {
            terminalId: current.targetTerminalId,
            expectedAgent: current.targetAgentLabel,
            expectedCwd: current.targetCwd,
            allowedStatuses: ["idle", "done", "working", "blocked", "unknown"],
          },
          correlationId: proposal.nonce,
          text: proposal.payload,
        },
        { echoWindowMs: this.#config.startupWindowMs },
      );
    } catch (error) {
      result = {
        status: "ambiguous",
        reason: "response-unknown",
        detail: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      };
    }
    this.#registry.recordAudit(
      current.id,
      `${proposal.kind}-request-${result.status}`,
      { nonce: proposal.nonce, ...(result.status === "ambiguous" ? { reason: result.reason } : {}) },
      this.#now(),
    );
    if (result.status === "ambiguous") {
      this.#registry.addAttention(
        current.id,
        "delivery-unverified",
        { action: proposal.kind, reason: result.reason, nonce: proposal.nonce },
        this.#now(),
      );
    }
    return result;
  }

  cancel(proposal: FollowupProposal): void {
    if (this.#proposals.get(proposal.nonce) === proposal) this.#proposals.delete(proposal.nonce);
  }

  async resolutionEvidence(dispatchId: string): Promise<FollowupEvidence> {
    return this.#evidence(dispatchId);
  }

  resolve(input: {
    dispatchId: string;
    actorSessionId: string;
    emergency: boolean;
    outcome: "failed" | "cancelled";
    summary: string;
  }): { status: "settled" | "already-settled"; outcome: FinalOutcome } {
    const dispatch = this.#registry.getDispatch(input.dispatchId);
    if (!dispatch) throw new Error(`Dispatch ${input.dispatchId} was not found`);
    this.#assertWorkspace(dispatch);
    const isOrigin = dispatch.originSessionId === input.actorSessionId;
    if (input.emergency === isOrigin) {
      throw new Error(
        isOrigin
          ? "Origin resolution must not be labelled emergency"
          : "Non-Origin resolution requires explicit emergency attestation",
      );
    }
    const summary = boundedText(input.summary, "resolution summary", 1_000);
    const result = this.#registry.settle({
      dispatchId: dispatch.id,
      outcome: input.outcome,
      sanitizedResult: {
        id: dispatch.id,
        outcome: input.outcome,
        summary,
        resolverSessionId: input.actorSessionId,
        emergency: input.emergency,
      },
      kind: input.emergency ? "emergency" : "manual",
      resolverSessionId: input.actorSessionId,
      settledAt: this.#now(),
    });
    if (result.status === "settled") this.#onSettled(dispatch.id, result.outcome);
    return result;
  }

  async #evidence(dispatchId: string): Promise<FollowupEvidence> {
    const dispatch = this.#registry.getDispatch(dispatchId);
    if (!dispatch || dispatch.lifecycle === "settled") {
      throw new Error(`Unsettled dispatch ${dispatchId} was not found`);
    }
    this.#assertWorkspace(dispatch);
    const resolved = await this.#herdr.resolveTerminal(dispatch.targetTerminalId);
    if (!resolved) {
      return { dispatch, targetStatus: "target-lost", tail: "" };
    }
    const tail = await this.#herdr.readTail(resolved.pane.paneId, 50);
    return { dispatch, targetStatus: resolved.pane.agentStatus, tail: tail.text };
  }

  #proposal(
    dispatchId: string,
    kind: "reply" | "cancel",
    template: string,
    evidence: FollowupEvidence,
  ): FollowupProposal {
    const nonce = this.#nextNonce();
    const proposal = Object.freeze({
      nonce,
      dispatchId,
      kind,
      payload: template.replace("$NONCE", nonce),
      evidence,
      focusWarning: FOLLOWUP_FOCUS_WARNING,
    });
    this.#proposals.set(nonce, proposal);
    return proposal;
  }

  #assertOrigin(dispatch: StoredDispatch, actorSessionId: string): void {
    if (dispatch.originSessionId !== actorSessionId) {
      throw new Error("Only the exact Origin Session may reply or request cancellation");
    }
  }

  #assertWorkspace(dispatch: StoredDispatch): void {
    if (dispatch.targetWorkspaceId !== this.#workspaceId) {
      throw new Error("Dispatch is outside the current Workspace Scope");
    }
  }

  #assertReplyEligible(dispatch: StoredDispatch, dispatchId: string): void {
    if (dispatch.lifecycle !== "active") throw new Error("Replies require an Active Dispatch");
    if (this.#registry.listAttention(dispatchId).length === 0) {
      throw new Error("Replies require an Active Dispatch with an Attention Condition");
    }
  }

  #assertCancellationEligible(dispatchId: string): void {
    if (
      this.#registry
        .listAttention(dispatchId)
        .some((record) => record.condition === "target-lost" || record.condition === "target-moved")
    ) {
      throw new Error("A lost or moved target can only be resolved manually");
    }
  }
}

function boundedText(value: string, label: string, maximum: number): string {
  const normalized = value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " ")
    .trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (normalized.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return normalized;
}
