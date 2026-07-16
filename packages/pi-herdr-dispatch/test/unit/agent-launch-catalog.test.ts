import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  executableExistsOnPath,
  launchableAgentTypes,
  parseCurrentIntegrations,
} from "../../src/pi/agent-launch-catalog.js";

describe("Agent launch catalog", () => {
  const status = [
    "pi: current (v4) (/tmp/pi)",
    "claude: current (v7) (/tmp/claude)",
    "codex: not installed (/tmp/codex)",
    "opencode: current (v8) (/tmp/opencode)",
    "droid: current (v3) (/tmp/droid)",
  ].join("\n");

  it("parses only current Herdr integrations", () => {
    expect([...parseCurrentIntegrations(status)]).toEqual(["pi", "claude", "opencode", "droid"]);
  });

  it("keeps supported types in stable order only when both integrated and executable", async () => {
    const executable = vi.fn(async (name: string) => name !== "claude");

    await expect(launchableAgentTypes(status, executable)).resolves.toEqual([
      "pi",
      "opencode",
      "amp",
      "droid",
      "grok",
    ]);
    expect(executable.mock.calls.map(([name]) => name)).toEqual([
      "pi",
      "claude",
      "opencode",
      "amp",
      "droid",
      "grok",
    ]);
  });

  it("does not treat an executable directory as an Agent command", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-herdr-agent-path-"));
    const candidate = join(root, "amp");
    try {
      await mkdir(candidate);
      await chmod(candidate, 0o755);
      await expect(executableExistsOnPath("amp", root)).resolves.toBe(false);

      await rm(candidate, { recursive: true });
      await writeFile(candidate, "#!/bin/sh\n", { mode: 0o755 });
      await expect(executableExistsOnPath("amp", root)).resolves.toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows the reviewed screen-detected Agents without a current integration", async () => {
    await expect(launchableAgentTypes("", async () => true)).resolves.toEqual([
      "amp",
      "droid",
      "grok",
    ]);
  });
});
