import { describe, expect, it } from "vitest";

import { HerdrAdapter } from "../../src/herdr/adapter.js";

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
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when HERDR_LIVE_CONTRACT=1`);
  return value;
}
