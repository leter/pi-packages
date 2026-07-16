import type { FinalOutcome } from "../registry/types.js";

export interface SanitizedDispatchResult {
  id: string;
  outcome: FinalOutcome;
  summary: string;
  tests?: readonly string[];
  changedFiles?: readonly string[];
  artifacts?: readonly string[];
  blocker?: string;
}

export type ParsedResultLine =
  | { status: "ignore" }
  | { status: "malformed"; raw: string; reason: string }
  | { status: "valid"; raw: string; result: SanitizedDispatchResult };

export interface ResultTailScan {
  valid?: Extract<ParsedResultLine, { status: "valid" }>;
  malformed: readonly Extract<ParsedResultLine, { status: "malformed" }>[];
}

const PREFIX = "DISPATCH_RESULT ";
const MAX_RAW_LENGTH = 16_000;
const MAX_SUMMARY_LENGTH = 1_000;
const MAX_LIST_ITEMS = 20;
const MAX_ITEM_LENGTH = 500;

export function parseResultLine(line: string, expectedId: string): ParsedResultLine {
  const trimmed = line.trim();
  const prefixAt = trimmed.indexOf(PREFIX);
  if (prefixAt < 0) return { status: "ignore" };
  const envelope = trimmed.slice(prefixAt);
  const raw = envelope.slice(0, MAX_RAW_LENGTH);
  const jsonText = envelope.slice(PREFIX.length);
  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch (error) {
    if (!envelope.includes(expectedId)) return { status: "ignore" };
    return { status: "malformed", raw, reason: `invalid JSON: ${errorMessage(error)}` };
  }
  if (!isRecord(value)) return malformedIfMatching(value, expectedId, raw, "envelope must be an object");
  if (value.id !== expectedId) return { status: "ignore" };
  if (
    value.outcome === "done|blocked|failed|cancelled" &&
    value.summary === "..."
  ) {
    // The immutable outbound contract intentionally contains this exact example.
    // It is delivery evidence, not a target result attempt.
    return { status: "ignore" };
  }
  try {
    const outcome = finalOutcome(value.outcome);
    const result: SanitizedDispatchResult = {
      id: expectedId,
      outcome,
      summary: boundedText(value.summary, "summary", MAX_SUMMARY_LENGTH),
      ...optionalList(value, "tests"),
      ...optionalList(value, "changedFiles"),
      ...optionalList(value, "artifacts"),
      ...optionalText(value, "blocker", MAX_SUMMARY_LENGTH),
    };
    return { status: "valid", raw, result };
  } catch (error) {
    return { status: "malformed", raw, reason: errorMessage(error) };
  }
}

export function scanResultTail(text: string, expectedId: string): ResultTailScan {
  const malformed: Extract<ParsedResultLine, { status: "malformed" }>[] = [];
  const lines = text.split(/\r?\n/u);
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !line.includes("DISPATCH_RESULT")) continue;

    let reconstructed = "";
    let lastMalformed: Extract<ParsedResultLine, { status: "malformed" }> | undefined;
    const finalIndex = Math.min(lines.length - 1, index + 7);
    for (let candidateIndex = index; candidateIndex <= finalIndex; candidateIndex += 1) {
      const candidate = lines[candidateIndex]!;
      if (candidateIndex > index && candidate.trimStart().startsWith("```")) break;
      const trimmedCandidate = candidate.trim();
      const barePrefixAt = trimmedCandidate.indexOf("DISPATCH_RESULT");
      reconstructed +=
        candidateIndex === index &&
        barePrefixAt >= 0 &&
        !trimmedCandidate.slice(barePrefixAt).includes("{")
          ? `${trimmedCandidate.slice(0, barePrefixAt)}${PREFIX}`
          : trimmedCandidate;
      const parsed = parseResultLine(reconstructed, expectedId);
      if (parsed.status === "valid") return { valid: parsed, malformed };
      if (parsed.status === "ignore" && containsCompleteEnvelope(reconstructed)) {
        index = candidateIndex;
        lastMalformed = undefined;
        break;
      }
      if (parsed.status === "malformed") {
        lastMalformed = parsed;
        if (!parsed.reason.startsWith("invalid JSON:")) {
          malformed.push(parsed);
          index = candidateIndex;
          lastMalformed = undefined;
          break;
        }
      }
      if (candidateIndex > index && candidate.includes("DISPATCH_RESULT")) break;
    }
    if (lastMalformed) malformed.push(lastMalformed);
  }
  return { malformed };
}

function containsCompleteEnvelope(line: string): boolean {
  const prefixAt = line.indexOf(PREFIX);
  if (prefixAt < 0) return false;
  try {
    JSON.parse(line.slice(prefixAt + PREFIX.length));
    return true;
  } catch {
    return false;
  }
}

function malformedIfMatching(
  value: unknown,
  expectedId: string,
  raw: string,
  reason: string,
): ParsedResultLine {
  return isRecord(value) && value.id === expectedId
    ? { status: "malformed", raw, reason }
    : { status: "ignore" };
}

function finalOutcome(value: unknown): FinalOutcome {
  if (value === "done" || value === "blocked" || value === "failed" || value === "cancelled") {
    return value;
  }
  throw new TypeError("outcome must be done, blocked, failed, or cancelled");
}

function optionalList<K extends "tests" | "changedFiles" | "artifacts">(
  value: Record<string, unknown>,
  key: K,
): Partial<Record<K, readonly string[]>> {
  if (value[key] === undefined) return {};
  if (!Array.isArray(value[key])) throw new TypeError(`${key} must be an array`);
  if (value[key].length > MAX_LIST_ITEMS) {
    throw new RangeError(`${key} must contain at most ${MAX_LIST_ITEMS} items`);
  }
  return {
    [key]: Object.freeze(
      value[key].map((item, index) => boundedText(item, `${key}[${index}]`, MAX_ITEM_LENGTH)),
    ),
  } as Partial<Record<K, readonly string[]>>;
}

function optionalText<K extends "blocker">(
  value: Record<string, unknown>,
  key: K,
  maximum: number,
): Partial<Record<K, string>> {
  return value[key] === undefined ? {} : ({ [key]: boundedText(value[key], key, maximum) } as Record<K, string>);
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const sanitized = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " ")
    .trim();
  if (!sanitized) throw new TypeError(`${label} must not be empty`);
  if (sanitized.length > maximum) throw new RangeError(`${label} must not exceed ${maximum} characters`);
  return sanitized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
