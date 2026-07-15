import { describe, expect, it } from "vitest";

import {
  createDispatchProposalToolDefinition,
  HERDR_DISPATCH_PROMPT_GUIDELINE,
} from "../../src/pi/dispatch-proposal-tool.js";

describe("dispatch proposal prompt guidance", () => {
  it("explicitly overrides skill-guided raw Herdr tasking", () => {
    const tool = createDispatchProposalToolDefinition();

    expect(tool.name).toBe("herdr_dispatch_propose");
    expect(tool.promptGuidelines).toEqual([HERDR_DISPATCH_PROMPT_GUIDELINE]);
    expect(HERDR_DISPATCH_PROMPT_GUIDELINE).toContain(
      "Use herdr_dispatch_propose for every request to task another Herdr Agent",
    );
    expect(HERDR_DISPATCH_PROMPT_GUIDELINE).toContain(
      "Do not use bash, user_bash, or raw herdr pane / herdr agent / herdr wait commands",
    );
  });

  it("fails closed until the confirmed proposal flow is implemented", async () => {
    const tool = createDispatchProposalToolDefinition();

    await expect(
      tool.execute(
        "call_1",
        {
          target: "term_target",
          task: "Review the change",
          mode: "non-mutating",
        },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow("not available until Phase 4");
  });
});
