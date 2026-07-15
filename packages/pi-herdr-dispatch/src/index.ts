import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerDispatchCommands } from "./pi/commands.js";
import { DispatchController } from "./pi/dispatch-controller.js";
import { DispatchRuntime } from "./pi/dispatch-runtime.js";
import { registerSafetyGate } from "./pi/safety-gate.js";
import { registerDispatchTools } from "./pi/tools.js";

export default function piHerdrDispatch(pi: ExtensionAPI): void {
  const runtime = new DispatchRuntime();
  const controller = new DispatchController({
    application: () => runtime.application,
    mutationUnavailableReason: () => runtime.mutationUnavailableReason,
  });

  registerDispatchTools(pi, runtime, controller);
  registerDispatchCommands(pi, runtime, controller);
  registerSafetyGate(pi, {
    currentPaneId: () => process.env.HERDR_PANE_ID,
    getLeaseContext: () => runtime.registryRuntime.leaseContext(),
  });

  pi.on("session_start", async (_event, ctx) => {
    await runtime.start(ctx);
  });
  pi.on("session_shutdown", () => {
    runtime.stop();
  });
}
