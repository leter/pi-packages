import type {
  ConfirmationResult,
  CreateProposalRequest,
  DispatchApplication,
  OriginIdentity,
} from "../dispatch/application.js";
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

export type ProposalFlowResult = ConfirmationResult;

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

  async proposeAndDispatch(
    request: CreateProposalRequest,
    context: ProposalInteractionContext,
  ): Promise<ProposalFlowResult> {
    this.#assertMutationAllowed(context);
    const application = this.#application()!;
    const proposal = await application.createProposal(request);
    return application.confirmProposal(proposal, context.origin);
  }

  #assertMutationAllowed(context: ProposalInteractionContext): void {
    if (context.mode !== "tui") {
      throw new DispatchMutationUnavailableError(
        "Herdr dispatch delivery is available only in TUI mode",
      );
    }
    const reason = this.#mutationUnavailableReason();
    if (reason) throw new DispatchMutationUnavailableError(reason);
    if (!this.#application()) {
      throw new DispatchMutationUnavailableError("Herdr dispatch runtime is unavailable");
    }
  }
}
