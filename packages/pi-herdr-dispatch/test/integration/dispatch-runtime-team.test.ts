import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DispatchRuntime } from "../../src/pi/dispatch-runtime.js";
import { RegistryRuntime } from "../../src/pi/registry-runtime.js";
import { FakeHerdrServer } from "../support/fake-herdr-server.js";

const cleanupPaths: string[] = [];
const servers: FakeHerdrServer[] = [];
const runtimes: DispatchRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.stop();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("DispatchRuntime team config", () => {
  it("emits one warning for invalid team.json without disabling plain Board Tasks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-herdr-runtime-team-"));
    cleanupPaths.push(directory);
    const teamPath = join(directory, "team.json");
    await writeFile(teamPath, "{broken", "utf8");
    const socketPath = join(directory, "herdr.sock");
    const fake = new FakeHerdrServer(socketPath, (request, connection) => {
      if (request.method !== "session.snapshot") return;
      connection.sendResponse(request.id, {
        type: "session_snapshot",
        snapshot: snapshot(),
      });
    });
    servers.push(fake);
    await fake.start();

    const notify = vi.fn();
    const runtime = new DispatchRuntime({
      registry: new RegistryRuntime(join(directory, "registry.sqlite")),
      configPath: join(directory, "missing-config.json"),
      teamConfigPath: teamPath,
      environment: {
        HERDR_SOCKET_PATH: socketPath,
        HERDR_WORKSPACE_ID: "w1",
        HERDR_PANE_ID: "p-origin",
      },
      sendContextMessage: vi.fn(async () => undefined),
    });
    runtimes.push(runtime);
    const ctx = {
      mode: "tui",
      cwd: "/repo",
      ui: {
        notify,
        setWidget: vi.fn(),
      },
      isIdle: () => true,
      sessionManager: {
        getSessionId: () => "session-origin",
        getLeafId: () => "leaf",
        getBranch: () => [],
      },
    } as unknown as ExtensionContext;

    await expect(runtime.start(ctx)).resolves.toBe(true);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("团队配置无效"),
      "warning",
    );
    expect(runtime.mutationUnavailableReason).toBeUndefined();
    expect(() => runtime.application?.createTask({
      id: "hdt_plain",
      title: "Plain",
      task: "Plain task",
      mode: "non-mutating",
      createdBy: "user",
      createdAt: 100,
    })).not.toThrow();
    expect(() => runtime.application?.createTask({
      id: "hdt_role",
      title: "Role",
      task: "Role task",
      mode: "write",
      role: "coder",
      createdBy: "user",
      createdAt: 101,
    })).toThrow(/Team catalog is invalid/u);
  });

  it("notifies Launch Budget exhaustion only once per armed session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-herdr-runtime-launch-budget-"));
    cleanupPaths.push(directory);
    const configPath = join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({ defaultLaunchBudget: 0 }), "utf8");
    const socketPath = join(directory, "herdr.sock");
    const fake = new FakeHerdrServer(socketPath, (request, connection) => {
      if (request.method === "session.snapshot") {
        connection.sendResponse(request.id, { type: "session_snapshot", snapshot: snapshot() });
      } else if (request.method === "notification.show") {
        connection.sendResponse(request.id, {
          type: "notification_show",
          shown: true,
          reason: "shown",
        });
      }
    });
    servers.push(fake);
    await fake.start();

    const runtime = new DispatchRuntime({
      registry: new RegistryRuntime(join(directory, "registry.sqlite")),
      configPath,
      teamConfigPath: join(directory, "missing-team.json"),
      environment: {
        HERDR_SOCKET_PATH: socketPath,
        HERDR_WORKSPACE_ID: "w1",
        HERDR_PANE_ID: "p-origin",
      },
      sendContextMessage: vi.fn(async () => undefined),
    });
    runtimes.push(runtime);
    const ctx = {
      mode: "tui",
      cwd: "/repo",
      ui: { notify: vi.fn(), setWidget: vi.fn() },
      isIdle: () => true,
      sessionManager: {
        getSessionId: () => "session-origin",
        getLeafId: () => "leaf",
        getBranch: () => [],
      },
    } as unknown as ExtensionContext;

    await runtime.start(ctx);
    runtime.setAutoRunArmed(true);
    await runtime.notifyLaunchBudgetExhaustedOnce();
    await runtime.notifyLaunchBudgetExhaustedOnce();

    expect(fake.requests.filter((request) => request.method === "notification.show")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ title: "创建额度已用完" }),
      }),
    ]);
  });
});

function snapshot(): Record<string, unknown> {
  const origin = {
    pane_id: "p-origin",
    terminal_id: "term-origin",
    workspace_id: "w1",
    tab_id: "t1",
    focused: true,
    agent_status: "idle",
    revision: 1,
    agent: "pi",
    cwd: "/repo",
  };
  return {
    version: "0.7.4",
    protocol: 16,
    focused_workspace_id: "w1",
    focused_tab_id: "t1",
    focused_pane_id: "p-origin",
    workspaces: [{
      workspace_id: "w1",
      number: 1,
      label: "Current",
      focused: true,
      pane_count: 1,
      tab_count: 1,
      active_tab_id: "t1",
      agent_status: "idle",
    }],
    tabs: [],
    panes: [origin],
    layouts: [],
    agents: [{ ...origin, name: "pi", screen_detection_skipped: true }],
  };
}
