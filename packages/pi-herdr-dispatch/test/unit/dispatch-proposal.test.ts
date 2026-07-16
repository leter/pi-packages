import { describe, expect, it } from "vitest";

import {
  ADVISORY_SAFETY_WARNING,
  createDispatchProposal,
} from "../../src/dispatch/proposal.js";

const target = {
  terminalId: "term_target",
  paneId: "w1:p2",
  workspaceId: "w1",
  agentLabel: "pi",
  cwd: "/repo/worktree",
  status: "done" as const,
  statusProvenance: "screen-detected" as const,
};

describe("Dispatch Proposal", () => {
  it("builds and freezes the exact reviewed outbound payload", () => {
    const proposal = createDispatchProposal(
      {
        target,
        mode: "non-mutating",
        task: "Inspect the parser and report the root cause.",
        deadlineMinutes: 30,
        allowProjectDependencyInstall: false,
      },
      { now: 1_750_000_000_000, correlationId: "hd_fixed_1" },
    );

    expect(proposal.advisoryWarning).toBe(ADVISORY_SAFETY_WARNING);
    expect(proposal.deadlineAt).toBe(1_750_001_800_000);
    expect(proposal.payload).toBe(`[HERDR DISPATCH]
ID: hd_fixed_1
Mode: non-mutating
Target directory: /repo/worktree
Deadline: 2025-06-15T15:36:40.000Z
Safety: advisory
Project dependency installation: forbidden

Task:
Inspect the parser and report the root cause.

Constraints:
- Do not delegate or spawn another agent.
- Stay in the confirmed directory/worktree.
- Follow the declared mutation mode.
- Do not commit, push, deploy, publish, mutate remote systems, or perform destructive cleanup.
- Global and system installs are forbidden.
- Project dependency installation is forbidden unless explicitly authorized above.
- Write the Result Envelope summary and any blocker text in Simplified Chinese; keep code, identifiers, and paths verbatim.

Finish by printing exactly one single-line Result Envelope, not fenced in Markdown, keeping the whole line under 200 characters with a one-sentence summary:
DISPATCH_RESULT {"id":"hd_fixed_1","outcome":"done|blocked|failed|cancelled","summary":"..."}`);
    expect(proposal.payloadHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(proposal)).toBe(true);
    expect(Object.isFrozen(proposal.target)).toBe(true);
    expect(Object.isFrozen(proposal.constraints)).toBe(true);
    expect(() => {
      (proposal as { task: string }).task = "changed";
    }).toThrow();
  });

  it("allows project dependency installation only for an explicitly authorized write proposal", () => {
    expect(() =>
      createDispatchProposal(
        {
          target: { ...target, worktreePath: "/repo/worktree" },
          mode: "non-mutating",
          task: "Inspect",
          deadlineMinutes: 30,
          allowProjectDependencyInstall: true,
        },
        { now: 1, correlationId: "hd_bad" },
      ),
    ).toThrow("write proposal");

    const proposal = createDispatchProposal(
      {
        target: { ...target, worktreePath: "/repo/worktree" },
        mode: "write",
        task: "Upgrade the local parser dependency.",
        deadlineMinutes: 30,
        allowProjectDependencyInstall: true,
      },
      { now: 1, correlationId: "hd_write" },
    );
    expect(proposal.payload).toContain("Project dependency installation: explicitly authorized");
  });

  it.each([
    "",
    "   ",
    "contains\u0000nul",
    "contains\u001b[31mansi",
  ])("rejects unsafe or empty task text: %j", (task) => {
    expect(() =>
      createDispatchProposal(
        {
          target,
          mode: "non-mutating",
          task,
          deadlineMinutes: 30,
          allowProjectDependencyInstall: false,
        },
        { now: 1, correlationId: "hd_invalid" },
      ),
    ).toThrow();
  });
});
