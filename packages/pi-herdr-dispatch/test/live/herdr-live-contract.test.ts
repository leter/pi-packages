import { describe, expect, it } from "vitest";

import { AgentLaunchService } from "../../src/dispatch/agent-launch.js";
import { HerdrAdapter } from "../../src/herdr/adapter.js";
import { HerdrUnaryTransport } from "../../src/herdr/socket-client.js";

const liveEnabled = process.env.HERDR_LIVE_CONTRACT === "1";
const liveDescribe = liveEnabled ? describe : describe.skip;

liveDescribe("Herdr 0.7.3 live contract", () => {
  it("uses one connection per unary request and an exclusive subscription stream", async () => {
    const socketPath = requiredEnvironment("HERDR_SOCKET_PATH");
    const workspaceId = requiredEnvironment("HERDR_TEST_WORKSPACE_ID");
    const adapter = await HerdrAdapter.connect({ socketPath, workspaceId });
    try {
      // connect() and this call are separate unary socket connections. The installed
      // server closes each after one response, so this is also a transport contract check.
      const current = await adapter.currentWorkspaceSnapshot();
      expect(current.protocol).toBe(16);
      expect(current.workspace.workspaceId).toBe(workspaceId);
      const pane = current.panes[0];
      if (!pane) throw new Error("HERDR_TEST_WORKSPACE_ID must contain at least one pane");

      const resolved = await adapter.resolveTerminal(pane.terminalId);
      expect(resolved?.pane.terminalId).toBe(pane.terminalId);
      const tail = await adapter.readTail(resolved!.pane.paneId, 50);
      expect(tail.workspaceId).toBe(workspaceId);

      await adapter.monitorTargets(
        [{ paneId: resolved!.pane.paneId, correlationId: "hd_live_contract_never_sent" }],
        () => undefined,
      );
    } finally {
      adapter.close();
    }
  });

  it(
    "creates a no-focus Agent in a disposable workspace and resolves its exact terminal identity",
    async () => {
      const socketPath = requiredEnvironment("HERDR_SOCKET_PATH");
      let workspaceId: string | undefined;
      let adapter: HerdrAdapter | undefined;
      try {
        const setup = new HerdrUnaryTransport(socketPath);
        let created: Record<string, unknown>;
        try {
          created = await setup.request(
            "workspace.create",
            {
              cwd: process.cwd(),
              label: "pi-herdr live Agent Launch",
              focus: false,
              env: {},
            },
            "workspace_created",
          );
          workspaceId = optionalNestedString(created.workspace, "workspace_id");
        } finally {
          setup.close();
        }
        const workspace = object(created.workspace, "created workspace");
        const rootPane = object(created.root_pane, "created root pane");
        workspaceId = string(workspace.workspace_id, "created workspace id");
        const originPaneId = string(rootPane.pane_id, "created root pane id");
        adapter = await HerdrAdapter.connect({ socketPath, workspaceId });
        const launcher = new AgentLaunchService({
          herdr: adapter,
          workspaceId,
          originPaneId,
          startupTimeoutMs: 60_000,
        });
        const target = await launcher.launch({
          agentType: "pi",
          layout: "adaptive",
          cwd: process.cwd(),
          label: "pi · live Agent Launch",
        });

        expect(target.workspaceId).toBe(workspaceId);
        expect(target.terminalId).not.toBe(string(rootPane.terminal_id, "root terminal id"));
        expect(target.agentLabel).toBe("pi");
        expect(target.status).toMatch(/^(idle|done)$/u);

        const correlationId = `hd_live_launch_${Date.now().toString(36)}`;
        await expect(
          adapter.deliverAndVerify(
            {
              target: {
                terminalId: target.terminalId,
                expectedAgent: "pi",
                expectedCwd: process.cwd(),
                allowedStatuses: ["idle", "done"],
              },
              correlationId,
              text: `[HERDR DISPATCH]\nID: ${correlationId}\nMode: non-mutating\n\nTask:\nReply briefly without modifying files.`,
            },
            { echoWindowMs: 5_000, echoPollMs: 100 },
          ),
        ).resolves.toMatchObject({ status: "verified" });

        const tabTarget = await launcher.launch({
          agentType: "pi",
          layout: "new-tab",
          cwd: process.cwd(),
          label: "pi · live new-tab Launch",
        });
        expect(tabTarget.workspaceId).toBe(workspaceId);
        const resolvedTabTarget = await adapter.resolveTerminal(tabTarget.terminalId);
        expect(resolvedTabTarget?.pane.tabId).not.toBe(string(rootPane.tab_id, "root tab id"));
        expect(tabTarget.agentLabel).toBe("pi");

        for (const agentType of ["amp", "droid", "grok"] as const) {
          const detectedTarget = await launcher.launch({
            agentType,
            layout: "new-tab",
            cwd: process.cwd(),
            label: `${agentType} · live screen detection`,
          });
          expect(detectedTarget).toMatchObject({
            workspaceId,
            agentLabel: agentType,
            status: expect.stringMatching(/^(idle|done)$/u),
            statusProvenance: expect.stringMatching(/^(reported|screen-detected)$/u),
          });
        }
      } finally {
        adapter?.close();
        if (workspaceId) {
          const cleanup = new HerdrUnaryTransport(socketPath);
          try {
            await cleanup.request("workspace.close", { workspace_id: workspaceId }, "ok");
          } finally {
            cleanup.close();
          }
        }
      }
    },
    120_000,
  );
});

function optionalNestedString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "string" ? nested : undefined;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when HERDR_LIVE_CONTRACT=1`);
  return value;
}
