import { complete, getModel } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";

const MAX_TITLE_WIDTH = 28;
const MAX_INPUT_LENGTH = 4000;
const NON_INSTRUCTION_INPUTS = new Set([
  "好", "好的", "好吧", "行", "可以", "对", "是", "嗯", "收到", "继续",
  "ok", "okay", "yes", "yep", "continue", "go ahead",
]);
const CLASSIFIER_TIMEOUT_MS = 8000;
const MAX_CONSECUTIVE_FAILURES = 3;
const TITLE_ENTRY_TYPE = "session-activity-title";
const TITLE_MODEL_PROVIDER = "openai-codex";
const TITLE_MODEL_ID = "gpt-5.4-mini";
const FACTORY_CONFIG_PATHS = [
  join(homedir(), ".factory", "settings.local.json"),
  join(homedir(), ".factory", "settings.json"),
];

export type TitleDecision =
  | { action: "keep" }
  | { action: "update"; title: string };

export type TitleClassifier = (
  input: string,
  currentTitle: string | undefined,
  ctx: ExtensionContext,
  signal: AbortSignal,
) => Promise<TitleDecision | undefined>;

export function normalizeInstructionInput(input: string): string | undefined {
  const normalized = stripVTControlCharacters(input)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim();
  const firstLine = normalized.split(/\r?\n/).find((line) => line.trim())?.trim();
  if (!firstLine || firstLine.startsWith("/") || firstLine.startsWith("!")) {
    return undefined;
  }
  const decisionKey = normalized
    .replace(/[。！!，,？?]+$/u, "")
    .trim()
    .toLocaleLowerCase();
  if (NON_INSTRUCTION_INPUTS.has(decisionKey)) return undefined;
  return normalized.slice(0, MAX_INPUT_LENGTH);
}

function truncatePlainTitle(value: string): string {
  if (visibleWidth(value) <= MAX_TITLE_WIDTH) return value;
  let result = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)) {
    if (visibleWidth(`${result}${segment}…`) > MAX_TITLE_WIDTH) break;
    result += segment;
  }
  return `${result}…`;
}

function normalizeGeneratedTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const firstLine = stripVTControlCharacters(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^[>#▸]\s*/, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return firstLine ? truncatePlainTitle(firstLine) : undefined;
}

export function parseTitleDecision(output: string): TitleDecision | undefined {
  const object = output.match(/\{[\s\S]*\}/)?.[0];
  if (!object) return undefined;
  try {
    const value = JSON.parse(object) as { action?: unknown; title?: unknown };
    if (value.action === "keep") return { action: "keep" };
    if (value.action === "update") {
      const title = normalizeGeneratedTitle(value.title);
      return title ? { action: "update", title } : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function buildTitleDecisionPrompt(input: string, currentTitle: string | undefined): string {
  return [
    "Decide whether the new human input changes the concrete instruction currently driving the agent.",
    "Return JSON only, with no markdown.",
    "Use {\"action\":\"keep\"} when the input only confirms, acknowledges, repeats, or asks to continue the current instruction.",
    "Use {\"action\":\"update\",\"title\":\"...\"} when it starts, corrects, refines, redirects, or stops concrete work.",
    "For update, write a concise activity title in the user's language. Preserve enough prior context to make corrections meaningful.",
    "Remove attachment paths and UI chatter. Do not include a leading ▸.",
    "For Chinese, target 8 to 14 characters. For mixed-language titles, stay within 28 terminal columns.",
    "",
    `<current-title>${currentTitle ?? ""}</current-title>`,
    `<new-input>${input}</new-input>`,
  ].join("\n");
}

type FactoryByok = { baseUrl: string; apiKey: string };

type FactorySettings = {
  customModels?: Array<{
    model?: unknown;
    baseUrl?: unknown;
    apiKey?: unknown;
    provider?: unknown;
  }>;
};

function expandedApiKey(value: string, env: NodeJS.ProcessEnv): string | undefined {
  const reference = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1];
  return reference ? env[reference] : value;
}

export function resolveFactoryByok(
  settings: FactorySettings[],
  env: NodeJS.ProcessEnv = process.env,
): FactoryByok | undefined {
  const models = settings.flatMap((value) => Array.isArray(value.customModels) ? value.customModels : []);
  const candidates = [
    ...models.filter((model) => model.model === TITLE_MODEL_ID && model.provider === "openai"),
    ...models.filter((model) => model.provider === "openai"),
  ];
  for (const candidate of candidates) {
    if (typeof candidate.baseUrl !== "string" || typeof candidate.apiKey !== "string") continue;
    const apiKey = expandedApiKey(candidate.apiKey, env)?.trim();
    const baseUrl = candidate.baseUrl.trim().replace(/\/+$/, "");
    if (!apiKey || !/^https?:\/\//.test(baseUrl)) continue;
    return { baseUrl, apiKey };
  }
  return undefined;
}

async function loadFactoryByok(): Promise<FactoryByok | undefined> {
  const settings: FactorySettings[] = [];
  for (const path of FACTORY_CONFIG_PATHS) {
    try {
      settings.push(JSON.parse(await readFile(path, "utf8")) as FactorySettings);
    } catch {
      // Missing or malformed optional Droid BYOK files are a fail-closed title decision.
    }
  }
  return resolveFactoryByok(settings);
}

export const classifyTitleWithAI: TitleClassifier = async (input, currentTitle, _ctx, signal) => {
  const catalogModel = getModel(TITLE_MODEL_PROVIDER, TITLE_MODEL_ID);
  const byok = await loadFactoryByok();
  if (!catalogModel || !byok) return undefined;
  const model = {
    ...catalogModel,
    provider: "session-title-byok",
    baseUrl: byok.baseUrl,
    api: "openai-responses" as const,
  };

  const response = await complete(
    model,
    {
      messages: [{
        role: "user",
        content: [{ type: "text", text: buildTitleDecisionPrompt(input, currentTitle) }],
        timestamp: Date.now(),
      }],
    },
    {
      apiKey: byok.apiKey,
      maxTokens: 96,
      reasoningEffort: "low",
      signal,
    },
  );
  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return parseTitleDecision(text);
};

function restoredActivityTitle(ctx: ExtensionContext): string | undefined {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== TITLE_ENTRY_TYPE) continue;
    const data = entry.data as { version?: unknown; title?: unknown } | undefined;
    if (data?.version === 1) return normalizeGeneratedTitle(data.title);
  }
  return undefined;
}

function showTitle(ctx: ExtensionContext, title: string | undefined): void {
  if (title) ctx.ui.setTitle(title);
}

export function createSessionTitleExtension(classify: TitleClassifier = classifyTitleWithAI) {
  return function sessionTitleExtension(pi: ExtensionAPI) {
    let activityTitle: string | undefined;
    let generation = 0;
    let queue: Promise<void> = Promise.resolve();
    let activeController: AbortController | undefined;
    let consecutiveFailures = 0;
    let classifierDisabled = false;

    pi.on("session_start", (_event, ctx) => {
      generation += 1;
      activeController?.abort();
      activeController = undefined;
      consecutiveFailures = 0;
      classifierDisabled = false;
      activityTitle = restoredActivityTitle(ctx) ?? pi.getSessionName();
      showTitle(ctx, activityTitle);
    });

    pi.on("session_info_changed", (event, ctx) => {
      if (event.name !== activityTitle) {
        generation += 1;
        activeController?.abort();
        activeController = undefined;
      }
      activityTitle = event.name;
      showTitle(ctx, activityTitle);
    });

    pi.on("input", (event, ctx) => {
      if (event.source === "extension") return { action: "continue" as const };
      const input = normalizeInstructionInput(event.text);
      if (!input || classifierDisabled) return { action: "continue" as const };
      const scheduledGeneration = generation;

      queue = queue.then(async () => {
        if (scheduledGeneration !== generation || classifierDisabled) return;
        const controller = new AbortController();
        activeController = controller;
        const timeout = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);
        let decision: TitleDecision | undefined;
        try {
          decision = await classify(input, activityTitle, ctx, controller.signal);
        } catch {
          if (scheduledGeneration === generation) {
            consecutiveFailures += 1;
            classifierDisabled = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
          }
          return;
        } finally {
          clearTimeout(timeout);
          if (activeController === controller) activeController = undefined;
        }
        if (scheduledGeneration !== generation) return;
        if (!decision) {
          consecutiveFailures += 1;
          classifierDisabled = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
          return;
        }
        consecutiveFailures = 0;
        if (decision.action === "keep") return;
        if (decision.title === activityTitle) return;

        activityTitle = decision.title;
        pi.appendEntry(TITLE_ENTRY_TYPE, { version: 1, title: activityTitle });
        if (!pi.getSessionName()) pi.setSessionName(activityTitle);
        showTitle(ctx, activityTitle);
      }).catch(() => undefined);

      return { action: "continue" as const };
    });

    pi.on("session_shutdown", () => {
      generation += 1;
      activeController?.abort();
      activeController = undefined;
    });
  };
}

export default createSessionTitleExtension();
