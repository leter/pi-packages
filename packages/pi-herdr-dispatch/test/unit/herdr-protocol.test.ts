import { describe, expect, it } from "vitest";

import {
  parsePaneInfoResult,
  parseSnapshotResult,
} from "../../src/herdr/protocol.js";
import { HerdrProtocolError } from "../../src/herdr/socket-client.js";

function pane(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pane_id: "p-target",
    terminal_id: "term-target",
    workspace_id: "w-current",
    tab_id: "t-current",
    focused: false,
    agent_status: "idle",
    revision: 1,
    agent: "claude",
    cwd: "/repo",
    ...overrides,
  };
}

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const target = pane();
  return {
    version: "0.7.4",
    protocol: 16,
    focused_workspace_id: "w-current",
    workspaces: [{ workspace_id: "w-current", label: "Current", focused: true }],
    panes: [target],
    agents: [{ ...target, name: "claude", screen_detection_skipped: false }],
    ...overrides,
  };
}

describe("Herdr agent-session protocol parsing", () => {
  it("accepts an absent agent_session", () => {
    const parsed = parseSnapshotResult({ snapshot: snapshot() });

    expect(parsed.panes[0]).not.toHaveProperty("agentSession");
    expect(parsed.agents[0]).not.toHaveProperty("agentSession");
  });

  it("exposes agent_session on snapshot pane, agent, and pane.get records", () => {
    const agentSession = {
      source: "herdr:claude",
      kind: "session",
      value: "session-1",
    };
    const target = pane({ agent_session: agentSession });
    const parsed = parseSnapshotResult({
      snapshot: snapshot({
        panes: [target],
        agents: [{ ...target, name: "claude", screen_detection_skipped: false }],
      }),
    });

    expect(parsed.panes[0]?.agentSession).toEqual(agentSession);
    expect(parsed.agents[0]?.agentSession).toEqual(agentSession);
    expect(parsePaneInfoResult({ pane: target }).agentSession).toEqual(agentSession);
  });

  it("allows a session object without source so evidence can fail closed", () => {
    const parsed = parsePaneInfoResult({
      pane: pane({ agent_session: { kind: "session", value: "session-1" } }),
    });

    expect(parsed.agentSession).toEqual({ kind: "session", value: "session-1" });
  });

  it.each([null, "herdr:claude", [], 1])(
    "rejects a present agent_session with the wrong object type: %j",
    (agentSession) => {
      expect(() =>
        parsePaneInfoResult({ pane: pane({ agent_session: agentSession }) }),
      ).toThrow(HerdrProtocolError);
    },
  );

  it("rejects wrong types in present agent_session fields", () => {
    expect(() =>
      parsePaneInfoResult({
        pane: pane({ agent_session: { source: 42, kind: "session", value: "session-1" } }),
      }),
    ).toThrow(HerdrProtocolError);
  });
});
