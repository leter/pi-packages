import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface DispatchConfig {
  defaultDeadlineMinutes: number;
  minDeadlineMinutes: number;
  maxDeadlineMinutes: number;
  startupWindowMs: number;
  agentStartupTimeoutMs: number;
  minStartupWindowMs: number;
  maxStartupWindowMs: number;
  maxActivePerTargetWorkspace: number;
  maxActiveGlobal: number;
  retentionDays: number;
  livenessPollMs: number;
  maxAutoRunDepth: number;
  defaultRunQuota: number;
  defaultLaunchBudget: number;
}

/** Adapter hard limit for bounded output reads (contract: 50 or 200 lines). */
export const MAX_INSPECTION_LINES = 200;

export type DispatchConfigState =
  | { status: "ready"; config: DispatchConfig }
  | { status: "invalid"; reason: string };

export const DEFAULT_DISPATCH_CONFIG: DispatchConfig = Object.freeze({
  defaultDeadlineMinutes: 30,
  minDeadlineMinutes: 1,
  maxDeadlineMinutes: 1440,
  startupWindowMs: 30_000,
  agentStartupTimeoutMs: 60_000,
  minStartupWindowMs: 5_000,
  maxStartupWindowMs: 300_000,
  maxActivePerTargetWorkspace: 4,
  maxActiveGlobal: 8,
  retentionDays: 30,
  livenessPollMs: 5_000,
  maxAutoRunDepth: 5,
  defaultRunQuota: 10,
  defaultLaunchBudget: 2,
});

export function defaultConfigPath(home = homedir()): string {
  return join(home, ".config", "pi-herdr-dispatch", "config.json");
}

export async function loadDispatchConfig(path = defaultConfigPath()): Promise<DispatchConfigState> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { status: "ready", config: { ...DEFAULT_DISPATCH_CONFIG } };
    return { status: "invalid", reason: errorMessage(error) };
  }
  try {
    return { status: "ready", config: parseDispatchConfig(JSON.parse(text)) };
  } catch (error) {
    return { status: "invalid", reason: errorMessage(error) };
  }
}

export async function writeDispatchConfig(
  patch: Partial<DispatchConfig>,
  path = defaultConfigPath(),
): Promise<DispatchConfig> {
  const current = await readJsonObject(path, "dispatch config");
  const merged = { ...current, ...patch };
  const config = parseDispatchConfig(merged);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(merged, null, 2), "utf8");
  await rename(`${path}.tmp`, path);
  return config;
}

export function parseDispatchConfig(value: unknown): DispatchConfig {
  if (!isRecord(value)) throw new TypeError("dispatch config must be a JSON object");
  // Unknown keys are ignored and preserved on write (forward-compatible with
  // configs from newer builds); only the known fields below are validated.
  const config = { ...DEFAULT_DISPATCH_CONFIG };
  for (const key of Object.keys(config) as (keyof DispatchConfig)[]) {
    if (value[key] !== undefined) config[key] = integer(value[key], key);
  }

  range(config.minDeadlineMinutes, 1, 1440, "minDeadlineMinutes");
  range(config.maxDeadlineMinutes, 1, 1440, "maxDeadlineMinutes");
  ordered(config.minDeadlineMinutes, config.defaultDeadlineMinutes, config.maxDeadlineMinutes, "deadline minutes");
  range(config.minStartupWindowMs, 1, 300_000, "minStartupWindowMs");
  range(config.maxStartupWindowMs, 1, 300_000, "maxStartupWindowMs");
  ordered(config.minStartupWindowMs, config.startupWindowMs, config.maxStartupWindowMs, "startup window");
  range(config.agentStartupTimeoutMs, 5_000, 300_000, "agentStartupTimeoutMs");
  range(config.maxActivePerTargetWorkspace, 1, 100, "maxActivePerTargetWorkspace");
  range(config.maxActiveGlobal, 1, 1000, "maxActiveGlobal");
  if (config.maxActivePerTargetWorkspace > config.maxActiveGlobal) {
    throw new RangeError("maxActivePerTargetWorkspace must not exceed maxActiveGlobal");
  }
  range(config.retentionDays, 1, 365, "retentionDays");
  range(config.livenessPollMs, 1_000, 60_000, "livenessPollMs");
  range(config.maxAutoRunDepth, 1, 20, "maxAutoRunDepth");
  range(config.defaultRunQuota, 1, 50, "defaultRunQuota");
  range(config.defaultLaunchBudget, 0, 10, "defaultLaunchBudget");
  return config;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be an integer`);
  return value as number;
}

function range(value: number, minimum: number, maximum: number, label: string): void {
  if (value < minimum || value > maximum) {
    throw new RangeError(`${label} must be from ${minimum} to ${maximum}`);
  }
}

function ordered(minimum: number, value: number, maximum: number, label: string): void {
  if (minimum > value || value > maximum) {
    throw new RangeError(`${label} must satisfy minimum <= default <= maximum`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function readJsonObject(path: string, label: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new TypeError(`${label} must be a JSON object`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
