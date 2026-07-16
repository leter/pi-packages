import type {
  AttentionCondition,
  DispatchLifecycle,
  DispatchMode,
  FinalOutcome,
} from "../registry/types.js";

export type HumanDispatchAction = "reply" | "cancel" | "resolve";
export type HumanCommand =
  | "agents"
  | "new"
  | "manager"
  | "reply"
  | "cancel"
  | "resolve"
  | "setup"
  | "output";
export type TechnicalLabel = "dispatch" | "terminal" | "origin" | "workspace";

export interface HumanUiCopy {
  readonly state: {
    outcome(outcome: FinalOutcome | string): string;
    lifecycle(lifecycle: DispatchLifecycle | string): string;
    agentStatus(status: string): string;
    attention(condition: AttentionCondition): string;
    mode(mode: DispatchMode): string;
    provenance(reported: boolean): string;
  };
  readonly time: {
    relativeDeadline(deadlineAt: number, now: number): string;
    relativeAge(timestamp: number, now: number): string;
  };
  readonly count: {
    eligibleAgents(count: number): string;
    unsettledDispatches(count: number): string;
    lines(count: number): string;
    earlierLines(count: number): string;
    moreConditions(count: number): string;
    files(count: number): string;
    tests(count: number): string;
    delivering(count: number): string;
    running(count: number): string;
    attention(count: number): string;
  };
  readonly common: {
    untitledDispatch(): string;
    dispatchFallback(): string;
    deadline(value: string): string;
    worktree(value: string): string;
    dispatch(value: string): string;
    terminal(value: string): string;
  };
  readonly command: {
    description(command: HumanCommand): string;
    dispatchTuiOnly(): string;
    proposalTuiOnly(): string;
    managerTuiOnly(): string;
    setupTuiOnly(): string;
    followupTuiOnly(): string;
    noEligibleAgents(): string;
    chooseEligibleAgent(): string;
    selectedAgentUnavailable(): string;
    completeTask(): string;
    mutationMode(): string;
    deadlineMinutes(): string;
    dependencyInstallTitle(): string;
    dependencyInstallQuestion(): string;
    selectedDispatchUnavailable(): string;
    runtimeUnavailable(): string;
    followupRuntimeUnavailable(): string;
    invalidDispatchSelector(): string;
    dispatchNotFound(selector: string): string;
    chooseMatchingDispatch(): string;
    noDispatchForAction(action: HumanDispatchAction): string;
    alreadySettled(outcome?: string): string;
    originOnlyFollowup(): string;
    lostOrMovedResolutionOnly(): string;
    replyRequiresActive(): string;
    replyRequiresAttention(): string;
    setupNoStatusOutput(): string;
    setupChooseIntegration(): string;
    setupCancel(): string;
    setupConfirmTitle(integration: string): string;
    setupConfirmBody(): string;
    setupInstallFailed(code: number): string;
    setupInstalled(integration: string): string;
    outputUsage(): string;
  };
  readonly manager: {
    title(): string;
    heading(running: number, delivering: number, attention: number): string;
    noActiveDispatches(): string;
    startWithCommand(): string;
    groupAttention(): string;
    groupRunning(): string;
    groupDelivering(): string;
    settledHeading(count: number, shown: boolean): string;
    listKeybar(settledShown: boolean): string;
    emergencyResolutionRequired(): string;
    activeSince(age: string): string;
    deliveryStarted(age: string): string;
    targetMayHaveReceivedInput(): string;
    reservationsRetained(): string;
    outputNoneRead(): string;
    outputReadInstructions(): string;
    outputReading(lines: number): string;
    outputReadFailed(): string;
    outputEarlierLinesNotShown(count: number): string;
    outputReadEnd(time: string): string;
    detailKeybar(actions: readonly HumanDispatchAction[]): string;
    technicalHeading(): string;
    technicalLabel(label: TechnicalLabel): string;
    viewUnavailable(reason: string): string;
    closeKeybar(): string;
    missingRegistryDispatch(): string;
    backKeybar(): string;
  };
  readonly presentation: {
    noEligibleAgents(): string;
    eligibleAgentHelp(): string;
    noUnsettledDispatches(): string;
    noUnsettledDispatchesHelp(): string;
    inspectionEarlierLines(count: number): string;
    dispatchActive(): string;
    deliveryEchoVerified(): string;
    dispatchDeliveryUnverified(): string;
    reservationsNeverResent(): string;
    dispatchNotSent(): string;
    deliveryRejected(): string;
    dispatchAlreadySettled(outcome: string): string;
    proposalCancelled(): string;
    dispatchResultFallback(): string;
    confirmationResult(status: string, outcome?: string): string;
    blocker(value: string): string;
    resultListLabel(kind: "tests" | "files" | "artifacts"): string;
    resultCounts(files: number, tests: number): string;
    widgetLabel(): string;
    widgetSeparator(): string;
    widgetManagerHint(): string;
    widget(counts: { delivering: number; active: number; attention: number }): {
      delivering?: string;
      running: string;
      attention: string;
      plain: string;
    };
  };
  readonly notification: {
    outcomeTitle(agent: string, outcome: FinalOutcome): string;
    attentionTitle(agent: string): string;
    attentionBody(task: string, condition: string): string;
  };
  readonly tool: {
    label(tool: "propose" | "agents" | "inspect" | "status"): string;
  };
  readonly runtime: {
    dispatchSessionNotStarted(): string;
    dispatchSessionStopped(): string;
    registrySessionNotStarted(): string;
    registrySessionStopped(): string;
    registryUnavailable(): string;
    invalidConfiguration(reason: string): string;
    herdrIdentityUnavailable(): string;
    currentPaneAbsent(): string;
    adapterUnavailable(reason: string): string;
  };
  readonly followup: {
    replyEditor(): string;
    replyCancelled(): string;
    resolutionEvidence(identity: string, tail: string, targetStatus: string, worktree?: string): string;
    emergencyAttestationTitle(): string;
    emergencyAttestationBody(evidence: string, originSessionId: string): string;
    emergencyCancelledBeforeAttestation(): string;
    manualFinalOutcome(): string;
    resolutionCancelled(): string;
    resolutionSummaryEditor(): string;
    reservationReleaseTitle(emergency: boolean): string;
    reservationReleaseBody(evidence: string, outcome: string, emergency: boolean): string;
    resolutionCancelledAtConfirmation(): string;
    settled(agent: string, outcome: string): string;
    alreadySettled(agent: string, outcome: string): string;
    preview(identity: string, tail: string, focusWarning: string, kind: "reply" | "cancel"): string;
    previewWithTechnical(preview: string, dispatchId: string, terminalId: string, payload: string): string;
    previewWithoutTechnical(preview: string): string;
    approvalOptions(technical: boolean): string[];
    approveOption(): string;
    technicalOption(): string;
    hideTechnicalOption(): string;
    cancelOption(): string;
    cancelled(kind: "reply" | "cancel"): string;
    deliveryVerified(kind: "reply" | "cancel"): string;
    deliveryAmbiguous(kind: "reply" | "cancel"): string;
    deliveryNotSent(kind: "reply" | "cancel", reason: string): string;
  };
}

const attentionLabels: Readonly<Record<AttentionCondition, string>> = Object.freeze({
  "target-lost": "Target lost",
  "delivery-unverified": "Delivery unverified",
  "malformed-result": "Malformed result",
  "result-missing": "Result missing",
  "blocked-runtime": "Runtime blocked",
  "monitoring-paused": "Monitoring paused",
  overdue: "Overdue",
  unacknowledged: "Unacknowledged",
});

const commandDescriptions: Readonly<Record<HumanCommand, string>> = Object.freeze({
  agents: "List Eligible Agents in the current Herdr workspace",
  new: "Create and immediately send a Herdr dispatch",
  manager: "Open the Herdr Dispatch Manager",
  reply: "Preview and confirm a reply to an Active Dispatch with attention",
  cancel: "Preview and confirm a normal cancellation request",
  resolve: "Manually or emergently resolve a dispatch with confirmation",
  setup: "Explicitly install one Herdr Agent status integration",
  output: "Read one bounded current-workspace Agent output tail",
});

function duration(minutes: number): string {
  return minutes < 60
    ? `${minutes}m`
    : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export const UI_COPY = Object.freeze({
  state: {
    outcome: (outcome) => String(outcome),
    lifecycle: (lifecycle) => String(lifecycle),
    agentStatus: (status) => status,
    attention: (condition) => attentionLabels[condition],
    mode: (mode) => mode,
    provenance: (reported) => (reported ? "reported" : "~screen"),
  },
  time: {
    relativeDeadline: (deadlineAt, now) => {
      const delta = deadlineAt - now;
      const magnitude = Math.abs(delta);
      if (magnitude < 60_000) return delta >= 0 ? "in <1m" : "just overdue";
      const text = duration(Math.round(magnitude / 60_000));
      return delta >= 0 ? `in ${text}` : `${text} overdue`;
    },
    relativeAge: (timestamp, now) => {
      const magnitude = Math.max(0, now - timestamp);
      if (magnitude < 60_000) return "just now";
      return `${duration(Math.round(magnitude / 60_000))} ago`;
    },
  },
  count: {
    eligibleAgents: (count) => `${count} eligible ${count === 1 ? "Agent" : "Agents"}`,
    unsettledDispatches: (count) =>
      `${count} unsettled ${count === 1 ? "dispatch" : "dispatches"}`,
    lines: (count) => `${count} lines`,
    earlierLines: (count) => `${count} earlier lines`,
    moreConditions: (count) => `${count} more conditions`,
    files: (count) => `${count} files`,
    tests: (count) => `${count} tests`,
    delivering: (count) => `${count} delivering`,
    running: (count) => `${count} running`,
    attention: (count) => `${count} attention`,
  },
  common: {
    untitledDispatch: () => "Untitled dispatch",
    dispatchFallback: () => "Dispatch",
    deadline: (value) => `deadline ${value}`,
    worktree: (value) => `worktree ${value}`,
    dispatch: (value) => `dispatch ${value}`,
    terminal: (value) => `terminal ${value}`,
  },
  command: {
    description: (command) => commandDescriptions[command],
    dispatchTuiOnly: () => "Dispatch delivery is available only in TUI mode",
    proposalTuiOnly: () => "Herdr dispatch delivery is available only in TUI mode",
    managerTuiOnly: () => "The Dispatch Manager is available only in TUI mode",
    setupTuiOnly: () => "Integration setup is available only in TUI mode",
    followupTuiOnly: () => "Dispatch follow-up actions are available only in TUI mode",
    noEligibleAgents: () => "No Eligible Agents are available",
    chooseEligibleAgent: () => "Choose an Eligible Agent",
    selectedAgentUnavailable: () => "Selected Agent is no longer available",
    completeTask: () => "Complete dispatch task",
    mutationMode: () => "Dispatch mutation mode",
    deadlineMinutes: () => "Deadline in minutes",
    dependencyInstallTitle: () => "Project dependency installation",
    dependencyInstallQuestion: () => "Explicitly allow project-local dependency installation?",
    selectedDispatchUnavailable: () =>
      "The selected dispatch is no longer available in this workspace",
    runtimeUnavailable: () => "Dispatch runtime unavailable",
    followupRuntimeUnavailable: () => "Dispatch follow-up runtime is unavailable",
    invalidDispatchSelector: () => "Invalid dispatch ID or prefix",
    dispatchNotFound: (selector) =>
      `No current-workspace dispatch matches ${selector}. Open /hd-manager.`,
    chooseMatchingDispatch: () => "Choose the matching dispatch",
    noDispatchForAction: (action) => {
      switch (action) {
        case "reply":
          return "No dispatch currently needs a reply.";
        case "cancel":
          return "No unsettled dispatch from this session can be cancelled.";
        case "resolve":
          return "No dispatch currently requires manual resolution.";
      }
    },
    alreadySettled: (outcome) => `This dispatch already settled ${outcome ?? "with a final outcome"}.`,
    originOnlyFollowup: () => "Only the exact Origin Session may reply or request cancellation.",
    lostOrMovedResolutionOnly: () => "A lost or moved target can only be resolved manually.",
    replyRequiresActive: () => "Replies require an Active Dispatch.",
    replyRequiresAttention: () =>
      "Replies require an Active Dispatch with an Attention Condition.",
    setupNoStatusOutput: () => "No integration status output.",
    setupChooseIntegration: () => "Install one Herdr integration",
    setupCancel: () => "Cancel",
    setupConfirmTitle: (integration) => `Install Herdr ${integration} integration?`,
    setupConfirmBody: () =>
      "This explicitly modifies that Agent's local integration configuration. Nothing is installed automatically and only this one selected integration will be changed.",
    setupInstallFailed: (code) => `Herdr integration install exited ${code}`,
    setupInstalled: (integration) => `Installed Herdr ${integration} integration.`,
    outputUsage: () => "Usage: /hd-output <target> [lines]",
  },
  manager: {
    title: () => "Herdr Dispatches",
    heading: (running, delivering, attention) =>
      `  ${running} running · ${delivering} delivering · ${attention} need attention`,
    noActiveDispatches: () => "No active dispatches.",
    startWithCommand: () => "Start one with /hd-new.",
    groupAttention: () => "NEEDS ATTENTION",
    groupRunning: () => "RUNNING",
    groupDelivering: () => "DELIVERING",
    settledHeading: (count, shown) =>
      shown ? `SETTLED · LAST ${count}` : `SETTLED · ${count} HIDDEN · PRESS S`,
    listKeybar: (settledShown) =>
      `↑↓ select · enter detail · s ${settledShown ? "hide" : "show"} settled · esc close`,
    emergencyResolutionRequired: () => "Emergency resolution required",
    activeSince: (age) => `Active since ${age}`,
    deliveryStarted: (age) => `Delivery started ${age}`,
    targetMayHaveReceivedInput: () =>
      "The target may have received input even though the echo was lost.",
    reservationsRetained: () => "Reservations retained · never resent automatically",
    outputNoneRead: () => " ── output · none read ──",
    outputReadInstructions: () =>
      "    Press r for one bounded 50-line read, or R for 200 lines.",
    outputReading: (lines) => ` ── output · reading ${lines} lines… ──`,
    outputReadFailed: () => " ── output · read failed ──",
    outputEarlierLinesNotShown: (count) => ` … ${count} earlier lines not shown`,
    outputReadEnd: (time) => ` ── end · read at ${time} · on demand only ──`,
    detailKeybar: (actions) => {
      const labels = [
        actions.includes("reply") ? "y reply" : "",
        actions.includes("cancel") ? "c cancel" : "",
        actions.includes("resolve") ? "v resolve" : "",
      ].filter(Boolean);
      return ` r read 50 · R read 200${labels.length > 0 ? ` · ${labels.join(" · ")}` : ""} · D details · esc back`;
    },
    technicalHeading: () => " TECHNICAL DETAILS",
    technicalLabel: (label) => ({
      dispatch: "Dispatch ID",
      terminal: "Terminal",
      origin: "Origin",
      workspace: "Workspace",
    })[label],
    viewUnavailable: (reason) => ` dispatch view unavailable: ${reason}`,
    closeKeybar: () => " esc close",
    missingRegistryDispatch: () => " dispatch is no longer in the Registry",
    backKeybar: () => " esc back",
  },
  presentation: {
    noEligibleAgents: () =>
      "No eligible Agents right now — the others are working, blocked, or occupied.",
    eligibleAgentHelp: () => "Agents become eligible when their status is idle or done.",
    noUnsettledDispatches: () => "No unsettled dispatches.",
    noUnsettledDispatchesHelp: () =>
      "Start one with /hd-new, or just ask for work to be dispatched.",
    inspectionEarlierLines: (count) => `… ${count} earlier lines (expand to view)`,
    dispatchActive: () => "dispatch active",
    deliveryEchoVerified: () => "· delivery echo verified",
    dispatchDeliveryUnverified: () => "dispatch delivery unverified",
    reservationsNeverResent: () => "   reservations retained · never resent automatically",
    dispatchNotSent: () => "dispatch not sent",
    deliveryRejected: () => "delivery rejected",
    dispatchAlreadySettled: (outcome) => `dispatch already settled ${outcome}`,
    proposalCancelled: () => "○ proposal cancelled — nothing was sent",
    dispatchResultFallback: () => "dispatch result",
    confirmationResult: (status, outcome) => {
      if (status === "active") return "Dispatch is active; delivery echo was verified.";
      if (status === "delivery-unverified") {
        return "Dispatch delivery is unverified. Reservations are retained and no automatic resend will occur.";
      }
      if (status === "failed") return "Dispatch was proven not sent and recorded failed.";
      if (status === "already-settled") {
        return `Dispatch was already settled; the recorded outcome is ${String(outcome)}.`;
      }
      return "Dispatch proposal was cancelled without delivery.";
    },
    blocker: (value) => `blocker: ${value}`,
    resultListLabel: (kind) => kind,
    resultCounts: (files, tests) =>
      [files > 0 ? `${files} files` : "", tests > 0 ? `${tests} tests` : ""]
        .filter(Boolean)
        .join(" · ") + " (expand for details)",
    widgetLabel: () => "dispatches",
    widgetSeparator: () => "  ·  ",
    widgetManagerHint: () => "  ·  alt+h manager",
    widget: (counts) => {
      const delivering = counts.delivering > 0 ? `${counts.delivering} delivering` : undefined;
      const running = `${counts.active} running`;
      const attention = counts.attention > 0 ? `${counts.attention} attention` : "no attention";
      const plainSegments = [
        counts.delivering > 0 ? `${counts.delivering} delivering` : undefined,
        `${counts.active} running`,
        `${counts.attention} attention`,
      ].filter((segment): segment is string => segment !== undefined);
      return { delivering, running, attention, plain: `dispatches: ${plainSegments.join(" · ")}` };
    },
  },
  notification: {
    outcomeTitle: (agent, outcome) => `${agent} ${outcome}`,
    attentionTitle: (agent) => `${agent} needs attention`,
    attentionBody: (task, condition) => `${task} · ${condition}`,
  },
  tool: {
    label: (tool) => ({
      propose: "Propose Herdr Dispatch",
      agents: "List Herdr Agents",
      inspect: "Inspect Herdr Agent Output",
      status: "Herdr Dispatch Status",
    })[tool],
  },
  runtime: {
    dispatchSessionNotStarted: () => "Dispatch runtime session has not started",
    dispatchSessionStopped: () => "Dispatch runtime session is stopped",
    registrySessionNotStarted: () => "Dispatch Registry session has not started",
    registrySessionStopped: () => "Dispatch Registry session is stopped",
    registryUnavailable: () => "Dispatch Registry unavailable",
    invalidConfiguration: (reason) => `Invalid dispatch configuration: ${reason}`,
    herdrIdentityUnavailable: () =>
      "Herdr socket, workspace, or current pane identity is unavailable",
    currentPaneAbsent: () => "current Pi pane is absent from the captured Herdr workspace",
    adapterUnavailable: (reason) => `Herdr Adapter unavailable: ${reason}`,
  },
  followup: {
    replyEditor: () => "Reply to the dispatch target",
    replyCancelled: () => "Reply cancelled.",
    resolutionEvidence: (identity, tail, targetStatus, worktree) =>
      `${identity}\n\n${tail}\nTarget status: ${targetStatus}\nWorktree: ${worktree ?? "none"}`,
    emergencyAttestationTitle: () => "Emergency resolution attestation",
    emergencyAttestationBody: (evidence, originSessionId) =>
      `${evidence}\n\nOrigin Session: ${originSessionId}\nAttest that you have personally judged the Origin Session unavailable. No process-liveness inference was performed.`,
    emergencyCancelledBeforeAttestation: () =>
      "Emergency resolution cancelled before attestation.",
    manualFinalOutcome: () => "Manual Final Outcome",
    resolutionCancelled: () => "Resolution cancelled.",
    resolutionSummaryEditor: () => "Bounded resolution summary",
    reservationReleaseTitle: (emergency) =>
      emergency ? "Confirm emergency reservation release" : "Confirm manual reservation release",
    reservationReleaseBody: (evidence, outcome, emergency) =>
      `${evidence}\n\nRecord ${outcome}, atomically release reservations, and accept first-wins settlement?${
        emergency ? " This does not transfer monitoring or inject context into this resolver." : ""
      }`,
    resolutionCancelledAtConfirmation: () => "Resolution cancelled at final confirmation.",
    settled: (agent, outcome) => `${agent} dispatch settled ${outcome}.`,
    alreadySettled: (agent, outcome) =>
      `${agent} dispatch was already settled ${outcome}; first settlement won.`,
    preview: (identity, tail, focusWarning, kind) =>
      `${identity}\n\n${tail}\n\n${focusWarning}\n\n${
        kind === "reply"
          ? "A confirmed reply retains all reservations."
          : "This sends a normal cancellation request, never Ctrl+C. Reservations remain until settlement."
      }`,
    previewWithTechnical: (preview, dispatchId, terminalId, payload) =>
      `${preview}\n\nTechnical details:\nDispatch ID: ${dispatchId}\nTarget terminal: ${terminalId}\n\nExact outbound bytes:\n${payload}`,
    previewWithoutTechnical: (preview) =>
      `${preview}\n\nTechnical details are hidden. Choose Technical details to inspect exact protocol bytes.`,
    approvalOptions: (technical) => [
      "Approve",
      technical ? "Hide technical details" : "Technical details",
      "Cancel",
    ],
    approveOption: () => "Approve",
    technicalOption: () => "Technical details",
    hideTechnicalOption: () => "Hide technical details",
    cancelOption: () => "Cancel",
    cancelled: (kind) => `${kind === "reply" ? "Reply" : "Cancellation request"} cancelled.`,
    deliveryVerified: (kind) => `${kind} request delivery echo verified.`,
    deliveryAmbiguous: (kind) => `${kind} request delivery is ambiguous; it was not resent.`,
    deliveryNotSent: (kind, reason) => `${kind} request was proven not sent: ${reason}.`,
  },
} satisfies HumanUiCopy);
