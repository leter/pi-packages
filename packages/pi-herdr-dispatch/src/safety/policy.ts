import { isAbsolute, relative, resolve } from "node:path";

import { classifyShellInvocations, type ShellInvocation } from "./shell-classifier.js";
import { classifyBashEffect } from "./worktree-effects.js";

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
        | "unclassifiable-herdr-command"
        | "worktree-write-lease"
        | "lease-registry-unavailable";
      reason: string;
      redirect?: string;
    };

export interface WorktreeLease {
  dispatchId: string;
  targetTerminalId: string;
  worktreePath: string;
}

export type LeaseSnapshot =
  | { status: "ready"; leases: readonly WorktreeLease[] }
  | { status: "unavailable"; reason: string };

export interface LeaseGuardContext {
  actorTerminalId?: string;
  leaseSnapshot: LeaseSnapshot;
}

export type CoveredPiOperation =
  | { kind: "edit" | "write"; cwd: string; path: string }
  | { kind: "bash"; cwd: string; command: string };

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
const RECURSIVE_SHELLS = new Set(["bash", "dash", "sh", "zsh"]);
const MAX_CLASSIFICATION_DEPTH = 8;

export function classifyHerdrShell(
  command: string,
  context: HerdrShellContext,
): SafetyDecision {
  return classifyHerdrShellAtDepth(command, context, 0);
}

function classifyHerdrShellAtDepth(
  command: string,
  context: HerdrShellContext,
  depth: number,
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
    const nestedCommand = recursivelyEvaluatedCommand(invocation);
    if (nestedCommand !== undefined) {
      if (depth >= MAX_CLASSIFICATION_DEPTH) {
        if (/\bherdr\b/u.test(nestedCommand)) {
          return deny(
            "unclassifiable-herdr-command",
            "Blocked a Herdr command nested beyond the classifier recursion limit.",
            TASKING_REDIRECT,
          );
        }
      } else {
        const nestedDecision = classifyHerdrShellAtDepth(nestedCommand, context, depth + 1);
        if (nestedDecision.action === "deny") return nestedDecision;
        frameHerdrOutput ||= nestedDecision.frameHerdrOutput === true;
      }
    }

    if (invocation.executable !== "herdr") continue;

    const decision = classifyInvocation(invocation, context);
    if (decision.action === "deny") return decision;
    frameHerdrOutput ||= decision.frameHerdrOutput === true;
  }

  return frameHerdrOutput ? { action: "allow", frameHerdrOutput: true } : { action: "allow" };
}

function recursivelyEvaluatedCommand(invocation: ShellInvocation): string | undefined {
  if (invocation.executable === "eval") return invocation.args.join(" ");
  if (!RECURSIVE_SHELLS.has(invocation.executable)) return undefined;

  const commandOptionIndex = invocation.args.findIndex(
    (arg) => arg === "-c" || (/^-[^-]*c[^-]*$/u.test(arg) && arg !== "-"),
  );
  return commandOptionIndex >= 0 ? invocation.args[commandOptionIndex + 1] : undefined;
}

export function guardWorktreeOperation(
  operation: CoveredPiOperation,
  context: LeaseGuardContext,
): SafetyDecision {
  const bashEffect =
    operation.kind === "bash" ? classifyBashEffect(operation.command, operation.cwd) : undefined;

  if (context.leaseSnapshot.status === "unavailable") {
    if (bashEffect?.kind === "read-only") return { action: "allow" };
    return deny(
      "lease-registry-unavailable",
      `Covered mutation blocked because the Dispatch Registry is unavailable: ${context.leaseSnapshot.reason}`,
    );
  }

  for (const lease of context.leaseSnapshot.leases) {
    if (context.actorTerminalId === lease.targetTerminalId) continue;
    if (!operationConflictsWithLease(operation, bashEffect, lease)) continue;

    return deny(
      "worktree-write-lease",
      `Worktree ${lease.worktreePath} is reserved by dispatch ${lease.dispatchId}.`,
    );
  }

  return { action: "allow" };
}

function operationConflictsWithLease(
  operation: CoveredPiOperation,
  bashEffect: ReturnType<typeof classifyBashEffect> | undefined,
  lease: WorktreeLease,
): boolean {
  const root = resolve(lease.worktreePath);

  if (operation.kind !== "bash") {
    return pathIsInside(root, resolve(operation.cwd, operation.path));
  }

  if (bashEffect?.kind === "read-only") return false;
  if (bashEffect?.kind === "mutating") {
    return bashEffect.paths.some((path) => pathIsInside(root, path));
  }
  if (bashEffect?.kind === "unknown") {
    return (
      bashEffect.paths.some((path) => pathIsInside(root, path)) || operation.command.includes(root)
    );
  }

  return pathIsInside(root, resolve(operation.cwd)) || operation.command.includes(root);
}

function pathIsInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, resolve(candidate));
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
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
    return isProvenCurrentPane(target, context)
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
  context: HerdrShellContext,
): boolean {
  return target !== undefined && context.currentPaneId !== undefined && target === context.currentPaneId;
}

function deny(
  code: Extract<SafetyDecision, { action: "deny" }>["code"],
  reason: string,
  redirect?: string,
): SafetyDecision {
  return redirect ? { action: "deny", code, reason, redirect } : { action: "deny", code, reason };
}
