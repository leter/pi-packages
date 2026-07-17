import { describe, expect, it } from "vitest";

import { SUPPORTED_AGENT_TYPES } from "../../src/dispatch/agent-launch.js";
import { DEFAULT_DISPATCH_CONFIG } from "../../src/domain/config.js";
import { DEFAULT_TEAM_CATALOG } from "../../src/domain/team.js";
import {
  buildSettingsState,
  buildSettingsLines,
  cycleAgent,
  moveCursor,
  stepNumeric,
} from "../../src/pi/settings-view-model.js";

const plain = (line: ReturnType<typeof buildSettingsLines>[number]): string =>
  line.spans.map((span) => span.text).join("");

describe("settings view model", () => {
  it("builds the four runtime settings and seven role agents in contract order", () => {
    const state = buildSettingsState(DEFAULT_DISPATCH_CONFIG, DEFAULT_TEAM_CATALOG);

    expect(state.rows.map((row) => row.kind === "config" ? row.key : row.roleKey)).toEqual([
      "defaultRunQuota",
      "defaultLaunchBudget",
      "maxAutoRunDepth",
      "defaultDeadlineMinutes",
      "coder",
      "reviewer",
      "bugfix",
      "chore",
      "researcher",
      "advisor",
      "oracle",
    ]);
    expect(state.rows[3]).toMatchObject({ value: 30, min: 1, max: 1440, step: 5 });
    expect(state.rows[4]).toMatchObject({ agent: "codex", agentIndex: 2 });
  });

  it("moves the cursor without leaving the row list", () => {
    const state = buildSettingsState(DEFAULT_DISPATCH_CONFIG, DEFAULT_TEAM_CATALOG);

    expect(moveCursor(state, -1).cursor).toBe(0);
    expect(moveCursor(state, 3).cursor).toBe(3);
    expect(moveCursor({ ...state, cursor: 10 }, 1).cursor).toBe(10);
  });

  it("steps and clamps numeric rows while emitting a config change", () => {
    const state = buildSettingsState(
      { ...DEFAULT_DISPATCH_CONFIG, defaultRunQuota: 50, defaultDeadlineMinutes: 3 },
      DEFAULT_TEAM_CATALOG,
    );
    const quota = state.rows[0];
    const deadline = state.rows[3];
    if (quota?.kind !== "config" || deadline?.kind !== "config") throw new Error("bad fixture");

    expect(stepNumeric(quota, 1)).toMatchObject({
      row: { value: 50 },
      change: { kind: "config", key: "defaultRunQuota", value: 50 },
    });
    expect(stepNumeric(deadline, -1)).toMatchObject({
      row: { value: 1 },
      change: { kind: "config", key: "defaultDeadlineMinutes", value: 1 },
    });
  });

  it("cycles role agents in the fixed catalog order with wrapping", () => {
    const state = buildSettingsState(DEFAULT_DISPATCH_CONFIG, DEFAULT_TEAM_CATALOG);
    const coder = state.rows[4];
    if (coder?.kind !== "role-agent") throw new Error("bad fixture");

    expect(cycleAgent(coder, 1)).toMatchObject({
      row: { agent: "opencode", agentIndex: 3 },
      change: { kind: "role-agent", roleKey: "coder", agent: "opencode" },
    });
    const first = { ...coder, agent: SUPPORTED_AGENT_TYPES[0], agentIndex: 0 };
    expect(cycleAgent(first, -1)).toMatchObject({
      row: { agent: "grok", agentIndex: 6 },
      change: { kind: "role-agent", roleKey: "coder", agent: "grok" },
    });
  });

  it("renders zh-CN groups without exposing internal dispatch IDs", () => {
    const lines = buildSettingsLines(
      buildSettingsState(DEFAULT_DISPATCH_CONFIG, DEFAULT_TEAM_CATALOG),
    ).map(plain).join("\n");

    expect(lines).toContain("运行设置");
    expect(lines).toContain("角色模型");
    expect(lines).toContain("本次额度");
    expect(lines).toContain("开发");
    expect(lines).not.toMatch(/\bhd(?:t)?_/u);
  });
});
