import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_TEAM_CATALOG,
  executorRoleForCycle,
  isReworkExhausted,
  loadTeamConfig,
  parseTeamConfig,
} from "../../src/domain/team.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("team catalog", () => {
  it("loads the seven valid built-in roles and three workflows when the file is missing", async () => {
    const state = await loadTeamConfig("/definitely/missing/pi-herdr-team.json");
    expect(state.status).toBe("ready");
    if (state.status !== "ready") return;
    expect(Object.keys(state.team.roles)).toEqual([
      "coder", "reviewer", "bugfix", "chore", "researcher", "advisor", "oracle",
    ]);
    expect(Object.fromEntries(
      Object.entries(state.team.roles).map(([key, role]) => [key, role.agent]),
    )).toEqual({
      coder: "codex",
      reviewer: "claude",
      bugfix: "amp",
      chore: "pi",
      researcher: "grok",
      advisor: "opencode",
      oracle: "droid",
    });
    expect(state.team.workflows.dev).toEqual({
      key: "dev",
      stages: ["coder", "reviewer"],
      maxReworkCycles: 2,
      escalation: [
        { afterCycles: 2, role: "bugfix" },
        { afterCycles: 4, role: "oracle" },
      ],
    });
    expect(Object.values(state.team.roles).every((role) => role.brief.length <= 400)).toBe(true);
  });

  it("replaces matching entries wholesale by key and accepts new keys", () => {
    const team = parseTeamConfig({
      roles: {
        coder: { label: "主程", mode: "write", brief: "Act as the primary implementer." },
        analyst: {
          label: "分析",
          mode: "non-mutating",
          brief: "Analyze the bounded question.",
          agent: "grok",
        },
      },
      workflows: {
        research: { stages: ["analyst"], maxReworkCycles: 0, escalation: [] },
      },
    });
    expect(team.roles.coder).toEqual({
      key: "coder",
      label: "主程",
      mode: "write",
      brief: "Act as the primary implementer.",
    });
    expect(team.roles.analyst?.agent).toBe("grok");
    expect(team.roles.reviewer).toEqual(DEFAULT_TEAM_CATALOG.roles.reviewer);
    expect(team.workflows.research).toEqual({
      key: "research",
      stages: ["analyst"],
      maxReworkCycles: 0,
      escalation: [],
    });
  });

  it.each([
    ["non-object", []],
    ["unknown top-level field", { extra: true }],
    ["roles must be a map", { roles: [] }],
    ["invalid role key", { roles: { "Bad Key": { label: "坏", mode: "write", brief: "Brief." } } }],
    ["unknown role field", { roles: { coder: { label: "开发", mode: "write", brief: "Brief.", extra: true } } }],
    ["missing role field", { roles: { coder: { label: "开发", mode: "write" } } }],
    ["bad role mode", { roles: { coder: { label: "开发", mode: "admin", brief: "Brief." } } }],
    ["unsupported role agent", { roles: { coder: { label: "开发", mode: "write", brief: "Brief.", agent: "other" } } }],
    ["empty label", { roles: { coder: { label: "", mode: "write", brief: "Brief." } } }],
    ["long label", { roles: { coder: { label: "角".repeat(21), mode: "write", brief: "Brief." } } }],
    ["long brief", { roles: { coder: { label: "开发", mode: "write", brief: "x".repeat(401) } } }],
    ["workflow must be object", { workflows: { dev: [] } }],
    ["unknown workflow field", { workflows: { dev: { stages: ["coder"], maxReworkCycles: 2, escalation: [], extra: true } } }],
    ["empty stages", { workflows: { dev: { stages: [], maxReworkCycles: 2, escalation: [] } } }],
    ["unknown stage role", { workflows: { dev: { stages: ["missing"], maxReworkCycles: 2, escalation: [] } } }],
    ["non-integer budget", { workflows: { dev: { stages: ["coder"], maxReworkCycles: 1.5, escalation: [] } } }],
    ["negative budget", { workflows: { dev: { stages: ["coder"], maxReworkCycles: -1, escalation: [] } } }],
    ["large budget", { workflows: { dev: { stages: ["coder"], maxReworkCycles: 11, escalation: [] } } }],
    ["escalation must be array", { workflows: { dev: { stages: ["coder"], maxReworkCycles: 2, escalation: {} } } }],
    ["unknown escalation field", { workflows: { dev: { stages: ["coder"], maxReworkCycles: 2, escalation: [{ afterCycles: 1, role: "bugfix", extra: true }] } } }],
    ["non-positive escalation", { workflows: { dev: { stages: ["coder"], maxReworkCycles: 2, escalation: [{ afterCycles: 0, role: "bugfix" }] } } }],
    ["unordered escalation", { workflows: { dev: { stages: ["coder"], maxReworkCycles: 2, escalation: [{ afterCycles: 2, role: "bugfix" }, { afterCycles: 2, role: "oracle" }] } } }],
    ["unknown escalation role", { workflows: { dev: { stages: ["coder"], maxReworkCycles: 2, escalation: [{ afterCycles: 1, role: "missing" }] } } }],
  ])("fails closed for %s", (_label, value) => {
    expect(() => parseTeamConfig(value)).toThrow();
  });

  it("returns an invalid state for malformed JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-herdr-team-"));
    cleanupPaths.push(directory);
    const path = join(directory, "team.json");
    await writeFile(path, "{broken", "utf8");
    await expect(loadTeamConfig(path)).resolves.toMatchObject({ status: "invalid" });
  });

  it("selects the latest reached executor escalation", () => {
    const workflow = DEFAULT_TEAM_CATALOG.workflows.dev!;
    expect([0, 1, 2, 3, 4, 5].map((cycles) => executorRoleForCycle(workflow, cycles)))
      .toEqual(["coder", "coder", "bugfix", "bugfix", "oracle", "oracle"]);
  });

  it("applies exhaustion boundaries with and without escalation", () => {
    const dev = DEFAULT_TEAM_CATALOG.workflows.dev!;
    const research = DEFAULT_TEAM_CATALOG.workflows.research!;
    expect([0, 1, 2, 4, 5, 6].map((cycles) => isReworkExhausted(dev, cycles)))
      .toEqual([false, false, false, false, false, true]);
    expect([0, 1, 2, 3].map((cycles) => isReworkExhausted(research, cycles)))
      .toEqual([false, false, true, true]);
  });
});
