import { describe, expect, it } from "vitest";

import { classifyHerdrShell } from "../../src/safety/policy.js";

const context = { currentPaneId: "w1:p1" } as const;

describe("Herdr shell safety policy", () => {
  it.each([
    "herdr status",
    "herdr --help",
    "herdr --version",
    "herdr pane",
    "herdr api schema --json",
    "herdr pane list --workspace w1",
    "herdr pane get w1:p2",
    "herdr pane current --current",
    "herdr pane layout --pane w1:p2",
    "herdr pane process-info --pane w1:p2",
    "herdr pane neighbor --direction right --pane w1:p2",
    "herdr pane edges --pane w1:p2",
    "herdr agent list",
    "herdr agent get term_example",
    "herdr agent explain term_example --json",
    "herdr workspace list",
    "herdr workspace get w1",
    "herdr tab list --workspace w1",
    "herdr tab get w1:t1",
    "herdr worktree list",
    "herdr integration status",
    "herdr pane list | jq '.result'",
    "herdr pane list && herdr tab list",
  ])("allows scoped metadata inspection: %s", (command) => {
    expect(classifyHerdrShell(command, context)).toEqual({ action: "allow" });
  });

  it("allows a proven current-pane read and marks its output as untrusted", () => {
    expect(
      classifyHerdrShell(
        "herdr pane read w1:p1 --source recent-unwrapped --lines 50",
        context,
      ),
    ).toEqual({ action: "allow", frameHerdrOutput: true });
  });

  it.each([
    'herdr pane read "$HERDR_PANE_ID"',
    'HERDR_PANE_ID=w1:p2 herdr pane read "$HERDR_PANE_ID"',
    'export HERDR_PANE_ID=w1:p2; herdr pane read "$HERDR_PANE_ID"',
  ])("treats shell-expanded pane targets as ambiguous: %s", (command) => {
    expect(classifyHerdrShell(command, context).action).toBe("deny");
  });

  it.each([
    ["herdr pane read w1:p2", "herdr_agent_output_inspect"],
    ["herdr pane read", "herdr_agent_output_inspect"],
    ["herdr agent read term_other", "herdr_agent_output_inspect"],
    ["herdr api snapshot", "herdr_agents_list"],
  ])("redirects raw scope-bypassing reads: %s", (command, redirect) => {
    const decision = classifyHerdrShell(command, context);

    expect(decision.action).toBe("deny");
    if (decision.action === "deny") {
      expect(decision.redirect).toBe(redirect);
    }
  });

  it.each([
    "herdr pane run w1:p2 'review this'",
    "herdr pane send-text w1:p2 hello",
    "herdr pane send-keys w1:p2 enter",
    "herdr pane split --current --direction right",
    "herdr pane close w1:p2",
    "herdr agent send term_other hello",
    "herdr agent start reviewer -- pi",
    "herdr wait agent-status w1:p2 --status done",
    "herdr wait output w1:p2 --match done",
    "herdr pane move w1:p2 --new-tab",
    "herdr pane focus --direction right --current",
  ])("denies tasking, creation, control, and waits: %s", (command) => {
    const decision = classifyHerdrShell(command, context);

    expect(decision.action).toBe("deny");
    if (decision.action === "deny") {
      expect(decision.redirect).toBe("herdr_dispatch_propose or /herdr-dispatch");
    }
  });

  it.each([
    '"herdr" pane run w1:p2 task',
    "/usr/local/bin/herdr pane run w1:p2 task",
    "command herdr pane run w1:p2 task",
    "env TRACE=1 herdr pane run w1:p2 task",
    "env -u TRACE herdr pane run w1:p2 task",
    "sudo -u root herdr pane run w1:p2 task",
    "sudo --user root herdr pane run w1:p2 task",
    "herdr pane list; herdr pane run w1:p2 task",
    "herdr pane list | herdr pane run w1:p2 task",
  ])("finds Herdr invocations through direct shell composition: %s", (command) => {
    expect(classifyHerdrShell(command, context).action).toBe("deny");
  });

  it("fails closed when a literal Herdr invocation cannot be parsed", () => {
    const decision = classifyHerdrShell('herdr pane "run', context);

    expect(decision.action).toBe("deny");
    if (decision.action === "deny") {
      expect(decision.code).toBe("unclassifiable-herdr-command");
    }
  });

  it("does not mistake Herdr text data for an invocation", () => {
    expect(classifyHerdrShell("printf '%s\\n' 'herdr pane run w1:p2 task'", context)).toEqual({
      action: "allow",
    });
  });

  it("allows shell commands that do not invoke Herdr", () => {
    expect(classifyHerdrShell("git status --short", context)).toEqual({ action: "allow" });
  });
});
