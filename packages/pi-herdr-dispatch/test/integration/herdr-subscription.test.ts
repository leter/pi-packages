import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HerdrAdapter } from "../../src/herdr/adapter.js";
import type { FakeHerdrConnection } from "../support/fake-herdr-server.js";
import { FakeHerdrServer } from "../support/fake-herdr-server.js";

const roots: string[] = [];
const servers: FakeHerdrServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const targetPane = {
  pane_id: "p-target",
  terminal_id: "term-target",
  workspace_id: "w-current",
  tab_id: "t-current",
  focused: false,
  agent_status: "idle",
  revision: 1,
  agent: "pi",
  cwd: "/repo/worktree",
};

function snapshot(): Record<string, unknown> {
  return {
    version: "0.7.3",
    protocol: 16,
    focused_workspace_id: "w-current",
    workspaces: [{ workspace_id: "w-current", number: 1, label: "Current", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "t-current", agent_status: "idle" }],
    tabs: [],
    panes: [targetPane],
    layouts: [],
    agents: [{ ...targetPane, name: "pi", screen_detection_skipped: true }],
  };
}

function paneRead(): Record<string, unknown> {
  return {
    pane_id: "p-target",
    workspace_id: "w-current",
    tab_id: "t-current",
    source: "recent_unwrapped",
    format: "text",
    text: "[HERDR DISPATCH]\nID: hd_1",
    revision: 4,
    truncated: false,
  };
}

async function fakeServer(
  handler: ConstructorParameters<typeof FakeHerdrServer>[1],
): Promise<FakeHerdrServer> {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-subscription-"));
  roots.push(root);
  const instance = new FakeHerdrServer(join(root, "herdr.sock"), handler);
  servers.push(instance);
  await instance.start();
  return instance;
}

async function waitFor(check: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for fake Herdr event");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Herdr subscription stream", () => {
  it("uses one exclusive stream for close, move, status, and bounded output-match events", async () => {
    const listener = vi.fn();
    const fake = await fakeServer((request, connection) => {
      if (request.method === "session.snapshot") {
        connection.sendResponse(request.id, { type: "session_snapshot", snapshot: snapshot() });
        return;
      }
      expect(request.method).toBe("events.subscribe");
      expect(request.params).toEqual({
        subscriptions: [
          { type: "pane.closed" },
          { type: "pane.moved" },
          { type: "pane.agent_status_changed", pane_id: "p-target" },
          {
            type: "pane.output_matched",
            pane_id: "p-target",
            source: "recent_unwrapped",
            lines: 200,
            strip_ansi: true,
            match: { type: "substring", value: "hd_1" },
          },
        ],
      });
      connection.startSubscription(request.id);
      setImmediate(() => {
        connection.sendEvent("pane_agent_status_changed", {
          type: "pane_agent_status_changed",
          pane_id: "p-target",
          workspace_id: "w-current",
          agent_status: "working",
        });
        connection.sendEvent("pane.output_matched", {
          pane_id: "p-target",
          matched_line: "ID: hd_1",
          read: paneRead(),
        });
        connection.sendEvent("pane_moved", {
          type: "pane_moved",
          previous_pane_id: "p-old",
          previous_workspace_id: "w-current",
          previous_tab_id: "t-current",
          pane: { ...targetPane, pane_id: "p-target", revision: 5 },
        });
        connection.sendEvent("pane_closed", {
          type: "pane_closed",
          pane_id: "p-closed",
          workspace_id: "w-current",
        });
        connection.sendEvent("pane_closed", {
          type: "pane_closed",
          pane_id: "p-foreign",
          workspace_id: "w-foreign",
        });
      });
    });
    const adapter = await HerdrAdapter.connect({ socketPath: fake.socketPath, workspaceId: "w-current" });

    await adapter.monitorTargets([{ paneId: "p-target", correlationId: "hd_1" }], listener);
    await waitFor(() => listener.mock.calls.length === 4);
    expect(listener.mock.calls.map(([event]) => event.type)).toEqual([
      "agent-status-changed",
      "output-matched",
      "pane-moved",
      "pane-closed",
    ]);
    expect(fake.connectionCount).toBe(2); // one unary snapshot plus one exclusive stream
    expect(fake.requests.some((request) => request.method === "pane.report_metadata")).toBe(false);
    adapter.close();
  });

  it("reconnects with bounded backoff and restores the exact subscription set", async () => {
    let streamCount = 0;
    const fake = await fakeServer((request, connection) => {
      if (request.method === "session.snapshot") {
        connection.sendResponse(request.id, { type: "session_snapshot", snapshot: snapshot() });
        return;
      }
      streamCount += 1;
      connection.startSubscription(request.id);
      if (streamCount === 1) setImmediate(() => connection.disconnect());
    });
    const adapter = await HerdrAdapter.connect({
      socketPath: fake.socketPath,
      workspaceId: "w-current",
      reconnectMinMs: 5,
      reconnectMaxMs: 20,
    });

    await adapter.monitorTargets([{ paneId: "p-target", correlationId: "hd_1" }], () => undefined);
    await waitFor(() => streamCount === 2);
    const subscriptions = fake.requests.filter((request) => request.method === "events.subscribe");
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[1]?.params).toEqual(subscriptions[0]?.params);
    adapter.close();
  });

  it("coalesces explicit reconnects and replaces rather than duplicates the long stream", async () => {
    const streams: FakeHerdrConnection[] = [];
    const fake = await fakeServer((request, connection) => {
      if (request.method === "session.snapshot") {
        connection.sendResponse(request.id, { type: "session_snapshot", snapshot: snapshot() });
      } else {
        streams.push(connection);
        connection.startSubscription(request.id);
      }
    });
    const adapter = await HerdrAdapter.connect({ socketPath: fake.socketPath, workspaceId: "w-current" });
    await adapter.monitorTargets([{ paneId: "p-target", correlationId: "hd_1" }], () => undefined);

    await Promise.all([adapter.reconnect(), adapter.reconnect(), adapter.reconnect()]);
    expect(fake.requests.filter((request) => request.method === "session.snapshot")).toHaveLength(2);
    expect(fake.requests.filter((request) => request.method === "events.subscribe")).toHaveLength(2);
    expect(streams).toHaveLength(2);
    adapter.close();
  });
});
