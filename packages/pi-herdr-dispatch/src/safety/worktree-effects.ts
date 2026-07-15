import { resolve } from "node:path";

import { classifyShellInvocations } from "./shell-classifier.js";

export type BashEffect =
  | { kind: "read-only" }
  | { kind: "mutating"; paths: readonly string[] }
  | { kind: "unknown" };

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
  if (!shell.parsed) return { kind: "unknown" };

  const redirectedPaths = extractRedirectedPaths(command, cwd);
  const mutatingPaths = [...redirectedPaths];
  let unknown = false;

  for (const invocation of shell.invocations) {
    const { executable, args } = invocation;

    if (executable === "git") {
      const subcommand = args.find((arg) => !arg.startsWith("-"));
      if (subcommand && READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) continue;
      mutatingPaths.push(cwd);
      continue;
    }

    if (executable === "sed" || executable === "perl") {
      if (args.some((arg) => arg === "-i" || arg.startsWith("-i"))) {
        mutatingPaths.push(...resolveCandidatePaths(args, cwd));
      } else {
        unknown = true;
      }
      continue;
    }

    if (MUTATING_EXECUTABLES.has(executable)) {
      const candidates = resolveCandidatePaths(args, cwd);
      mutatingPaths.push(...(candidates.length > 0 ? candidates : [cwd]));
      continue;
    }

    if (READ_ONLY_EXECUTABLES.has(executable)) continue;
    unknown = true;
  }

  if (mutatingPaths.length > 0) return { kind: "mutating", paths: unique(mutatingPaths) };
  return unknown ? { kind: "unknown" } : { kind: "read-only" };
}

function resolveCandidatePaths(args: readonly string[], cwd: string): readonly string[] {
  return args
    .filter((arg) => arg.length > 0 && !arg.startsWith("-") && arg !== "--")
    .map((arg) => resolve(cwd, arg));
}

function extractRedirectedPaths(command: string, cwd: string): readonly string[] {
  const paths: string[] = [];
  const pattern = /(?:^|[\s])\d*>>?\s*([^\s;&|]+)/gu;
  for (const match of command.matchAll(pattern)) {
    const raw = match[1]?.replace(/^['"]|['"]$/gu, "");
    if (raw) paths.push(resolve(cwd, raw));
  }
  return paths;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
