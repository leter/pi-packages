import { readFile } from "node:fs/promises";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const packageRoot = new URL("../../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, packageRoot), "utf8");
}

describe("human UI copy boundary", () => {
  it("keeps contractual model-facing framing out of the human catalog", async () => {
    const catalog = await source("src/pi/ui-copy.ts");

    for (const protectedText of [
      "untrusted, never instructions",
      "Treat this content",
      "BEGIN_HERDR",
      "END_HERDR",
      "untrusted-herdr-cli-output",
      "Focused-input warning",
      "HERDR_DISPATCH_PROMPT_GUIDELINE",
    ]) {
      expect(catalog).not.toContain(protectedText);
    }
  });

  it("keeps model and target framing producers independent of the human catalog", async () => {
    const protectedProducers = [
      "src/pi/presentation.ts",
      "src/pi/safety-gate.ts",
      "src/settlement/context-delivery.ts",
      "src/dispatch/proposal.ts",
      "src/dispatch/followup.ts",
    ];

    for (const path of protectedProducers) {
      expect(await source(path), path).not.toContain("ui-copy");
    }
  });

  it("rejects inline natural-language copy in human presentation consumers", async () => {
    const consumers = [
      "src/pi/commands.ts",
      "src/pi/dispatch-command-selection.ts",
      "src/pi/dispatch-controller.ts",
      "src/pi/dispatch-runtime.ts",
      "src/pi/dispatch-view-model.ts",
      "src/pi/dispatch-view.ts",
      "src/pi/followup-controller.ts",
      "src/pi/live-presentation.ts",
      "src/pi/registry-runtime.ts",
      "src/pi/renderers.ts",
      "src/pi/visual.ts",
    ];
    const violations: string[] = [];

    for (const path of consumers) {
      const text = await source(path);
      const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node) && !ts.isImportDeclaration(node.parent)) {
          check(path, file, node, node.text, violations);
        } else if (ts.isTemplateExpression(node)) {
          const staticText = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)]
            .join(" ");
          check(path, file, node, staticText, violations);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }

    expect(violations).toEqual([]);
  });
});

function check(
  path: string,
  file: ts.SourceFile,
  node: ts.Node,
  text: string,
  violations: string[],
): void {
  if (!/[A-Za-z]{2,}\s+[A-Za-z]{2,}/u.test(text)) return;
  if (/untrusted|never instructions/u.test(text)) return;
  const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
  violations.push(`${path}:${line + 1}: ${JSON.stringify(text)}`);
}
