import type {
  ConfirmationResult,
  CreateProposalRequest,
  DispatchApplication,
  OriginIdentity,
} from "../dispatch/application.js";
import type { DispatchProposal } from "../dispatch/proposal.js";
import { formatProposalPreview } from "./presentation.js";

export interface ProposalUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
}

export interface ProposalInteractionContext {
  mode: "tui" | "rpc" | "json" | "print";
  ui: ProposalUI;
  origin: OriginIdentity;
}

export type ProposalFlowResult = ConfirmationResult | { status: "cancelled" };

export class DispatchMutationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchMutationUnavailableError";
  }
}

export class DispatchController {
  readonly #application: () => DispatchApplication | undefined;
  readonly #mutationUnavailableReason: () => string | undefined;

  constructor(options: {
    application: () => DispatchApplication | undefined;
    mutationUnavailableReason?: () => string | undefined;
  }) {
    this.#application = options.application;
    this.#mutationUnavailableReason = options.mutationUnavailableReason ?? (() => undefined);
  }

  async proposeAndConfirm(
    request: CreateProposalRequest,
    context: ProposalInteractionContext,
  ): Promise<ProposalFlowResult> {
    this.#assertMutationAllowed(context);
    const application = this.#application()!;
    let proposal = await application.createProposal(request);
    while (true) {
      const choice = await context.ui.select(formatProposalPreview(proposal), [
        "Approve",
        "Edit",
        "Cancel",
      ]);
      if (choice === "Approve") {
        return application.confirmProposal(proposal, context.origin);
      }
      if (choice === "Edit") {
        const edited = await editProposal(proposal, context.ui);
        if (!edited) continue;
        proposal = await application.reviseProposal(proposal, edited);
        continue;
      }
      application.cancelProposal(proposal);
      return { status: "cancelled" };
    }
  }

  #assertMutationAllowed(context: ProposalInteractionContext): void {
    if (context.mode !== "tui") {
      throw new DispatchMutationUnavailableError(
        "Herdr dispatch proposal and confirmation are available only in TUI mode",
      );
    }
    const reason = this.#mutationUnavailableReason();
    if (reason) throw new DispatchMutationUnavailableError(reason);
    if (!this.#application()) {
      throw new DispatchMutationUnavailableError("Herdr dispatch runtime is unavailable");
    }
  }
}

async function editProposal(
  proposal: DispatchProposal,
  ui: ProposalUI,
): Promise<Omit<CreateProposalRequest, "target"> | undefined> {
  const task = await ui.editor("Edit the complete dispatch task", proposal.task);
  if (task === undefined) return undefined;
  const mode = await ui.select("Dispatch mutation mode", ["non-mutating", "write"]);
  if (mode !== "non-mutating" && mode !== "write") return undefined;
  const deadline = await ui.input(
    "Deadline in minutes",
    String(Math.max(1, Math.round((proposal.deadlineAt - proposal.createdAt) / 60_000))),
  );
  if (deadline === undefined) return undefined;
  const deadlineMinutes = Number(deadline);
  let allowProjectDependencyInstall = false;
  if (mode === "write") {
    allowProjectDependencyInstall = await ui.confirm(
      "Project dependency installation",
      "Explicitly allow project-local dependency installation? Global and system installs remain forbidden.",
    );
  }
  return { task, mode, deadlineMinutes, allowProjectDependencyInstall };
}
