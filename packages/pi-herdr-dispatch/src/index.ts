import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createDispatchProposalToolDefinition } from "./pi/dispatch-proposal-tool.js";
import { registerSafetyGate } from "./pi/safety-gate.js";

export default function piHerdrDispatch(pi: ExtensionAPI): void {
  pi.registerTool(createDispatchProposalToolDefinition());
  registerSafetyGate(pi, {
    currentPaneId: () => process.env.HERDR_PANE_ID,
    getLeaseContext: () => ({
      leaseSnapshot: {
        status: "unavailable",
        reason: "Dispatch Registry is not available until Phase 2 is implemented",
      },
    }),
  });
}
