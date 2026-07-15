import type { HerdrPane, HerdrPaneRead } from "./protocol.js";

export interface ExpectedHerdrTarget {
  terminalId: string;
  expectedAgent?: string;
  expectedCwd?: string;
  allowedStatuses?: readonly ("idle" | "done" | "working" | "blocked" | "unknown")[];
}

export interface HerdrDeliveryRequest {
  target: ExpectedHerdrTarget;
  correlationId: string;
  text: string;
}

export type HerdrDeliveryResult =
  | { status: "verified"; pane: HerdrPane; echo: HerdrPaneRead }
  | {
      status: "not-sent";
      reason:
        | "target-lost"
        | "target-changed"
        | "target-not-idle"
        | "api-rejected"
        | "transport-unavailable";
      detail?: string;
    }
  | {
      status: "ambiguous";
      reason: "response-unknown" | "echo-not-found" | "echo-read-failed";
      pane?: HerdrPane;
      detail?: string;
    };

export function hasDeliveryEcho(text: string, correlationId: string): boolean {
  const lines = text.split(/\r?\n/u).map((line) => line.trim());
  return lines.includes("[HERDR DISPATCH]") && lines.includes(`ID: ${correlationId}`);
}
