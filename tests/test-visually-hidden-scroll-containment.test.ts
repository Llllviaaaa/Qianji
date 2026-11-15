import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..");
const SKIN_MESSAGES_PATH = join(REPO_ROOT, "src/styles/skin-messages.css");

function parseCssRules(css: string): Map<string, Map<string, string>> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = new Map<string, Map<string, string>>();
  const blockPattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of stripped.matchAll(blockPattern)) {
    const rawSelectors = match[1] ?? "";
    const rawBody = match[2] ?? "";
    const decls = new Map<string, string>();
    for (const part of rawBody.split(";")) {
      const colonIdx = part.indexOf(":");
      if (colonIdx === -1) continue;
      const prop = part.slice(0, colonIdx).trim();
      const val = part.slice(colonIdx + 1).trim();
      if (prop.length > 0 && val.length > 0) {
        decls.set(prop, val);
      }
    }
    for (const sel of rawSelectors.split(",")) {
      const normalized = sel.trim().replace(/\s+/g, " ");
      if (normalized.length === 0) continue;
      const existing = rules.get(normalized) ?? new Map<string, string>();
      for (const [k, v] of decls) existing.set(k, v);
      rules.set(normalized, existing);
    }
  }
  return rules;
}

function collectTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsxFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function getStaticClassNames(opening: ts.JsxOpeningLikeElement): string[] {
  for (const prop of opening.attributes.properties) {
    if (!ts.isJsxAttribute(prop) || prop.name.getText() !== "className" || !prop.initializer) continue;
    if (ts.isStringLiteral(prop.initializer)) {
      return prop.initializer.text.trim().split(/\s+/).filter(Boolean);
    }
    if (ts.isJsxExpression(prop.initializer) && prop.initializer.expression) {
      const expr = prop.initializer.expression;
      if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
        return expr.text.trim().split(/\s+/).filter(Boolean);
      }
      if (ts.isTemplateExpression(expr)) {
        return expr.head.text.trim().split(/\s+/).filter(Boolean);
      }
    }
  }
  return [];
}

describe("Visually-hidden scroll containment inside ProcessGroup & conversation stage", () => {
  const skinCss = readFileSync(SKIN_MESSAGES_PATH, "utf8");
  const rules = parseCssRules(skinCss);

  it("anchors .codex-shot .dshc-visually-hidden at top/left 0 with clip-path containment", () => {
    const vh = rules.get(".codex-shot .dshc-visually-hidden");
    assert.ok(vh, "Missing .codex-shot .dshc-visually-hidden rule in skin-messages.css");
    assert.equal(vh.get("position"), "absolute");
    assert.equal(vh.get("top"), "0");
    assert.equal(vh.get("left"), "0");
    assert.equal(vh.get("width"), "1px");
    assert.equal(vh.get("height"), "1px");
    assert.equal(vh.get("overflow"), "hidden");
    assert.equal(vh.get("clip"), "rect(0 0 0 0)");
    assert.equal(vh.get("clip-path"), "inset(50%)");
    assert.equal(vh.get("white-space"), "nowrap");
  });

  it("establishes position: relative on ProcessGroup scroll body and visually-hidden hosts without breaking masks or sticky headers", () => {
    const requiredRelativeSelectors = [
      ".codex-shot .dshc-group-body",
      ".codex-shot .dshc-tool",
      ".codex-shot .dshc-reasoning",
      ".codex-shot .dshc-running",
      ".codex-shot .dshc-terminal-prompt",
      ".codex-shot .dshc-bubble",
    ];
    for (const selector of requiredRelativeSelectors) {
      const decls = rules.get(selector);
      assert.ok(decls, `Missing ${selector} in skin-messages.css`);
      assert.equal(decls.get("position"), "relative", `${selector} must establish a positioned containing block`);
    }

    const groupBody = rules.get(".codex-shot .dshc-group-body");
    assert.equal(groupBody?.get("max-height"), "min(400px, calc(var(--ui-vh, 100vh) * 0.5))");
    assert.ok(rules.get(".codex-shot .dshc-group-body.is-fade-top")?.has("mask-image"));
    assert.ok(rules.get(".codex-shot .dshc-group-body.is-fade-bottom")?.has("mask-image"));

    const reasoning = rules.get(".codex-shot .dshc-reasoning");
    assert.equal(reasoning?.has("overflow"), false, ".dshc-reasoning must not clip sticky disclosure rows");
    const stickyRow = rules.get(".codex-shot .dshc-reasoning[data-expanded] [data-open] > [data-disclosure-row]");
    assert.equal(stickyRow?.get("position"), "sticky");
    assert.equal(stickyRow?.get("top"), "0");
  });

  it("verifies every JSX usage of dshc-visually-hidden in src/ has a positioned parent rule", () => {
    const callSites: Array<{ location: string; parentClasses: string[] }> = [];
    for (const filePath of collectTsxFiles(join(REPO_ROOT, "src"))) {
      const sourceText = readFileSync(filePath, "utf8");
      if (!sourceText.includes("dshc-visually-hidden")) continue;
      const sf = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node): void => {
        const opening = ts.isJsxElement(node)
          ? node.openingElement
          : ts.isJsxSelfClosingElement(node)
            ? node
            : undefined;
        if (opening && getStaticClassNames(opening).includes("dshc-visually-hidden")) {
          let ancestor: ts.Node | undefined = node.parent;
          while (ancestor && !ts.isJsxElement(ancestor)) ancestor = ancestor.parent;
          const parentClasses = ancestor ? getStaticClassNames(ancestor.openingElement) : [];
          const line = sf.getLineAndCharacterOfPosition(opening.getStart(sf)).line + 1;
          callSites.push({ location: `${relative(REPO_ROOT, filePath).replace(/\\/g, "/")}:${line}`, parentClasses });
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    assert.ok(callSites.length >= 5, `Expected at least 5 dshc-visually-hidden JSX call sites, found ${callSites.length}`);
    for (const site of callSites) {
      const positionedParent = site.parentClasses.find((cls) => rules.get(`.codex-shot .${cls}`)?.get("position") === "relative");
      assert.ok(
        positionedParent,
        `${site.location} renders .dshc-visually-hidden under [${site.parentClasses.join(", ")}] without position: relative in skin-messages.css`,
      );
    }
  });
});
