import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DISPATCH_CONFIG,
  loadDispatchConfig,
  parseDispatchConfig,
} from "../../src/domain/config.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("dispatch configuration", () => {
  it("uses reviewed defaults when the optional config file is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-herdr-config-"));
    roots.push(root);

    await expect(loadDispatchConfig(join(root, "missing.json"))).resolves.toEqual({
      status: "ready",
      config: DEFAULT_DISPATCH_CONFIG,
    });
  });

  it("merges valid bounded overrides", () => {
    expect(
      parseDispatchConfig({
        defaultDeadlineMinutes: 45,
        startupWindowMs: 12_000,
        agentStartupTimeoutMs: 90_000,
        maxActiveGlobal: 10,
        maxAutoRunDepth: 20,
        defaultRunQuota: 50,
        defaultLaunchBudget: 0,
      }),
    ).toEqual({
      ...DEFAULT_DISPATCH_CONFIG,
      defaultDeadlineMinutes: 45,
      startupWindowMs: 12_000,
      agentStartupTimeoutMs: 90_000,
      maxActiveGlobal: 10,
      maxAutoRunDepth: 20,
      defaultRunQuota: 50,
      defaultLaunchBudget: 0,
    });
  });

  it.each([
    { unknown: true },
    { defaultDeadlineMinutes: 0 },
    { minDeadlineMinutes: 60, defaultDeadlineMinutes: 30 },
    { startupWindowMs: 1_000 },
    { agentStartupTimeoutMs: 4_999 },
    { agentStartupTimeoutMs: 300_001 },
    { maxActivePerTargetWorkspace: 9, maxActiveGlobal: 8 },
    { inspectionLines: 80 },
    { maxInspectionLines: 1000 },
    { maxAutoRunDepth: 0 },
    { maxAutoRunDepth: 21 },
    { maxAutoRunDepth: 2.5 },
    { defaultRunQuota: 0 },
    { defaultRunQuota: 51 },
    { defaultRunQuota: 1.5 },
    { defaultLaunchBudget: -1 },
    { defaultLaunchBudget: 11 },
    { defaultLaunchBudget: 1.5 },
  ])("rejects unsafe config instead of partially applying it: %j", (value) => {
    expect(() => parseDispatchConfig(value)).toThrow();
  });

  it("returns an invalid state for malformed JSON so callers can disable mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-herdr-config-"));
    roots.push(root);
    const path = join(root, "config.json");
    await writeFile(path, "{broken", "utf8");

    await expect(loadDispatchConfig(path)).resolves.toEqual(
      expect.objectContaining({ status: "invalid", reason: expect.any(String) }),
    );
  });
});
