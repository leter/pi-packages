import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerSafetyGate } from "./pi/safety-gate.js";

export default function piHerdrDispatch(pi: ExtensionAPI): void {
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
