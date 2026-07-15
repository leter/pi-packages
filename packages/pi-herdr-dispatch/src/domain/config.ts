import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DispatchConfig {
  defaultDeadlineMinutes: number;
  minDeadlineMinutes: number;
  maxDeadlineMinutes: number;
  startupWindowMs: number;
  minStartupWindowMs: number;
  maxStartupWindowMs: number;
  maxActivePerTargetWorkspace: number;
  maxActiveGlobal: number;
  retentionDays: number;
  inspectionLines: number;
  maxInspectionLines: number;
  catchUpLines: number;
  cwdPollMs: number;
  cwdDriftSamples: number;
}

export type DispatchConfigState =
  | { status: "ready"; config: DispatchConfig }
  | { status: "invalid"; reason: string };

export const DEFAULT_DISPATCH_CONFIG: DispatchConfig = Object.freeze({
  defaultDeadlineMinutes: 30,
  minDeadlineMinutes: 1,
  maxDeadlineMinutes: 1440,
  startupWindowMs: 30_000,
  minStartupWindowMs: 5_000,
  maxStartupWindowMs: 300_000,
  maxActivePerTargetWorkspace: 4,
  maxActiveGlobal: 8,
  retentionDays: 30,
  inspectionLines: 50,
  maxInspectionLines: 200,
  catchUpLines: 200,
  cwdPollMs: 5_000,
  cwdDriftSamples: 2,
});

const CONFIG_KEYS = new Set(Object.keys(DEFAULT_DISPATCH_CONFIG));

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

export function parseDispatchConfig(value: unknown): DispatchConfig {
  if (!isRecord(value)) throw new TypeError("dispatch config must be a JSON object");
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw new TypeError(`unknown dispatch config field ${key}`);
  }
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
  range(config.maxActivePerTargetWorkspace, 1, 100, "maxActivePerTargetWorkspace");
  range(config.maxActiveGlobal, 1, 1000, "maxActiveGlobal");
  if (config.maxActivePerTargetWorkspace > config.maxActiveGlobal) {
    throw new RangeError("maxActivePerTargetWorkspace must not exceed maxActiveGlobal");
  }
  range(config.retentionDays, 1, 365, "retentionDays");
  if (config.inspectionLines !== 50) throw new RangeError("inspectionLines must be 50 in V1");
  if (config.maxInspectionLines !== 200) throw new RangeError("maxInspectionLines must be 200 in V1");
  if (config.catchUpLines !== 200) throw new RangeError("catchUpLines must be 200 in V1");
  range(config.cwdPollMs, 1_000, 60_000, "cwdPollMs");
  range(config.cwdDriftSamples, 2, 10, "cwdDriftSamples");
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
