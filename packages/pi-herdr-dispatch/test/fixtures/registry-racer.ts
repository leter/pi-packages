import { existsSync, writeFileSync } from "node:fs";

import { openDispatchRegistry, RegistryConflictError } from "../../src/registry/registry.js";
import type { ConfirmDeliveryIntent } from "../../src/registry/types.js";

const [databasePath, dispatchId, readyPath, goPath] = process.argv.slice(2);
if (!databasePath || !dispatchId || !readyPath || !goPath) {
  throw new Error("registry-racer requires databasePath, dispatchId, readyPath, and goPath");
}

writeFileSync(readyPath, "ready");
while (!existsSync(goPath)) await new Promise((resolve) => setTimeout(resolve, 5));
const registry = await openDispatchRegistry(databasePath, { busyTimeoutMs: 2_000 });

const intent: ConfirmDeliveryIntent = {
  id: dispatchId,
  originSessionId: `session_${dispatchId}`,
  originWorkspaceId: "w1",
  targetWorkspaceId: "w1",
  targetTerminalId: "term_race",
  targetPaneId: "w1:p2",
  targetAgentLabel: "pi",
  targetCwd: "/repo/race",
  worktreePath: "/repo/race",
  mode: "write",
  task: "Race",
  constraints: [],
  payload: `payload:${dispatchId}`,
  payloadHash: `sha256:${dispatchId}`,
  deadlineAt: 2_000,
  confirmedAt: 1_000,
};

try {
  registry.confirmDeliveryIntent(intent);
  process.stdout.write(JSON.stringify({ status: "won", dispatchId }));
} catch (error) {
  if (error instanceof RegistryConflictError) {
    process.stdout.write(JSON.stringify({ status: "conflict", dispatchId, code: error.code }));
  } else {
    throw error;
  }
} finally {
  registry.close();
}
