import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HerdrAdapter, HerdrTargetLostError } from "../../src/herdr/adapter.js";
import { HerdrProtocolError } from "../../src/herdr/socket-client.js";
import { FakeHerdrServer } from "../support/fake-herdr-server.js";

const roots: string[] = [];
const servers: FakeHerdrServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function pane(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pane_id: "p-target",
    terminal_id: "term-target",
    workspace_id: "w-current",
    tab_id: "t-current",
    focused: false,
    agent_status: "idle",
    revision: 4,
    agent: "pi",
    cwd: "/repo/worktree",
    ...overrides,
  };
}

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const target = pane();
  return {
    version: "0.7.3",
    protocol: 16,
    focused_workspace_id: "w-current",
    focused_tab_id: "t-current",
    focused_pane_id: "p-origin",
    workspaces: [
      { workspace_id: "w-current", number: 1, label: "Current", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "t-current", agent_status: "idle" },
      { workspace_id: "w-foreign", number: 2, label: "Foreign", focused: false, pane_count: 1, tab_count: 1, active_tab_id: "t-foreign", agent_status: "working" },
    ],
    tabs: [],
    panes: [target, pane({ pane_id: "p-foreign", terminal_id: "term-foreign", workspace_id: "w-foreign", tab_id: "t-foreign" })],
    layouts: [],
    agents: [
      { ...target, name: "pi", screen_detection_skipped: true },
      { ...pane({ pane_id: "p-foreign", terminal_id: "term-foreign", workspace_id: "w-foreign", tab_id: "t-foreign" }), name: "pi", screen_detection_skipped: false },
    ],
    ...overrides,
  };
}

async function fakeServer(
  handler: ConstructorParameters<typeof FakeHerdrServer>[1],
): Promise<FakeHerdrServer> {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-adapter-"));
  roots.push(root);
  const instance = new FakeHerdrServer(join(root, "herdr.sock"), handler);
  servers.push(instance);
  await instance.start();
  return instance;
}

describe("HerdrAdapter discovery and routing", () => {
  it("validates protocol 16 and exposes only the captured current workspace", async () => {
    const fake = await fakeServer((request, connection) =>
      connection.sendResponse(request.id, { type: "session_snapshot", snapshot: snapshot() }),
    );
    const adapter = await HerdrAdapter.connect({ socketPath: fake.socketPath, workspaceId: "w-current" });

    const current = await adapter.currentWorkspaceSnapshot();
    expect(current.workspace.workspaceId).toBe("w-current");
    expect(current.panes.map((item) => item.paneId)).toEqual(["p-target"]);
    expect(current.agents).toEqual([
      expect.objectContaining({ terminalId: "term-target", screenDetectionSkipped: true }),
    ]);
    expect(JSON.stringify(current)).not.toContain("w-foreign");
    adapter.close();
  });

  it("rejects incompatible snapshots instead of degrading protocol validation", async () => {
    const fake = await fakeServer((request, connection) =>
      connection.sendResponse(request.id, {
        type: "session_snapshot",
        snapshot: snapshot({ protocol: 17 }),
      }),
    );

    await expect(
      HerdrAdapter.connect({ socketPath: fake.socketPath, workspaceId: "w-current" }),
    ).rejects.toBeInstanceOf(HerdrProtocolError);
  });

  it("re-resolves terminal identity immediately before use through consecutive unary requests", async () => {
    const fake = await fakeServer((request, connection) => {
      if (request.method === "session.snapshot") {
        connection.sendResponse(request.id, { type: "session_snapshot", snapshot: snapshot() });
      } else if (request.method === "pane.get") {
        expect(request.params).toEqual({ pane_id: "p-target" });
        connection.sendResponse(request.id, { type: "pane_info", pane: pane() });
      }
    });
    const adapter = await HerdrAdapter.connect({ socketPath: fake.socketPath, workspaceId: "w-current" });

    await expect(adapter.resolveTerminal("term-target")).resolves.toEqual(
      expect.objectContaining({
        pane: expect.objectContaining({ paneId: "p-target", terminalId: "term-target" }),
        agent: expect.objectContaining({ screenDetectionSkipped: true }),
      }),
    );
    expect(fake.connectionCount).toBe(3);
    adapter.close();
  });

  it("treats missing or duplicate terminal identities as target loss, never heuristic retargeting", async () => {
    let duplicate = false;
    const fake = await fakeServer((request, connection) => {
      const base = snapshot();
      const value = duplicate
        ? { ...base, panes: [pane(), pane({ pane_id: "p-other" })] }
        : base;
      connection.sendResponse(request.id, { type: "session_snapshot", snapshot: value });
    });
    const adapter = await HerdrAdapter.connect({ socketPath: fake.socketPath, workspaceId: "w-current" });

    await expect(adapter.resolveTerminal("term-missing")).resolves.toBeUndefined();
    duplicate = true;
    await expect(adapter.resolveTerminal("term-target")).rejects.toBeInstanceOf(HerdrTargetLostError);
    adapter.close();
  });

  it("posts notifications through unary protocol requests without pane metadata", async () => {
    const fake = await fakeServer((request, connection) => {
      if (request.method === "session.snapshot") {
        connection.sendResponse(request.id, { type: "session_snapshot", snapshot: snapshot() });
      } else {
        expect(request).toEqual({
          id: "pi-herdr-1",
          method: "notification.show",
          params: { title: "Dispatch blocked", body: "Inspect hd_1", sound: "request" },
        });
        connection.sendResponse(request.id, {
          type: "notification_show",
          shown: true,
          reason: "shown",
        });
      }
    });
    const adapter = await HerdrAdapter.connect({ socketPath: fake.socketPath, workspaceId: "w-current" });

    await expect(
      adapter.showNotification({
        title: "Dispatch blocked",
        body: "Inspect hd_1",
        sound: "request",
      }),
    ).resolves.toEqual({ shown: true, reason: "shown" });
    expect(fake.requests.every((request) => request.method !== "pane.report_metadata")).toBe(true);
    adapter.close();
  });

  it("coalesces concurrent reconnect requests into one fresh connection and revalidates protocol", async () => {
    const fake = await fakeServer((request, connection) =>
      connection.sendResponse(request.id, { type: "session_snapshot", snapshot: snapshot() }),
    );
    const adapter = await HerdrAdapter.connect({ socketPath: fake.socketPath, workspaceId: "w-current" });

    await Promise.all([adapter.reconnect(), adapter.reconnect(), adapter.reconnect()]);
    expect(fake.connectionCount).toBe(2);
    adapter.close();
  });
});
