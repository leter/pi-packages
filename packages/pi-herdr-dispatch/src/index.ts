import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createDispatchProposalToolDefinition } from "./pi/dispatch-proposal-tool.js";
import { RegistryRuntime } from "./pi/registry-runtime.js";
import { registerSafetyGate } from "./pi/safety-gate.js";

export default function piHerdrDispatch(pi: ExtensionAPI): void {
  const registry = new RegistryRuntime();

  pi.registerTool(createDispatchProposalToolDefinition());
  registerSafetyGate(pi, {
    currentPaneId: () => process.env.HERDR_PANE_ID,
    getLeaseContext: () => registry.leaseContext(),
  });

  pi.on("session_start", async () => {
    await registry.start();
  });
  pi.on("session_shutdown", () => {
    registry.stop();
  });
}
