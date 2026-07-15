export interface ShellInvocation {
  executable: string;
  args: readonly string[];
  assignments: ReadonlyMap<string, string>;
}

export type ShellClassification =
  | { parsed: true; invocations: readonly ShellInvocation[] }
  | { parsed: false; containsLiteralHerdr: boolean };

type Token =
  | { kind: "word"; value: string }
  | { kind: "separator"; value: string };

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const REDIRECTION = /^\d*(?:>{1,2}|<{1,2}|<>|>&|<&)/;
const WRAPPERS = new Set(["command", "env", "exec", "nohup", "sudo"]);

export function classifyShellInvocations(command: string): ShellClassification {
  const tokens = lexShell(command);
  if (tokens === undefined) {
    return { parsed: false, containsLiteralHerdr: /\bherdr\b/.test(command) };
  }

  const groups: string[][] = [[]];
  for (const token of tokens) {
    if (token.kind === "separator") {
      if (groups.at(-1)?.length) groups.push([]);
      continue;
    }
    groups.at(-1)?.push(token.value);
  }

  const invocations = groups
    .filter((group) => group.length > 0)
    .map(resolveInvocation)
    .filter((invocation): invocation is ShellInvocation => invocation !== undefined);

  return { parsed: true, invocations };
}

function resolveInvocation(words: readonly string[]): ShellInvocation | undefined {
  const assignments = new Map<string, string>();
  let index = 0;

  while (index < words.length) {
    const assignment = words[index]?.match(ASSIGNMENT);
    if (!assignment) break;
    assignments.set(assignment[1], assignment[2]);
    index += 1;
  }

  index = skipRedirections(words, index);
  let executable = words[index];
  if (!executable) return undefined;

  while (WRAPPERS.has(basename(executable))) {
    const wrapper = basename(executable);
    index += 1;

    if (wrapper === "env") {
      while (index < words.length) {
        const word = words[index]!;
        const assignment = word.match(ASSIGNMENT);
        if (assignment) {
          assignments.set(assignment[1], assignment[2]);
          index += 1;
          continue;
        }
        if (word.startsWith("-")) {
          index += 1;
          continue;
        }
        break;
      }
    } else {
      while (words[index]?.startsWith("-")) index += 1;
    }

    index = skipRedirections(words, index);
    executable = words[index];
    if (!executable) return undefined;
  }

  return {
    executable: basename(executable),
    args: words.slice(index + 1),
    assignments,
  };
}

function skipRedirections(words: readonly string[], start: number): number {
  let index = start;
  while (index < words.length && REDIRECTION.test(words[index]!)) {
    if (/^\d*(?:>|>>|<|<<|<>|>&|<&)$/u.test(words[index]!)) index += 1;
    index += 1;
  }
  return index;
}

function basename(value: string): string {
  return value.slice(value.lastIndexOf("/") + 1);
}

function lexShell(command: string): readonly Token[] | undefined {
  const tokens: Token[] = [];
  let word = "";
  let wordStarted = false;
  let quote: "single" | "double" | undefined;
  let escaped = false;

  const emitWord = () => {
    if (!wordStarted) return;
    tokens.push({ kind: "word", value: word });
    word = "";
    wordStarted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;

    if (escaped) {
      word += char;
      wordStarted = true;
      escaped = false;
      continue;
    }

    if (quote === "single") {
      if (char === "'") quote = undefined;
      else word += char;
      wordStarted = true;
      continue;
    }

    if (quote === "double") {
      if (char === '"') {
        quote = undefined;
      } else if (char === "\\") {
        escaped = true;
      } else {
        word += char;
      }
      wordStarted = true;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      wordStarted = true;
      continue;
    }
    if (char === "'") {
      quote = "single";
      wordStarted = true;
      continue;
    }
    if (char === '"') {
      quote = "double";
      wordStarted = true;
      continue;
    }
    if (char === "#" && !wordStarted) {
      while (index + 1 < command.length && command[index + 1] !== "\n") index += 1;
      continue;
    }
    if (/\s/u.test(char)) {
      emitWord();
      if (char === "\n") tokens.push({ kind: "separator", value: "\n" });
      continue;
    }
    if (char === ";" || char === "|" || char === "&" || char === "(" || char === ")") {
      emitWord();
      const next = command[index + 1];
      const doubled = (char === "|" || char === "&") && next === char;
      tokens.push({ kind: "separator", value: doubled ? char + next : char });
      if (doubled) index += 1;
      continue;
    }

    word += char;
    wordStarted = true;
  }

  if (escaped || quote) return undefined;
  emitWord();
  return tokens;
}
