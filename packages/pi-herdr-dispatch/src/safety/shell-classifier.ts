export interface ShellInvocation {
  executable: string;
  args: readonly string[];
}

export type ShellClassification =
  | { parsed: true; invocations: readonly ShellInvocation[] }
  | { parsed: false; containsLiteralHerdr: boolean };

type Token =
  | { kind: "word"; value: string }
  | { kind: "separator"; value: string };

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/s;
const REDIRECTION = /^\d*(?:>{1,2}|<{1,2}|<>|>&|<&)/;
const HERDR_WORD = /\bherdr\b/u;

// Executables that run their arguments as a new command (wrappers, shells,
// eval). Their option grammars are not modelled: any launcher invocation
// that mentions herdr is reported as unparseable so the policy fails closed
// and redirects to the typed dispatch path.
const COMMAND_LAUNCHERS = new Set([
  "bash",
  "command",
  "dash",
  "env",
  "eval",
  "exec",
  "ionice",
  "nice",
  "nohup",
  "parallel",
  "setsid",
  "sh",
  "stdbuf",
  "sudo",
  "time",
  "timeout",
  "xargs",
  "zsh",
]);

export function classifyShellInvocations(command: string): ShellClassification {
  const tokens = lexShell(command);
  if (tokens === undefined) {
    return { parsed: false, containsLiteralHerdr: HERDR_WORD.test(command) };
  }

  const groups: string[][] = [[]];
  for (const token of tokens) {
    if (token.kind === "separator") {
      if (groups.at(-1)?.length) groups.push([]);
      continue;
    }
    groups.at(-1)?.push(token.value);
  }

  const invocations: ShellInvocation[] = [];
  for (const group of groups) {
    const invocation = resolveInvocation(group);
    if (invocation === undefined) continue;
    if (
      COMMAND_LAUNCHERS.has(invocation.executable) &&
      invocation.args.some((arg) => HERDR_WORD.test(arg))
    ) {
      return { parsed: false, containsLiteralHerdr: true };
    }
    invocations.push(invocation);
  }

  return { parsed: true, invocations };
}

function resolveInvocation(words: readonly string[]): ShellInvocation | undefined {
  let index = 0;
  while (index < words.length && ASSIGNMENT.test(words[index]!)) index += 1;
  index = skipRedirections(words, index);
  const executable = words[index];
  if (!executable) return undefined;
  return { executable: basename(executable), args: words.slice(index + 1) };
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
      } else if (char === "`") {
        return undefined;
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
    if (char === "`") return undefined;
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
