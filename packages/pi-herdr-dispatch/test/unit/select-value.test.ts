import { describe, expect, it } from "vitest";

import { selectDomainValue } from "../../src/pi/select-value.js";
import { UI_COPY } from "../../src/pi/ui-copy.js";

describe("selectDomainValue", () => {
  it("shows translated labels while returning the raw domain value", async () => {
    const shown: string[][] = [];
    const value = await selectDomainValue(
      async (_title, options) => {
        shown.push(options);
        return "写入";
      },
      UI_COPY.command.mutationMode(),
      ["non-mutating", "write"] as const,
      (mode) => UI_COPY.state.mode(mode),
    );
    expect(shown[0]).toEqual(["非变更", "写入"]);
    expect(value).toBe("write");
  });

  it("maps every manual Final Outcome label back to its value", async () => {
    for (const expected of ["blocked", "failed", "cancelled"] as const) {
      const value = await selectDomainValue(
        async () => UI_COPY.state.outcome(expected),
        UI_COPY.followup.manualFinalOutcome(),
        ["blocked", "failed", "cancelled"] as const,
        (outcome) => UI_COPY.state.outcome(outcome),
      );
      expect(value).toBe(expected);
    }
  });

  it("returns undefined for cancel and for an unknown choice", async () => {
    expect(
      await selectDomainValue(async () => undefined, "t", ["a"] as const, (value) => value),
    ).toBeUndefined();
    expect(
      await selectDomainValue(async () => "别的", "t", ["a"] as const, (value) => value),
    ).toBeUndefined();
  });
});
