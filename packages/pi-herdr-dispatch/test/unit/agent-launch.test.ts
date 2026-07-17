import { describe, expect, it, vi } from "vitest";

import {
  adaptiveSplitDirection,
  AgentLaunchCancelledError,
  AgentLaunchService,
  AgentLaunchTimeoutError,
  nextReadonlyAgentLabel,
  hasReportedProvenance,
  type HerdrAgentLaunchPort,
} from "../../src/dispatch/agent-launch.js";
import type { CurrentWorkspaceSnapshot } from "../../src/herdr/adapter.js";
import type { HerdrPane } from "../../src/herdr/protocol.js";

const createdPane: HerdrPane = {
  paneId: "p-created",
  terminalId: "term-created",
  workspaceId: "w-current",
  tabId: "t-current",
  focused: false,
  agentStatus: "unknown",
  revision: 1,
  cwd: "/repo",
};

function snapshot(withAgent = true): CurrentWorkspaceSnapshot {
  return {
    workspace: { workspaceId: "w-current", label: "Current", focused: true },
    panes: [createdPane],
    agents: withAgent
      ? [
          {
            ...createdPane,
            agent: "claude",
            name: "claude",
            agentStatus: "idle",
            screenDetectionSkipped: true,
          },
        ]
      : [],
    serverVersion: "0.7.3",
    protocol: 16,
  };
}

function port(currentSnapshot = snapshot()): HerdrAgentLaunchPort {
  return {
    paneLayout: vi.fn(async () => ({
      workspaceId: "w-current",
      tabId: "t-current",
      panes: [{ paneId: "p-origin", focused: true, rect: { x: 0, y: 0, width: 84, height: 72 } }],
    })),
    createSplitPane: vi.fn(async () => createdPane),
    createTab: vi.fn(async () => ({
      tabId: "t-created",
      workspaceId: "w-current",
      focused: false,
      rootPane: { ...createdPane, tabId: "t-created" },
    })),
    renamePane: vi.fn(async () => undefined),
    startAgentExecutable: vi.fn(async () => undefined),
    currentWorkspaceSnapshot: vi.fn(async () => currentSnapshot),
  };
}

function service(herdr: HerdrAgentLaunchPort, overrides: Partial<ConstructorParameters<typeof AgentLaunchService>[0]> = {}) {
  return new AgentLaunchService({
    herdr,
    workspaceId: "w-current",
    originPaneId: "p-origin",
    startupTimeoutMs: 5_000,
    ...overrides,
  });
}

describe("AgentLaunchService", () => {
  it("uses the origin pane geometry for adaptive 50/50 splitting and returns the exact Eligible Agent", async () => {
    const herdr = port();
    const launcher = service(herdr);

    await expect(
      launcher.launch({
        agentType: "claude",
        layout: "adaptive",
        cwd: "/repo",
        label: "claude · 修复测试",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        terminalId: "term-created",
        paneId: "p-created",
        workspaceId: "w-current",
        agentLabel: "claude",
        status: "idle",
        statusProvenance: "reported",
      }),
    );

    expect(herdr.createSplitPane).toHaveBeenCalledWith({
      targetPaneId: "p-origin",
      direction: "down",
      cwd: "/repo",
      ratio: 0.5,
    });
    expect(herdr.renamePane).toHaveBeenCalledWith("p-created", "claude · 修复测试");
    expect(herdr.startAgentExecutable).toHaveBeenCalledWith("p-created", "claude");
  });

  it("creates a no-focus tab root instead of splitting for new-tab layout", async () => {
    const herdr = port({
      ...snapshot(),
      panes: [{ ...createdPane, tabId: "t-created" }],
      agents: [{ ...snapshot().agents[0]!, tabId: "t-created" }],
    });
    const launcher = service(herdr);

    await launcher.launch({
      agentType: "claude",
      layout: "new-tab",
      cwd: "/repo",
      label: "claude · 修复测试",
    });

    expect(herdr.createTab).toHaveBeenCalledWith({ cwd: "/repo", label: "claude · 修复测试" });
    expect(herdr.createSplitPane).not.toHaveBeenCalled();
  });

  it("waits for reported integration provenance instead of accepting screen detection", async () => {
    const screenDetected = snapshot();
    screenDetected.agents[0]!.screenDetectionSkipped = false;
    const herdr = port();
    vi.mocked(herdr.currentWorkspaceSnapshot)
      .mockResolvedValueOnce(screenDetected)
      .mockResolvedValueOnce(snapshot());
    const launcher = service(herdr, { sleep: async () => undefined });

    await expect(
      launcher.launch({ agentType: "claude", layout: "right", cwd: "/repo", label: "claude · task" }),
    ).resolves.toMatchObject({ statusProvenance: "reported" });
    expect(herdr.currentWorkspaceSnapshot).toHaveBeenCalledTimes(2);
  });

  it.each(["claude", "codex"] as const)(
    "accepts %s readiness from an exact agent-session record",
    async (agentType) => {
      const integrated = snapshot();
      integrated.agents[0]!.agent = agentType;
      integrated.agents[0]!.name = agentType;
      integrated.agents[0]!.screenDetectionSkipped = false;
      integrated.agents[0]!.agentSession = {
        source: `herdr:${agentType}`,
        kind: "session",
        value: `${agentType}-session-1`,
      };
      const herdr = port(integrated);
      const launcher = service(herdr);

      await expect(
        launcher.launch({
          agentType,
          layout: "right",
          cwd: "/repo",
          label: `${agentType} · task`,
        }),
      ).resolves.toMatchObject({
        agentLabel: agentType,
        statusProvenance: "reported",
      });
      expect(herdr.currentWorkspaceSnapshot).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["codex", "amp", "droid", "grok"] as const)(
    "accepts reviewed screen-detected readiness for %s",
    async (agentType) => {
      const detected = snapshot();
      detected.agents[0]!.agent = agentType;
      detected.agents[0]!.name = agentType;
      detected.agents[0]!.screenDetectionSkipped = false;
      const herdr = port(detected);
      const launcher = service(herdr);

      await expect(
        launcher.launch({ agentType, layout: "right", cwd: "/repo", label: `${agentType} · task` }),
      ).resolves.toMatchObject({
        agentLabel: agentType,
        statusProvenance: "screen-detected",
      });
    },
  );

  it("times out without closing the created pane", async () => {
    let now = 0;
    const herdr = port(snapshot(false));
    const launcher = service(herdr, {
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });

    await expect(
      launcher.launch({ agentType: "claude", layout: "right", cwd: "/repo", label: "claude · task" }),
    ).rejects.toMatchObject({
      name: "AgentLaunchTimeoutError",
      createdPane: expect.objectContaining({ paneId: "p-created" }),
    } satisfies Partial<AgentLaunchTimeoutError>);
  });

  it.each(["create", "rename", "start"] as const)(
    "stops after %s when cancellation arrives between launch steps",
    async (stage) => {
      const controller = new AbortController();
      const herdr = port();
      if (stage === "create") {
        vi.mocked(herdr.createSplitPane).mockImplementationOnce(async () => {
          controller.abort();
          return createdPane;
        });
      } else if (stage === "rename") {
        vi.mocked(herdr.renamePane).mockImplementationOnce(async () => {
          controller.abort();
        });
      } else {
        vi.mocked(herdr.startAgentExecutable).mockImplementationOnce(async () => {
          controller.abort();
        });
      }
      const launcher = service(herdr);

      await expect(
        launcher.launch({
          agentType: "claude",
          layout: "right",
          cwd: "/repo",
          label: "claude · task",
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({
        name: "AgentLaunchCancelledError",
        createdPane: expect.objectContaining({ paneId: "p-created", tabId: "t-current" }),
      });

      if (stage === "create") expect(herdr.renamePane).not.toHaveBeenCalled();
      if (stage !== "start") expect(herdr.startAgentExecutable).not.toHaveBeenCalled();
      expect(herdr.currentWorkspaceSnapshot).not.toHaveBeenCalled();
    },
  );

  it("enforces the startup deadline after a slow snapshot returns ready", async () => {
    let now = 0;
    const herdr = port();
    vi.mocked(herdr.currentWorkspaceSnapshot).mockImplementationOnce(async () => {
      now = 5_000;
      return snapshot();
    });
    const launcher = service(herdr, { now: () => now });

    await expect(
      launcher.launch({ agentType: "claude", layout: "right", cwd: "/repo", label: "claude · task" }),
    ).rejects.toBeInstanceOf(AgentLaunchTimeoutError);
  });

  it("allows the startup wait to be cancelled while retaining created-pane evidence", async () => {
    const controller = new AbortController();
    const herdr = port(snapshot(false));
    const launcher = service(herdr, {
      sleep: async () => {
        controller.abort();
      },
    });

    await expect(
      launcher.launch({
        agentType: "claude",
        layout: "right",
        cwd: "/repo",
        label: "claude · task",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      name: "AgentLaunchCancelledError",
      createdPane: expect.objectContaining({ paneId: "p-created" }),
    } satisfies Partial<AgentLaunchCancelledError>);
  });
});

describe("read-only Agent pane naming", () => {
  it("uses the first sequence number when no matching pane exists", () => {
    expect(nextReadonlyAgentLabel("reviewer", [])).toBe("reviewer-auto-1");
  });

  it("uses one plus the number of current-workspace labels with the role prefix", () => {
    expect(nextReadonlyAgentLabel("reviewer", [
      "reviewer-auto-1",
      "reviewer-auto-custom",
      "researcher-auto-1",
    ])).toBe("reviewer-auto-3");
  });

  it("moves past a user-created pane that collides with the generated name", () => {
    expect(nextReadonlyAgentLabel("reviewer", ["reviewer-auto-1"])).toBe(
      "reviewer-auto-2",
    );
  });
});

describe("adaptiveSplitDirection", () => {
  it.each([
    [{ width: 239, height: 72 }, "right"],
    [{ width: 144, height: 72 }, "right"],
    [{ width: 84, height: 72 }, "down"],
  ] as const)("maps %j to %s", (rect, expected) => {
    expect(adaptiveSplitDirection(rect)).toBe(expected);
  });
});

describe("hasReportedProvenance", () => {
  it("accepts either positive integration-authority signal", () => {
    expect(
      hasReportedProvenance({ screenDetectionSkipped: true }, "claude"),
    ).toBe(true);
    expect(
      hasReportedProvenance(
        {
          screenDetectionSkipped: false,
          agentSession: { source: "herdr:claude", kind: "session", value: "session-1" },
        },
        "claude",
      ),
    ).toBe(true);
  });

  it("fails closed without exact reported-provenance evidence", () => {
    expect(hasReportedProvenance({ screenDetectionSkipped: false }, "claude")).toBe(false);
    expect(
      hasReportedProvenance(
        { screenDetectionSkipped: false, agentSession: { kind: "session", value: "session-1" } },
        "claude",
      ),
    ).toBe(false);
    expect(
      hasReportedProvenance(
        {
          screenDetectionSkipped: false,
          agentSession: { source: "herdr:codex", kind: "session", value: "session-1" },
        },
        "claude",
      ),
    ).toBe(false);
  });
});
