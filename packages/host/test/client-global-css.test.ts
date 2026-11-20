import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLIENT_SHARED_EXTERNALS,
  CORE_SLOT_CATALOG,
  FRONTEND_SERVICE_CATALOG,
} from "@qianji/protocol";
import { ClientBundleRegistry } from "../src/client-bundles.ts";

let tempRoot = "";

afterEach(() => {
  if (tempRoot !== "") {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  }
});

interface MockStyleEl {
  tagName: string;
  textContent: string;
  attrs: Map<string, string>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
}

function createMockDocument() {
  const styles: MockStyleEl[] = [];
  const head = {
    children: styles,
    appendChild(el: MockStyleEl) {
      styles.push(el);
      return el;
    },
    querySelector(selector: string): MockStyleEl | null {
      const match = /^style\[([a-z-]+)="([^"]+)"\]$/.exec(selector);
      if (match === null) return null;
      const attrName = match[1];
      const attrVal = match[2];
      if (attrName === undefined || attrVal === undefined) return null;
      return styles.find((el) => el.attrs.get(attrName) === attrVal) ?? null;
    },
  };
  return {
    styles,
    document: {
      head,
      createElement(tag: string): MockStyleEl {
        const attrs = new Map<string, string>();
        return {
          tagName: tag.toUpperCase(),
          textContent: "",
          attrs,
          setAttribute(name: string, value: string) {
            attrs.set(name, value);
          },
          getAttribute(name: string) {
            return attrs.get(name) ?? null;
          },
        };
      },
    },
  };
}

function evaluateBundle(
  code: string,
  env: {
    modules?: Record<string, unknown>;
    globalHooks?: {
      scoped?: (pluginId: string, css: string, styleKey?: string) => void;
      global?: (pluginId: string, css: string, styleKey?: string) => void;
    };
    document?: unknown;
  } = {},
): unknown {
  let loadedExports: unknown;
  const fakeWindow = {
    __ModuleLoader__: {
      load(entry: { id: string; factory: (req: (id: string) => unknown) => unknown }) {
        loadedExports = entry.factory((spec) => env.modules?.[spec] ?? {});
      },
    },
  };
  const fakeGlobalThis: Record<string, unknown> = {};
  if (env.globalHooks?.scoped !== undefined) {
    fakeGlobalThis.__qianjiInjectPluginStyle = env.globalHooks.scoped;
  }
  if (env.globalHooks?.global !== undefined) {
    fakeGlobalThis.__qianjiInjectPluginGlobalStyle = env.globalHooks.global;
  }
  const runner = new Function("window", "globalThis", "document", code) as (
    win: unknown,
    g: unknown,
    doc: unknown,
  ) => void;
  runner(fakeWindow, fakeGlobalThis, env.document);
  return loadedExports;
}

describe("ClientBundleRegistry .global.css channel & ADR 0023 shared externals", () => {
  it("routes .global.css (case-insensitive) to __qianjiInjectPluginGlobalStyle while keeping .css scoped", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "qj-global-css-"));
    mkdirSync(join(tempRoot, "styles"), { recursive: true });

    const scopedCssPath = join(tempRoot, "styles", "widget.css");
    const globalCssPath = join(tempRoot, "styles", "skin.global.css");
    const upperGlobalCssPath = join(tempRoot, "styles", "EXTRA.GLOBAL.CSS");
    const entryPath = join(tempRoot, "client.tsx");

    writeFileSync(scopedCssPath, ".widget { color: rgb(1, 2, 3); }");
    writeFileSync(globalCssPath, ":root { --qj-bg-app: #101018; } body { font-size: 15px; }");
    writeFileSync(upperGlobalCssPath, ".app-shell { border-radius: 12px; }");
    writeFileSync(
      entryPath,
      `
        import scopedCss from "./styles/widget.css";
        import globalCss from "./styles/skin.global.css";
        import upperCss from "./styles/EXTRA.GLOBAL.CSS";
        export default function apply() {
          return { scopedCss, globalCss, upperCss };
        }
      `,
    );

    const registry = new ClientBundleRegistry();
    const compiled = await registry.compile("neon-skin", tempRoot, entryPath);

    expect(compiled.code).toContain("__qianjiInjectPluginStyle");
    expect(compiled.code).toContain("__qianjiInjectPluginGlobalStyle");
    expect(compiled.code).toContain("@layer plugin-skin");
    expect(compiled.code).toContain("@layer plugin-ui");

    const scopedCalls: Array<{ pluginId: string; css: string; styleKey?: string }> = [];
    const globalCalls: Array<{ pluginId: string; css: string; styleKey?: string }> = [];
    evaluateBundle(compiled.code, {
      globalHooks: {
        scoped: (pluginId, css, styleKey) => scopedCalls.push({ pluginId, css, ...(styleKey === undefined ? {} : { styleKey }) }),
        global: (pluginId, css, styleKey) => globalCalls.push({ pluginId, css, ...(styleKey === undefined ? {} : { styleKey }) }),
      },
    });

    expect(scopedCalls).toEqual([
      {
        pluginId: "neon-skin",
        css: ".widget { color: rgb(1, 2, 3); }",
        styleKey: "styles/widget.css",
      },
    ]);
    expect(globalCalls).toEqual([
      {
        pluginId: "neon-skin",
        css: ":root { --qj-bg-app: #101018; } body { font-size: 15px; }",
        styleKey: "styles/skin.global.css",
      },
      {
        pluginId: "neon-skin",
        css: ".app-shell { border-radius: 12px; }",
        styleKey: "styles/EXTRA.GLOBAL.CSS",
      },
    ]);
  });

  it("wraps fallback .global.css in bracket-sanitized @layer plugin-skin without @scope", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "qj-global-css-fallback-"));
    const scopedCssPath = join(tempRoot, "card.css");
    const globalCssPath = join(tempRoot, "theme.global.css");
    const entryPath = join(tempRoot, "client.tsx");

    writeFileSync(scopedCssPath, ".card { padding: 8px; }");
    // Unmatched closing braces and unclosed block comment must be sanitized before wrapping.
    writeFileSync(globalCssPath, "}} :root { --qj-brand-primary: #ff00aa; } /* unclosed");
    writeFileSync(
      entryPath,
      `
        import "./card.css";
        import "./theme.global.css";
        export default function apply() {}
      `,
    );

    const registry = new ClientBundleRegistry();
    const compiled = await registry.compile("skin-fallback", tempRoot, entryPath);

    const mockDom = createMockDocument();
    evaluateBundle(compiled.code, { document: mockDom.document });

    expect(mockDom.styles).toHaveLength(2);
    const scopedEl = mockDom.styles.find((el) => el.getAttribute("data-qj-plugin-style") === "skin-fallback:card.css");
    const globalEl = mockDom.styles.find((el) => el.getAttribute("data-qj-plugin-global-style") === "skin-fallback:theme.global.css");

    expect(scopedEl?.textContent).toContain('@layer plugin-ui { @scope ([data-qj-plugin="skin-fallback"])');
    expect(globalEl?.textContent).toMatch(/^@layer plugin-skin \{\n/);
    expect(globalEl?.textContent).not.toContain("@scope");
    expect(globalEl?.textContent).not.toContain("}}");
    expect(globalEl?.textContent).toContain("/* unclosed*/");
    expect(globalEl?.getAttribute("data-qj-plugin-owner")).toBe("skin-fallback");
  });

  it("tracks .global.css files for HMR cache invalidation and ETag updates", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "qj-global-css-hmr-"));
    const globalCssPath = join(tempRoot, "theme.global.css");
    const entryPath = join(tempRoot, "client.tsx");

    writeFileSync(globalCssPath, ":root { --qj-bg-app: #111111; }");
    writeFileSync(
      entryPath,
      `
        import "./theme.global.css";
        export default function apply() { return "skin-v1"; }
      `,
    );

    const registry = new ClientBundleRegistry();
    const first = await registry.compile("hmr-skin", tempRoot, entryPath);
    const cached = await registry.compile("hmr-skin", tempRoot, entryPath);
    expect(cached.etag).toBe(first.etag);

    // Edit ONLY theme.global.css and advance mtime
    const future = new Date(Date.now() + 5_000);
    writeFileSync(globalCssPath, ":root { --qj-bg-app: #223344; }");
    utimesSync(globalCssPath, future, future);

    const updated = await registry.compile("hmr-skin", tempRoot, entryPath);
    expect(updated.etag).not.toBe(first.etag);
    expect(updated.code).toContain("#223344");
  });

  it("externalizes @qianji/client-slots, @qianji/client-store, and @qianji/client-primitives and exposes core catalogs", async () => {
    expect(CLIENT_SHARED_EXTERNALS).toContain("@qianji/client-slots");
    expect(CLIENT_SHARED_EXTERNALS).toContain("@qianji/client-store");
    expect(CLIENT_SHARED_EXTERNALS).toContain("@qianji/client-primitives");

    tempRoot = mkdtempSync(join(tmpdir(), "qj-client-externals-"));
    const entryPath = join(tempRoot, "client.tsx");
    writeFileSync(
      entryPath,
      `
        import { SlotScope } from "@qianji/client-slots";
        import { storeOf } from "@qianji/client-store";
        import { Button } from "@qianji/client-primitives";
        export default function apply() {
          return { SlotScope, storeOf, Button };
        }
      `,
    );

    const registry = new ClientBundleRegistry();
    const compiled = await registry.compile("ext-check", tempRoot, entryPath);
    expect(compiled.code).toContain('require("@qianji/client-slots")');
    expect(compiled.code).toContain('require("@qianji/client-store")');
    expect(compiled.code).toContain('require("@qianji/client-primitives")');

    // Verify CORE_SLOT_CATALOG tree integrity and FRONTEND_SERVICE_CATALOG completeness
    const slotIds = new Set(CORE_SLOT_CATALOG.map((slot) => slot.id));
    expect(slotIds.has("root")).toBe(true);
    expect(slotIds.has("conversation.composer")).toBe(true);
    expect(slotIds.has("workbench.panes")).toBe(true);
    for (const slot of CORE_SLOT_CATALOG) {
      if (slot.parent !== null) {
        expect(slotIds.has(slot.parent), `parent "${slot.parent}" of slot "${slot.id}" must exist`).toBe(true);
      }
    }

    const serviceNames = new Set(FRONTEND_SERVICE_CATALOG.map((svc) => svc.name));
    for (const expected of [
      "slots",
      "styles",
      "sessionService",
      "workspaceService",
      "composerService",
      "workbenchService",
      "navigationService",
      "themeService",
      "shortcutService",
      "menuService",
      "rpcService",
      "localeService",
      "resourcesService",
    ]) {
      expect(serviceNames.has(expected), `FRONTEND_SERVICE_CATALOG missing "${expected}"`).toBe(true);
    }
  });
});
