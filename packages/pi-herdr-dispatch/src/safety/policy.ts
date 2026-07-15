import { classifyShellInvocations, type ShellInvocation } from "./shell-classifier.js";

export interface HerdrShellContext {
  currentPaneId?: string;
}

export type SafetyDecision =
  | { action: "allow"; frameHerdrOutput?: true }
  | {
      action: "deny";
      code:
        | "raw-herdr-output-read"
        | "cross-workspace-herdr-snapshot"
        | "raw-herdr-control"
        | "unclassifiable-herdr-command";
      reason: string;
      redirect: string;
    };

const ALLOWED_SUBCOMMANDS = new Map<string, ReadonlySet<string>>([
  ["pane", new Set(["list", "get", "current", "layout", "process-info", "neighbor", "edges"])],
  ["agent", new Set(["list", "get", "explain"])],
  ["workspace", new Set(["list", "get"])],
  ["tab", new Set(["list", "get"])],
  ["worktree", new Set(["list"])],
  ["integration", new Set(["status"])],
]);

const HELP_GROUPS = new Set([
  "api",
  "agent",
  "integration",
  "notification",
  "pane",
  "session",
  "tab",
  "terminal",
  "wait",
  "workspace",
  "worktree",
]);
const HELP_FLAGS = new Set(["--help", "-h", "help"]);
const VERSION_FLAGS = new Set(["--version", "-V"]);
const TASKING_REDIRECT = "herdr_dispatch_propose or /herdr-dispatch";

export function classifyHerdrShell(
  command: string,
  context: HerdrShellContext,
): SafetyDecision {
  const shell = classifyShellInvocations(command);
  if (!shell.parsed) {
    return shell.containsLiteralHerdr
      ? deny(
          "unclassifiable-herdr-command",
          "Blocked an unparseable command containing a literal Herdr invocation.",
          TASKING_REDIRECT,
        )
      : { action: "allow" };
  }

  let frameHerdrOutput = false;
  for (const invocation of shell.invocations) {
    if (invocation.executable !== "herdr") continue;

    const decision = classifyInvocation(invocation, context);
    if (decision.action === "deny") return decision;
    frameHerdrOutput ||= decision.frameHerdrOutput === true;
  }

  return frameHerdrOutput ? { action: "allow", frameHerdrOutput: true } : { action: "allow" };
}

function classifyInvocation(
  invocation: ShellInvocation,
  context: HerdrShellContext,
): SafetyDecision {
  const [group, subcommand, target] = invocation.args;

  if (group && (HELP_FLAGS.has(group) || VERSION_FLAGS.has(group))) return { action: "allow" };
  if (group && HELP_GROUPS.has(group) && (!subcommand || HELP_FLAGS.has(subcommand))) {
    return { action: "allow" };
  }
  if (group === "status") return { action: "allow" };
  if (group === "api" && subcommand === "schema") return { action: "allow" };
  if (group === "api" && subcommand === "snapshot") {
    return deny(
      "cross-workspace-herdr-snapshot",
      "Raw Herdr snapshots bypass current-workspace metadata scoping.",
      "herdr_agents_list",
    );
  }

  if (group === "pane" && subcommand === "read") {
    return isProvenCurrentPane(target, invocation, context)
      ? { action: "allow", frameHerdrOutput: true }
      : deny(
          "raw-herdr-output-read",
          "Reading another or ambiguous pane requires one explicit, bounded inspection.",
          "herdr_agent_output_inspect",
        );
  }

  if (group === "agent" && subcommand === "read") {
    return deny(
      "raw-herdr-output-read",
      "Raw Agent reads bypass one-request inspection authorization.",
      "herdr_agent_output_inspect",
    );
  }

  if (group && subcommand && ALLOWED_SUBCOMMANDS.get(group)?.has(subcommand)) {
    return { action: "allow" };
  }

  return deny(
    "raw-herdr-control",
    "Raw Herdr tasking, creation, control, and wait commands are disabled inside Pi.",
    TASKING_REDIRECT,
  );
}

function isProvenCurrentPane(
  target: string | undefined,
  invocation: ShellInvocation,
  context: HerdrShellContext,
): boolean {
  if (!target || !context.currentPaneId) return false;
  if (target === context.currentPaneId) return true;

  const referencesCurrentEnvironment = target === "$HERDR_PANE_ID" || target === "${HERDR_PANE_ID}";
  return referencesCurrentEnvironment && !invocation.assignments.has("HERDR_PANE_ID");
}

function deny(
  code: Extract<SafetyDecision, { action: "deny" }>["code"],
  reason: string,
  redirect: string,
): SafetyDecision {
  return { action: "deny", code, reason, redirect };
}
