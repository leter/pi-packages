import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HerdrAdapter } from "../../src/herdr/adapter.js";
import { hasDeliveryEcho } from "../../src/herdr/delivery.js";
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

function snapshot(status = "idle"): Record<string, unknown> {
  const pane = { ...targetPane, agent_status: status };
  return {
    version: "0.7.3",
    protocol: 16,
    focused_workspace_id: "w-current",
    workspaces: [{ workspace_id: "w-current", number: 1, label: "Current", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "t-current", agent_status: status }],
    tabs: [],
    panes: [pane],
    layouts: [],
    agents: [{ ...pane, name: "pi", screen_detection_skipped: true }],
  };
}

function read(text: string, truncated: boolean): Record<string, unknown> {
  return {
    pane_id: "p-target",
    workspace_id: "w-current",
    tab_id: "t-current",
    source: "recent_unwrapped",
    format: "text",
    text,
    revision: 9,
    truncated,
  };
}

async function fakeServer(
  handler: ConstructorParameters<typeof FakeHerdrServer>[1],
): Promise<FakeHerdrServer> {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-delivery-"));
  roots.push(root);
  const instance = new FakeHerdrServer(join(root, "herdr.sock"), handler);
  servers.push(instance);
  await instance.start();
  return instance;
}

const delivery = {
  target: {
    terminalId: "term-target",
    expectedAgent: "pi",
    expectedCwd: "/repo/worktree",
  },
  correlationId: "hd_echo_1",
  text: "[HERDR DISPATCH]\nID: hd_echo_1\nDo the work",
};

describe("Herdr atomic delivery and bounded reads", () => {
  it("uses one send_input request with text and enter, then verifies an exact bounded echo", async () => {
    const fake = await fakeServer((request, connection) => {
      if (request.method === "session.snapshot") {
        connection.sendResponse(request.id, { type: "session_snapshot", snapshot: snapshot() });
      } else if (request.method === "pane.get") {
        connection.sendResponse(request.id, { type: "pane_info", pane: targetPane });
      } else if (request.method === "pane.send_input") {
        expect(request.params).toEqual({
          pane_id: "p-target",
          text: delivery.text,
          keys: ["enter"],
        });
        connection.sendResponse(request.id, { type: "ok" });
      } else if (request.method === "pane.read") {
        expect(request.params).toEqual({
          pane_id: "p-target",
          source: "recent_unwrapped",
          lines: 200,
          format: "text",
          strip_ansi: true,
        });
        connection.sendResponse(request.id, {
          type: "pane_read",
          read: read(`prompt\n${delivery.text}\n`, true),
        });
      }
    });
    const adapter = await HerdrAdapter.connect({ socketPath: fake.socketPath, workspaceId: "w-current" });

    await expect(adapter.deliverAndVerify(delivery)).resolves.toEqual(
      expect.objectContaining({ status: "verified", pane: expect.objectContaining({ paneId: "p-target" }) }),
    );
    expect(fake.requests.filter((request) => request.method === "pane.send_input")).toHaveLength(1);
    expect(fake.connectionCount).toBe(7);
    expect(fake.requests.every((request) => request.id === "pi-herdr-1")).toBe(true);
    adapter.close();
  });

  it("does not trust truncated:false as proof that a missing echo means non-delivery", async () => {
    const fake = await fakeServer((request, connection) => {
      if (request.method === "session.snapshot") connection.sendResponse(request.id, { type: "session_snapshot", snapshot: snapshot() });
      else if (request.method === "pane.get") connection.sendResponse(request.id, { type: "pane_info", pane: targetPane });
      else if (request.method === "pane.send_input") connection.sendResponse(request.id, { type: "ok" });
      else if (request.method === "pane.read") connection.sendResponse(request.id, { type: "pane_read", read: read("ordinary output", false) });
    });
    const adapter = await HerdrAdapter.connect({ socketPath: fake.socketPath, workspaceId: "w-current" });

    await expect(adapter.deliverAndVerify(delivery)).resolves.toEqual(
      expect.objectContaining({ status: "ambiguous", reason: "echo-not-found" }),
    );
    adapter.close();
  });

  it("returns typed ambiguity after a request-boundary disconnect and never resends", async () => {
    const fake = await fakeServer((request, connection) => {
      if (request.method === "session.snapshot") connection.sendResponse(request.id, { type: "session_snapshot", snapshot: snapshot() });
      else if (request.method === "pane.get") connection.sendResponse(request.id, { type: "pane_info", pane: targetPane });
      else if (request.method === "pane.send_input") connection.disconnect();
    });
    const adapter = await HerdrAdapter.connect({ socketPath: fake.socketPath, workspaceId: "w-current" });

    await expect(adapter.deliverAndVerify(delivery)).resolves.toEqual(
      expect.objectContaining({ status: "ambiguous", reason: "response-unknown" }),
    );
    expect(fake.requests.filter((request) => request.method === "pane.send_input")).toHaveLength(1);
    adapter.close();
  });

  it("fails before send when identity, cwd, agent, or idle-like state no longer matches", async () => {
    const fake = await fakeServer((request, connection) => {
      if (request.method === "session.snapshot") connection.sendResponse(request.id, { type: "session_snapshot", snapshot: snapshot("working") });
      else if (request.method === "pane.get") connection.sendResponse(request.id, { type: "pane_info", pane: { ...targetPane, agent_status: "working" } });
    });
    const adapter = await HerdrAdapter.connect({ socketPath: fake.socketPath, workspaceId: "w-current" });

    await expect(adapter.deliverAndVerify(delivery)).resolves.toEqual({
      status: "not-sent",
      reason: "target-not-idle",
    });
    expect(fake.requests.some((request) => request.method === "pane.send_input")).toBe(false);
    adapter.close();
  });

  it("aborts before socket write when close or move invalidates the freshly resolved route", async () => {
    let stream: FakeHerdrConnection | undefined;
    const fake = await fakeServer((request, connection) => {
      if (request.method === "session.snapshot") {
        connection.sendResponse(request.id, { type: "session_snapshot", snapshot: snapshot() });
      } else if (request.method === "events.subscribe") {
        stream = connection;
        connection.startSubscription(request.id);
      } else if (request.method === "pane.get") {
        stream?.sendEvent("pane_closed", {
          type: "pane_closed",
          pane_id: "p-target",
          workspace_id: "w-current",
        });
        setTimeout(
          () => connection.sendResponse(request.id, { type: "pane_info", pane: targetPane }),
          5,
        );
      }
    });
    const adapter = await HerdrAdapter.connect({ socketPath: fake.socketPath, workspaceId: "w-current" });
    await adapter.monitorTargets([{ paneId: "p-target", correlationId: "hd_echo_1" }], () => undefined);

    await expect(adapter.deliverAndVerify(delivery)).resolves.toEqual(
      expect.objectContaining({ status: "not-sent", reason: "target-changed" }),
    );
    expect(fake.requests.some((request) => request.method === "pane.send_input")).toBe(false);
    adapter.close();
  });

  it("permits only 50 or 200-line recent_unwrapped reads", async () => {
    const fake = await fakeServer((request, connection) => {
      if (request.method === "session.snapshot") connection.sendResponse(request.id, { type: "session_snapshot", snapshot: snapshot() });
      else if (request.method === "pane.read") connection.sendResponse(request.id, { type: "pane_read", read: read("tail", false) });
    });
    const adapter = await HerdrAdapter.connect({ socketPath: fake.socketPath, workspaceId: "w-current" });

    await expect(adapter.readTail("p-target", 50)).resolves.toEqual(expect.objectContaining({ text: "tail" }));
    await expect(adapter.readTail("p-target", 200)).resolves.toEqual(expect.objectContaining({ text: "tail" }));
    await expect(adapter.readTail("p-target", 51 as 50)).rejects.toThrow(RangeError);
    expect(fake.requests.filter((request) => request.method === "pane.read").map((request) => request.params)).toEqual([
      expect.objectContaining({ lines: 50 }),
      expect.objectContaining({ lines: 200 }),
    ]);
    adapter.close();
  });
});

describe("hasDeliveryEcho", () => {
  it("requires both the exact dispatch header and correlation ID", () => {
    expect(hasDeliveryEcho("[HERDR DISPATCH]\nID: hd_1", "hd_1")).toBe(true);
    expect(hasDeliveryEcho("[HERDR DISPATCH]", "hd_1")).toBe(false);
    expect(hasDeliveryEcho("ID: hd_1", "hd_1")).toBe(false);
    expect(hasDeliveryEcho("[HERDR DISPATCH]\nID: hd_other", "hd_1")).toBe(false);
    expect(hasDeliveryEcho("[HERDR DISPATCH]\nID: hd_10", "hd_1")).toBe(false);
  });
});
