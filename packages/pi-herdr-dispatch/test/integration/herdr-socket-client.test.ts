import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HerdrApiError,
  HerdrDisconnectedError,
  HerdrProtocolError,
  HerdrSocketClient,
} from "../../src/herdr/socket-client.js";
import { FakeHerdrServer } from "../support/fake-herdr-server.js";

const roots: string[] = [];
const servers: FakeHerdrServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function server(
  handler: ConstructorParameters<typeof FakeHerdrServer>[1],
): Promise<FakeHerdrServer> {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-socket-"));
  roots.push(root);
  const instance = new FakeHerdrServer(join(root, "herdr.sock"), handler);
  servers.push(instance);
  await instance.start();
  return instance;
}

describe("HerdrSocketClient", () => {
  it("speaks newline-delimited Herdr envelopes across arbitrary byte chunks", async () => {
    const fake = await server((request, connection) => {
      expect(request).toEqual({ id: "pi-herdr-1", method: "ping", params: {} });
      connection.sendResponse(request.id, { type: "pong", version: "0.7.3", protocol: 16 }, 7);
    });
    const client = await HerdrSocketClient.connect(fake.socketPath);

    await expect(client.request("ping", {}, "pong")).resolves.toEqual({
      type: "pong",
      version: "0.7.3",
      protocol: 16,
    });
    await expect(client.request("ping", {}, "pong")).rejects.toBeInstanceOf(HerdrProtocolError);
    client.close();
  });

  it("validates API errors and success result discriminators", async () => {
    let count = 0;
    const fake = await server((request, connection) => {
      count += 1;
      if (count === 1) connection.sendError(request.id, "not_found", "pane not found");
      else connection.sendResponse(request.id, { type: "pane_read", read: {} });
    });
    const first = await HerdrSocketClient.connect(fake.socketPath);
    await expect(first.request("pane.get", { target: "missing" }, "pane_info")).rejects.toEqual(
      expect.objectContaining<Partial<HerdrApiError>>({ name: "HerdrApiError", code: "not_found" }),
    );

    const second = await HerdrSocketClient.connect(fake.socketPath);
    await expect(second.request("pane.get", { target: "p1" }, "pane_info")).rejects.toBeInstanceOf(
      HerdrProtocolError,
    );
    expect(fake.connectionCount).toBe(2);
  });

  it("fails closed on malformed JSON instead of ignoring an invalid envelope", async () => {
    const fake = await server((_request, connection) => connection.sendRaw("{not-json}\n"));
    const client = await HerdrSocketClient.connect(fake.socketPath);

    await expect(client.request("ping", {}, "pong")).rejects.toBeInstanceOf(HerdrProtocolError);
  });

  it("marks request-boundary disconnects as submitted and therefore ambiguous", async () => {
    const fake = await server((_request, connection) => connection.disconnect());
    const client = await HerdrSocketClient.connect(fake.socketPath);

    await expect(client.request("pane.send_input", { pane_id: "p1", text: "x" }, "ok")).rejects.toEqual(
      expect.objectContaining<Partial<HerdrDisconnectedError>>({
        name: "HerdrDisconnectedError",
        submitted: true,
      }),
    );
    expect(fake.requests).toHaveLength(1);
  });

  it("marks an explicitly closed in-flight request as submitted", async () => {
    const fake = await server(() => undefined);
    const client = await HerdrSocketClient.connect(fake.socketPath);
    const pending = client.request("pane.send_input", { pane_id: "p1", text: "x" }, "ok");
    while (fake.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));

    client.close();

    await expect(pending).rejects.toEqual(
      expect.objectContaining<Partial<HerdrDisconnectedError>>({ submitted: true }),
    );
  });

  it("marks disconnects in the middle of a response frame as submitted", async () => {
    const fake = await server((request, connection) => {
      connection.sendRaw(`{"id":"${request.id}","result":`);
      setImmediate(() => connection.disconnect());
    });
    const client = await HerdrSocketClient.connect(fake.socketPath);

    await expect(client.request("pane.send_input", { pane_id: "p1", text: "x" }, "ok")).rejects.toEqual(
      expect.objectContaining<Partial<HerdrDisconnectedError>>({ submitted: true }),
    );
  });

  it("reports a failed Herdr subscription child probe as the parent API error", async () => {
    const fake = await server((request, connection) => {
      connection.sendRaw(
        `${JSON.stringify({
          id: `${request.id}:sub:2:probe`,
          error: { code: "internal_error", message: "failed to decode pane get error" },
        })}\n`,
      );
    });
    const client = await HerdrSocketClient.connect(fake.socketPath);

    await expect(
      client.request(
        "events.subscribe",
        { subscriptions: [{ type: "pane.agent_status_changed", pane_id: "p-stale" }] },
        "subscription_started",
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<HerdrApiError>>({
        name: "HerdrApiError",
        code: "internal_error",
        message: "failed to decode pane get error",
      }),
    );
    client.close();
  });

  it("delivers lifecycle and subscription event envelopes without confusing them for replies", async () => {
    const listener = vi.fn();
    const fake = await server((request, connection) => {
      connection.sendEvent("pane_moved", { type: "pane_moved", pane_id: "p2", terminal_id: "term1" });
      connection.sendEvent("pane.output_matched", {
        pane_id: "p2",
        matched_line: "[herdr-dispatch:hd_1]",
        read: { text: "echo" },
      });
      connection.sendResponse(request.id, { type: "subscription_started" });
    });
    const client = await HerdrSocketClient.connect(fake.socketPath);
    client.onEvent(listener);

    await client.request(
      "events.subscribe",
      { subscriptions: [{ type: "pane.moved" }] },
      "subscription_started",
    );
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls.map(([event]) => event.event)).toEqual([
      "pane_moved",
      "pane.output_matched",
    ]);
    client.close();
  });
});
