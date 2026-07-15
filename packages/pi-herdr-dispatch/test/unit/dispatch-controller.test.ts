import { describe, expect, it, vi } from "vitest";

import type { DispatchApplication } from "../../src/dispatch/application.js";
import { createDispatchProposal } from "../../src/dispatch/proposal.js";
import {
  DispatchController,
  DispatchMutationUnavailableError,
  type ProposalUI,
} from "../../src/pi/dispatch-controller.js";

function proposal(id: string, task = "Inspect") {
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
      task,
      deadlineMinutes: 30,
      allowProjectDependencyInstall: false,
    },
    { now: 1, correlationId: id },
  );
}

function ui(overrides: Partial<ProposalUI> = {}): ProposalUI {
  return {
    select: vi.fn(async () => "Approve"),
    input: vi.fn(async () => undefined),
    editor: vi.fn(async () => undefined),
    confirm: vi.fn(async () => false),
    ...overrides,
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
        controller.proposeAndConfirm(
          { target: "term_1", task: "Inspect", mode: "non-mutating" },
          { mode, ui: ui(), origin },
        ),
      ).rejects.toBeInstanceOf(DispatchMutationUnavailableError);
      expect(createProposal).not.toHaveBeenCalled();
    },
  );

  it("shows exact bytes and requires explicit Approve before confirmation", async () => {
    const current = proposal("hd_approve");
    const select = vi.fn(async (_title: string, _options: string[]) => "Approve");
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
      controller.proposeAndConfirm(
        { target: "term_1", task: "Inspect", mode: "non-mutating" },
        { mode: "tui", ui: ui({ select }), origin },
      ),
    ).resolves.toEqual({ status: "active", dispatchId: current.id, echoVerified: true });
    expect(select).toHaveBeenCalledOnce();
    expect(select.mock.calls[0]?.[0]).toContain(current.payload);
    expect(confirmProposal).toHaveBeenCalledWith(current, origin);
  });

  it("turns Edit into a new immutable proposal and requires a second preview", async () => {
    const first = proposal("hd_first", "Old task");
    const revised = proposal("hd_revised", "New task");
    const selections = ["Edit", "write", "Approve"];
    const select = vi.fn(async (_title: string, _options: string[]) => selections.shift());
    const reviseProposal = vi.fn(async () => revised);
    const confirmProposal = vi.fn(async () => ({
      status: "active" as const,
      dispatchId: revised.id,
      echoVerified: true as const,
    }));
    const application = {
      createProposal: vi.fn(async () => first),
      reviseProposal,
      confirmProposal,
    } as unknown as DispatchApplication;
    const controller = new DispatchController({ application: () => application });

    await controller.proposeAndConfirm(
      { target: "term_1", task: "Old task", mode: "non-mutating" },
      {
        mode: "tui",
        origin,
        ui: ui({
          select,
          editor: vi.fn(async () => "New task"),
          input: vi.fn(async () => "45"),
          confirm: vi.fn(async () => true),
        }),
      },
    );

    expect(reviseProposal).toHaveBeenCalledWith(first, {
      task: "New task",
      mode: "write",
      deadlineMinutes: 45,
      allowProjectDependencyInstall: true,
    });
    expect(select.mock.calls[0]?.[0]).toContain(first.payload);
    expect(select.mock.calls[2]?.[0]).toContain(revised.payload);
    expect(confirmProposal).toHaveBeenCalledWith(revised, origin);
  });

  it("Cancel invalidates the proposal without confirmation", async () => {
    const current = proposal("hd_cancel");
    const cancelProposal = vi.fn();
    const confirmProposal = vi.fn();
    const application = {
      createProposal: vi.fn(async () => current),
      cancelProposal,
      confirmProposal,
    } as unknown as DispatchApplication;
    const controller = new DispatchController({ application: () => application });

    await expect(
      controller.proposeAndConfirm(
        { target: "term_1", task: "Inspect", mode: "non-mutating" },
        { mode: "tui", ui: ui({ select: vi.fn(async () => "Cancel") }), origin },
      ),
    ).resolves.toEqual({ status: "cancelled" });
    expect(cancelProposal).toHaveBeenCalledWith(current);
    expect(confirmProposal).not.toHaveBeenCalled();
  });
});
