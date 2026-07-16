import { describe, expect, it, vi } from "vitest";

import type { DispatchApplication } from "../../src/dispatch/application.js";
import { createDispatchProposal } from "../../src/dispatch/proposal.js";
import {
  DispatchController,
  DispatchMutationUnavailableError,
  type ProposalUI,
} from "../../src/pi/dispatch-controller.js";

function proposal(id: string) {
  return createDispatchProposal(
    {
      target: {
        terminalId: "term_1",
        paneId: "p1",
        workspaceId: "w1",
        agentLabel: "pi",
        cwd: "/repo",
        status: "idle",
        statusProvenance: "reported",
      },
      mode: "non-mutating",
      task: "Inspect",
      deadlineMinutes: 30,
      allowProjectDependencyInstall: false,
    },
    { now: 1, correlationId: id },
  );
}

function ui(): ProposalUI {
  return {
    select: vi.fn(),
    input: vi.fn(),
    editor: vi.fn(),
    confirm: vi.fn(),
  };
}

const origin = { sessionId: "session_1", sessionFile: "/session.jsonl" };

describe("DispatchController", () => {
  it.each(["rpc", "json", "print"] as const)(
    "rejects %s mode before proposal creation or reservation",
    async (mode) => {
      const createProposal = vi.fn();
      const controller = new DispatchController({
        application: () => ({ createProposal }) as unknown as DispatchApplication,
      });

      await expect(
        controller.proposeAndDispatch(
          { target: "term_1", task: "Inspect", mode: "non-mutating" },
          { mode, ui: ui(), origin },
        ),
      ).rejects.toBeInstanceOf(DispatchMutationUnavailableError);
      expect(createProposal).not.toHaveBeenCalled();
    },
  );

  it("dispatches by default without opening any confirmation UI", async () => {
    const current = proposal("hd_automatic");
    const presentation = ui();
    const confirmProposal = vi.fn(async () => ({
      status: "active" as const,
      dispatchId: current.id,
      echoVerified: true as const,
    }));
    const application = {
      createProposal: vi.fn(async () => current),
      confirmProposal,
    } as unknown as DispatchApplication;
    const controller = new DispatchController({ application: () => application });

    await expect(
      controller.proposeAndDispatch(
        { target: "term_1", task: "Inspect", mode: "non-mutating" },
        { mode: "tui", ui: presentation, origin },
      ),
    ).resolves.toEqual({ status: "active", dispatchId: current.id, echoVerified: true });

    expect(presentation.select).not.toHaveBeenCalled();
    expect(presentation.confirm).not.toHaveBeenCalled();
    expect(presentation.editor).not.toHaveBeenCalled();
    expect(application.createProposal).toHaveBeenCalledOnce();
    expect(confirmProposal).toHaveBeenCalledWith(current, origin);
  });

  it("fails before proposal creation when mutations are unavailable", async () => {
    const createProposal = vi.fn();
    const controller = new DispatchController({
      application: () => ({ createProposal }) as unknown as DispatchApplication,
      mutationUnavailableReason: () => "Registry unavailable",
    });

    await expect(
      controller.proposeAndDispatch(
        { target: "term_1", task: "Inspect", mode: "non-mutating" },
        { mode: "tui", ui: ui(), origin },
      ),
    ).rejects.toThrow("Registry unavailable");
    expect(createProposal).not.toHaveBeenCalled();
  });
});
