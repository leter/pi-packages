import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerDispatchTools } from "../../src/pi/tools.js";
import { DispatchRuntime } from "../../src/pi/dispatch-runtime.js";
import { openDispatchRegistry, type DispatchRegistry } from "../../src/registry/registry.js";

const roots: string[] = [];
const registries: DispatchRegistry[] = [];

afterEach(async () => {
  for (const registry of registries.splice(0)) registry.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function registry(): Promise<DispatchRegistry> {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-readonly-tool-"));
  roots.push(root);
  const opened = await openDispatchRegistry(join(root, "registry.sqlite"));
  registries.push(opened);
  return opened;
}

function toolHarness(opened: DispatchRegistry, launchReadonlyAgent: () => Promise<ReturnType<typeof launched>>) {
  const tools: ToolDefinition[] = [];
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    exec: vi.fn(async () => ({ stdout: "pi: current", stderr: "", code: 0 })),
  } as unknown as ExtensionAPI;
  const productionRuntime = new DispatchRuntime();
  const notifyLaunchBudgetExhaustedOnce = vi.fn(async () => undefined);
  const runtime = {
    application: {
      assertReadonlyAgentLaunchAllowed: vi.fn(async () => "pi"),
      launchReadonlyAgent,
    },
    launchBudgetState: () => opened.getLaunchBudgetState("session-origin", 1),
    consumeLaunchBudget: (launch: ReturnType<typeof launched>) =>
      opened.consumeLaunchBudget("session-origin", Date.now(), {
        defaultLaunchBudget: 1,
        role: launch.role,
        agentType: launch.agentLabel,
        paneId: launch.paneId,
        terminalId: launch.terminalId,
        paneName: launch.paneName,
      }),
    notifyReadonlyAgentLaunched: vi.fn(async () => undefined),
    notifyLaunchBudgetExhaustedOnce,
    runReadonlyLaunchExclusive: productionRuntime.runReadonlyLaunchExclusive.bind(productionRuntime),
  };
  registerDispatchTools(pi, runtime as never, {} as never);
  return {
    tool: tools.find((candidate) => candidate.name === "herdr_agent_launch_readonly")!,
    notifyLaunchBudgetExhaustedOnce,
  };
}

function launched() {
  return {
    terminalId: "term-reviewer",
    paneId: "p-reviewer",
    agentLabel: "pi",
    statusProvenance: "reported" as const,
    paneName: "reviewer-auto-1",
    role: "reviewer",
    roleLabel: "评审",
  };
}

const ctx = { mode: "tui", cwd: "/repo" } as ExtensionContext;

describe("read-only launch tool with durable Launch Budget", () => {
  it("serializes concurrent calls so budget one creates and audits exactly one pane", async () => {
    const opened = await registry();
    opened.armAutoRun("session-origin", 10, 1, 100);
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const launchReadonlyAgent = vi.fn(async () => {
      await ready;
      return launched();
    });
    const harness = toolHarness(opened, launchReadonlyAgent);

    const first = harness.tool.execute(
      "call-1", { role: "reviewer", agentType: "pi" }, undefined, undefined, ctx,
    );
    await vi.waitFor(() => expect(launchReadonlyAgent).toHaveBeenCalledOnce());
    const second = harness.tool.execute(
      "call-2", { role: "reviewer", agentType: "pi" }, undefined, undefined, ctx,
    );
    expect(launchReadonlyAgent).toHaveBeenCalledOnce();
    release();

    await expect(first).resolves.toEqual(expect.objectContaining({
      details: expect.objectContaining({ status: "launched", remainingBudget: 0 }),
    }));
    await expect(second).resolves.toEqual(expect.objectContaining({
      details: expect.objectContaining({ status: "refused" }),
    }));
    expect(launchReadonlyAgent).toHaveBeenCalledOnce();
    expect(opened.getLaunchBudgetState("session-origin", 1)).toEqual({ armed: true, remaining: 0 });
    expect(opened.listAuditEvents().filter((event) => event.eventType === "readonly_launch"))
      .toHaveLength(1);
    expect(harness.notifyLaunchBudgetExhaustedOnce).toHaveBeenCalledOnce();
  });

  it("leaves durable budget and audit unchanged when startup fails", async () => {
    const opened = await registry();
    opened.armAutoRun("session-origin", 10, 1, 100);
    const harness = toolHarness(opened, vi.fn(async () => { throw new Error("startup failed"); }));

    await expect(harness.tool.execute(
      "call-failed", { role: "reviewer", agentType: "pi" }, undefined, undefined, ctx,
    )).rejects.toThrow("startup failed");
    expect(opened.getLaunchBudgetState("session-origin", 1)).toEqual({ armed: true, remaining: 1 });
    expect(opened.listAuditEvents().filter((event) => event.eventType === "readonly_launch"))
      .toEqual([]);
  });

  it("refuses an Agent type absent from the current integration catalog before launch", async () => {
    const opened = await registry();
    opened.armAutoRun("session-origin", 10, 1, 100);
    const launchReadonlyAgent = vi.fn(async () => launched());
    const tools: ToolDefinition[] = [];
    const pi = {
      registerTool: (tool: ToolDefinition) => tools.push(tool),
      exec: vi.fn(async () => ({ stdout: "pi: current", stderr: "", code: 0 })),
    } as unknown as ExtensionAPI;
    const runtime = {
      application: {
        assertReadonlyAgentLaunchAllowed: vi.fn(async () => "claude"),
        launchReadonlyAgent,
      },
      launchBudgetState: () => opened.getLaunchBudgetState("session-origin", 1),
      runReadonlyLaunchExclusive: <T>(action: () => Promise<T>) => action(),
    };
    registerDispatchTools(pi, runtime as never, {} as never);
    const tool = tools.find((candidate) => candidate.name === "herdr_agent_launch_readonly")!;

    const result = await tool.execute(
      "call-unavailable", { role: "reviewer", agentType: "claude" }, undefined, undefined, ctx,
    );
    expect(result.content).toEqual([expect.objectContaining({
      text: expect.stringContaining("not launchable"),
    })]);
    expect(launchReadonlyAgent).not.toHaveBeenCalled();
    expect(opened.getLaunchBudgetState("session-origin", 1)).toEqual({ armed: true, remaining: 1 });
  });
});
