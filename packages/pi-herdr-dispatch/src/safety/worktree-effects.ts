import { resolve } from "node:path";

import { classifyShellInvocations } from "./shell-classifier.js";

export type BashEffect =
  | { kind: "read-only" }
  | { kind: "mutating"; paths: readonly string[] }
  | { kind: "unknown"; paths: readonly string[] };

const READ_ONLY_EXECUTABLES = new Set([
  "cat",
  "echo",
  "grep",
  "head",
  "herdr",
  "ls",
  "pwd",
  "rg",
  "stat",
  "tail",
  "test",
  "true",
  "false",
  "wc",
  "[",
]);

const MUTATING_EXECUTABLES = new Set([
  "chmod",
  "chown",
  "cp",
  "install",
  "ln",
  "mkdir",
  "mv",
  "patch",
  "rm",
  "rmdir",
  "tee",
  "touch",
  "truncate",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "describe",
  "diff",
  "grep",
  "log",
  "ls-files",
  "rev-parse",
  "show",
  "status",
]);

export function classifyBashEffect(command: string, cwd: string): BashEffect {
  const shell = classifyShellInvocations(command);
  if (!shell.parsed) return { kind: "unknown", paths: [resolve(cwd)] };

  let workingCwd = resolve(cwd);
  const mutatingPaths: string[] = [];
  const unknownPaths: string[] = [];

  for (const invocation of shell.invocations) {
    const { executable, args } = invocation;

    if (executable === "cd") {
      const destination = args.find((arg) => !arg.startsWith("-"));
      if (destination) workingCwd = resolve(workingCwd, destination);
      else unknownPaths.push(workingCwd);
      continue;
    }

    mutatingPaths.push(...resolveRedirectedPaths(args, workingCwd));

    if (executable === "git") {
      const git = classifyGit(args, workingCwd);
      if (!git.readOnly) mutatingPaths.push(...git.paths);
      continue;
    }

    if (executable === "sed" || executable === "perl") {
      if (args.some((arg) => arg === "-i" || arg.startsWith("-i"))) {
        mutatingPaths.push(...resolveCandidatePaths(args, workingCwd));
      } else {
        unknownPaths.push(workingCwd);
      }
      continue;
    }

    if (MUTATING_EXECUTABLES.has(executable)) {
      const candidates = resolveCandidatePaths(args, workingCwd);
      mutatingPaths.push(...(candidates.length > 0 ? candidates : [workingCwd]));
      continue;
    }

    if (READ_ONLY_EXECUTABLES.has(executable)) continue;
    unknownPaths.push(workingCwd);
  }

  if (unknownPaths.length > 0) {
    return { kind: "unknown", paths: unique([...unknownPaths, ...mutatingPaths]) };
  }
  if (mutatingPaths.length > 0) return { kind: "mutating", paths: unique(mutatingPaths) };
  return { kind: "read-only" };
}

function classifyGit(
  args: readonly string[],
  cwd: string,
): { readOnly: boolean; paths: readonly string[] } {
  let gitCwd = cwd;
  let worktreePath: string | undefined;
  let subcommand: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-C" && args[index + 1]) {
      gitCwd = resolve(gitCwd, args[index + 1]!);
      index += 1;
      continue;
    }
    if (arg === "--work-tree" && args[index + 1]) {
      worktreePath = resolve(gitCwd, args[index + 1]!);
      index += 1;
      continue;
    }
    if (arg.startsWith("--work-tree=")) {
      worktreePath = resolve(gitCwd, arg.slice("--work-tree=".length));
      continue;
    }
    if (arg.startsWith("-")) continue;
    subcommand = arg;
    break;
  }

  return {
    readOnly: subcommand !== undefined && READ_ONLY_GIT_SUBCOMMANDS.has(subcommand),
    paths: unique([gitCwd, ...(worktreePath ? [worktreePath] : [])]),
  };
}

function resolveCandidatePaths(args: readonly string[], cwd: string): readonly string[] {
  return args
    .filter((arg) => arg.length > 0 && !arg.startsWith("-") && arg !== "--")
    .map((arg) => resolve(cwd, arg));
}

function resolveRedirectedPaths(args: readonly string[], cwd: string): readonly string[] {
  const paths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const match = args[index]?.match(/^\d*>>?(.*)$/u);
    if (!match) continue;

    const attached = match[1];
    const target = attached || args[index + 1];
    if (target && target !== "&1" && target !== "&2") paths.push(resolve(cwd, target));
    if (!attached) index += 1;
  }
  return paths;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
