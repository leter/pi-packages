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

export interface HerdrEchoVerificationOptions {
  echoWindowMs: number;
  echoPollMs?: number;
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
  const marker = `ID: ${correlationId}`;
  return text.split(/\r?\n/u).some((line) => {
    let index = line.indexOf(marker);
    while (index >= 0) {
      const following = line[index + marker.length];
      if (following === undefined || !/[A-Za-z0-9_-]/u.test(following)) return true;
      index = line.indexOf(marker, index + 1);
    }
    return false;
  });
}
