import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const packageRoot = new URL("../../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, packageRoot), "utf8");
}

async function allSourceFiles(): Promise<string[]> {
  const root = fileURLToPath(new URL("src/", packageRoot));
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => `src/${relative(root, join(entry.parentPath, entry.name))}`)
    .sort();
}

const CJK = /[一-鿿]/u;

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
      "src/pi/settings-view-model.ts",
      "src/pi/settings-view.ts",
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

  it("confines Chinese product copy to the catalog and its documented exception", async () => {
    // The focused-input warning in followup.ts is the one deliberate
    // human-facing string owned by the dispatch layer (ADR 0011).
    const allowed = new Set(["src/pi/ui-copy.ts", "src/dispatch/followup.ts"]);
    const violations: string[] = [];

    for (const path of await allSourceFiles()) {
      if (allowed.has(path)) continue;
      const text = await source(path);
      if (!CJK.test(text)) continue;
      const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node) && CJK.test(node.text)) {
          const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
          violations.push(`${path}:${line + 1}: ${JSON.stringify(node.text)}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }

    expect(violations).toEqual([]);
  });

  it("never branches on translated copy", async () => {
    // Comparing anything against a Chinese string literal means logic is
    // coupled to display copy (ADR 0011: selection values never couple to
    // display labels). Domain decisions must compare raw enum values;
    // selects over domain values go through selectDomainValue.
    const violations: string[] = [];

    for (const path of await allSourceFiles()) {
      const text = await source(path);
      if (!CJK.test(text)) continue;
      const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        const isComparison =
          ts.isBinaryExpression(node) &&
          [
            ts.SyntaxKind.EqualsEqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsEqualsToken,
            ts.SyntaxKind.EqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsToken,
          ].includes(node.operatorToken.kind);
        const cjkLiteral = (candidate: ts.Node): boolean =>
          ts.isStringLiteralLike(candidate) && CJK.test(candidate.text);
        if (
          (isComparison && (cjkLiteral(node.left) || cjkLiteral(node.right))) ||
          (ts.isCaseClause(node) && cjkLiteral(node.expression))
        ) {
          const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
          violations.push(`${path}:${line + 1}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }

    expect(violations).toEqual([]);
  });

  it("never compares a select result against a string literal", async () => {
    // The wizard bug: select shows translated labels, code compares the
    // raw English value, every choice falls through. Legal patterns are
    // options.indexOf(choice), comparison against UI_COPY calls, or
    // selectDomainValue. A literal comparison is always this bug.
    const fixture = `
      async function bad(ui: { select(t: string, o: string[]): Promise<string | undefined> }) {
        const mode = await ui.select("t", ["非变更", "写入"]);
        if (mode !== "write") return;
      }
    `;
    expect(selectLiteralViolations("fixture.ts", fixture)).toHaveLength(1);

    const violations: string[] = [];
    for (const path of await allSourceFiles()) {
      violations.push(...selectLiteralViolations(path, await source(path)));
    }
    expect(violations).toEqual([]);
  });
});

function selectLiteralViolations(path: string, text: string): string[] {
  if (!text.includes(".select(")) return [];
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const selected = new Set<string>();
  const violations: string[] = [];

  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      let value: ts.Node = node.initializer;
      if (ts.isAwaitExpression(value)) value = value.expression;
      if (
        ts.isCallExpression(value) &&
        ts.isPropertyAccessExpression(value.expression) &&
        value.expression.name.text === "select"
      ) {
        selected.add(node.name.text);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(file);
  if (selected.size === 0) return [];

  const flag = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ].includes(node.operatorToken.kind)
    ) {
      const sides = [node.left, node.right];
      const identifier = sides.find(
        (side): side is ts.Identifier => ts.isIdentifier(side) && selected.has(side.text),
      );
      const literal = sides.find(ts.isStringLiteralLike);
      if (identifier && literal) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
        violations.push(`${path}:${line + 1}: ${identifier.text} vs ${JSON.stringify(literal.text)}`);
      }
    }
    ts.forEachChild(node, flag);
  };
  flag(file);
  return violations;
}

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
