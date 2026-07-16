import { describe, expect, it } from "vitest";

import { parseResultLine, scanResultTail } from "../../src/domain/result-envelope.js";

describe("Result Envelope", () => {
  it("accepts and sanitizes the bounded known schema while retaining raw input separately", () => {
    const raw = ' DISPATCH_RESULT {"id":"hd_1","outcome":"done","summary":"Implemented parser","tests":["npm test"],"changedFiles":["src/a.ts"],"artifacts":[],"unknown":"raw only"}';

    expect(parseResultLine(raw, "hd_1")).toEqual({
      status: "valid",
      raw: raw.trim(),
      result: {
        id: "hd_1",
        outcome: "done",
        summary: "Implemented parser",
        tests: ["npm test"],
        changedFiles: ["src/a.ts"],
        artifacts: [],
      },
    });
  });

  it.each([
    'DISPATCH_RESULT {"id":"hd_1","outcome":"success","summary":"x"}',
    'DISPATCH_RESULT {"id":"hd_1","outcome":"done","summary":""}',
    'DISPATCH_RESULT {"id":"hd_1","outcome":"done","summary":42}',
    'DISPATCH_RESULT {"id":"hd_1","outcome":"done","summary":"x","tests":"no"}',
    `DISPATCH_RESULT {"id":"hd_1","outcome":"done","summary":"${"x".repeat(1001)}"}`,
    'DISPATCH_RESULT {"id":"hd_1","outcome":"done",broken}',
  ])("marks a matching malformed envelope without settling: %s", (line) => {
    expect(parseResultLine(line, "hd_1")).toEqual(
      expect.objectContaining({ status: "malformed", raw: expect.any(String), reason: expect.any(String) }),
    );
  });

  it("ignores envelopes for other correlation IDs and ordinary output", () => {
    expect(
      parseResultLine(
        'DISPATCH_RESULT {"id":"hd_other","outcome":"done","summary":"x"}',
        "hd_1",
      ),
    ).toEqual({ status: "ignore" });
    expect(parseResultLine("ordinary output", "hd_1")).toEqual({ status: "ignore" });
  });

  it("reconstructs a bounded Result Envelope hard-wrapped by a narrow TUI", () => {
    const tail = `DISPATCH_RESULT
 {"id":"hd_1","outcome":"done",
 "summary":"accepted"}`;

    expect(scanResultTail(tail, "hd_1").valid).toEqual(
      expect.objectContaining({
        status: "valid",
        result: expect.objectContaining({ outcome: "done", summary: "accepted" }),
      }),
    );
  });

  it("ignores the exact outbound Result Envelope contract template", () => {
    expect(
      parseResultLine(
        'DISPATCH_RESULT {"id":"hd_1","outcome":"done|blocked|failed|cancelled","summary":"..."}',
        "hd_1",
      ),
    ).toEqual({ status: "ignore" });
  });

  it("accepts a Codex result rendered after its hard-wrapped contract template", () => {
    const tail = `Finish by printing exactly one single-line Result Envelope, not fenced in Markdown, keeping the whole line under 200 characters with a one-sentence summary:
  DISPATCH_RESULT {"id":"hd_1","outcome":"done|blocked|
  failed|cancelled","summary":"..."}

• DISPATCH_RESULT
  {"id":"hd_1","outcome":"done","summary":"Codex live reread
  verified"}`;

    expect(scanResultTail(tail, "hd_1")).toEqual({
      valid: expect.objectContaining({
        status: "valid",
        result: expect.objectContaining({ outcome: "done", summary: "Codex live rereadverified" }),
      }),
      malformed: [],
    });
  });

  it("accepts a Grok result whose bare prefix row has a decorative timestamp", () => {
    const tail = `DISPATCH_RESULT                                                1:39 PM
     {"id":"hd_1","outcome":"done","summa
     ry":"Grok compatibility probe passed"}`;

    expect(scanResultTail(tail, "hd_1")).toEqual({
      valid: expect.objectContaining({
        status: "valid",
        result: expect.objectContaining({
          outcome: "done",
          summary: "Grok compatibility probe passed",
        }),
      }),
      malformed: [],
    });
  });

  it("takes the first valid matching envelope outside Markdown fences", () => {
    const tail = `\`\`\`json
DISPATCH_RESULT {"id":"hd_1","outcome":"failed","summary":"example"}
\`\`\`
DISPATCH_RESULT {"id":"hd_other","outcome":"done","summary":"other"}
DISPATCH_RESULT {"id":"hd_1","outcome":"done","summary":"accepted"}
DISPATCH_RESULT {"id":"hd_1","outcome":"failed","summary":"late conflict"}`;

    expect(scanResultTail(tail, "hd_1")).toEqual({
      valid: expect.objectContaining({
        status: "valid",
        result: expect.objectContaining({ outcome: "done", summary: "accepted" }),
      }),
      malformed: [],
    });
  });

  it("bounds malformed raw evidence", () => {
    const parsed = parseResultLine(`DISPATCH_RESULT {"id":"hd_1","x":"${"z".repeat(20_000)}"`, "hd_1");
    expect(parsed.status).toBe("malformed");
    if (parsed.status === "malformed") expect(parsed.raw.length).toBeLessThanOrEqual(16_000);
  });
});
