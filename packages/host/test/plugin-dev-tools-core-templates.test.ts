/**
 * ADR 0023 Phase 6 verification:
 * 1. `qianji_inspect` read-only topics (`slot_tree`, `frontend_services`,
 *    `slot_owners`, `primitives`, and `all`) — schema, payload integrity,
 *    and approval-free execution in `plan` (`read-only`) mode.
 * 2. `plugin_manager(action: "scaffold")` & `scaffoldPluginFiles()` for
 *    `"core-override"` and `"global-skin"` templates:
 *    - `verifyPluginDirectory()` passes with 0 errors and 0 warnings
 *    - `ClientBundleRegistry.compile()` routes `skin.global.css` to
 *      `__qianjiInjectPluginGlobalStyle` (`@layer plugin-skin`, unscoped)
 *    - Programmatic TypeScript `tsc --noEmit` against `generatePluginTypes()`
 *      produces 0 diagnostics
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CLIENT_SLOT_CATALOG,
  CORE_SLOT_CATALOG,
  FRONTEND_SERVICE_CATALOG,
} from "@qianji/protocol";
import { builtinPluginDefinitions, corePlugins } from "../src/agent-plugins.ts";
import { ClientBundleRegistry } from "../src/client-bundles.ts";
import { readEffectiveHarnessConfig } from "../src/harness-config.ts";
import { createHost, type Host } from "../src/host.ts";
import {
  scaffoldPluginFiles,
  verifyPluginDirectory,
  type InspectTopic,
} from "../src/plugin-dev-tools.ts";
import { PluginManager } from "../src/plugin-manager.ts";
import { generatePluginTypes } from "../../../scripts/generate-plugin-types.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function runProgrammaticTypecheck(projectDir: string): string[] {
  const configPath = join(projectDir, "tsconfig.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error !== undefined) {
    return [ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")];
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, projectDir);
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true },
  });
  return ts.getPreEmitDiagnostics(program).map((diag) => {
    const message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
    if (diag.file === undefined || diag.start === undefined) return message;
    const pos = diag.file.getLineAndCharacterOfPosition(diag.start);
    return `${diag.file.fileName}:${pos.line + 1}:${pos.character + 1} - ${message}`;
  });
}

interface TreeNodeShape {
  id: string;
  kind: string;
  scope: string;
  ownerPlugin: string;
  parentSlot: string | null;
  supportsOverlay: boolean;
  summary: string;
  children: TreeNodeShape[];
}

function flattenTree(nodes: readonly TreeNodeShape[]): TreeNodeShape[] {
  const out: TreeNodeShape[] = [];
  for (const node of nodes) {
    out.push(node);
    out.push(...flattenTree(node.children));
  }
  return out;
}

function parseToolJson<T>(result: { content: ReadonlyArray<{ type: string; text?: string }> }): T {
  const first = result.content[0];
  if (first === undefined || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("Expected text tool output");
  }
  return JSON.parse(first.text) as T;
}

describe("ADR 0023 Phase 6: qianji_inspect core topics & core-override/global-skin templates", () => {
  let sharedTypesRoot = "";
  let sharedPluginTypesDir = "";
  let tempRoot = "";
  let host: Host | undefined;
  let manager: PluginManager | undefined;

  beforeAll(() => {
    sharedTypesRoot = mkdtempSync(join(tmpdir(), "qj-phase6-types-"));
    sharedPluginTypesDir = join(sharedTypesRoot, "plugin-types");
    generatePluginTypes({ repoRoot, targetDir: sharedPluginTypesDir });
  });

  afterAll(() => {
    if (sharedTypesRoot !== "") {
      rmSync(sharedTypesRoot, { recursive: true, force: true });
      sharedTypesRoot = "";
    }
  });

  afterEach(async () => {
    await manager?.dispose();
    manager = undefined;
    await host?.stop();
    host = undefined;
    if (tempRoot !== "") {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = "";
    }
  });

  async function bootHostWithDevTools(): Promise<{
    host: Host;
    workspace: string;
    sessionId: string;
  }> {
    tempRoot = mkdtempSync(join(tmpdir(), "qj-phase6-host-"));
    const dataDir = join(tempRoot, "data");
    const workspace = join(tempRoot, "workspace");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });

    const managerRef: { current: PluginManager | undefined } = { current: undefined };
    host = createHost({ version: "0.3.0-test", dataDir, plugins: corePlugins() });
    await host.start();

    manager = new PluginManager(host.ctx, {
      dataDir,
      version: "0.3.0-test",
      builtins: (ws) =>
        builtinPluginDefinitions(dataDir, readEffectiveHarnessConfig(dataDir, ws).config, {
          pluginTypesDir: sharedPluginTypesDir,
          gateway: {
            pageOrigins: [],
            token: Buffer.alloc(32, 3).toString("base64url"),
            manager: () => managerRef.current,
          },
        }),
    });
    managerRef.current = manager;
    await manager.sync();

    const session = await host.ctx.sessions.create({ cwd: workspace });
    return { host, workspace, sessionId: session.id };
  }

  it("exposes slot_tree, frontend_services, slot_owners, and primitives via qianji_inspect in read-only mode", async () => {
    const { host: booted, workspace, sessionId } = await bootHostWithDevTools();
    const session = await booted.ctx.sessions.get(sessionId);
    expect(session).toBeDefined();
    if (session !== undefined) {
      booted.ctx.permissions.set(session, { agentMode: "plan", permission: "ask" });
    }
    const env = { sessionId, cwd: workspace, signal: new AbortController().signal };

    const inspect = async <T>(topic: InspectTopic): Promise<T> => {
      const res = await booted.ctx.tools.execute(
        { id: `inspect-${topic}`, name: "qianji_inspect", args: { topic } },
        env,
      );
      expect(res.isError).not.toBe(true);
      return parseToolJson<T>(res);
    };

    // 1. slot_tree
    const slotTreeRes = await inspect<{
      slotTree: {
        count: number;
        tree: TreeNodeShape[];
        overlaySlots: Array<{ slotKey: string; catalogSlot: string }>;
        legacySlotsCount: number;
        legacyMapping: Array<{ legacySlot: string; mirroredSlot: string; method: string; coreSlots: string[] }>;
      };
    }>("slot_tree");

    expect(slotTreeRes.slotTree.count).toBe(CORE_SLOT_CATALOG.length);
    expect(slotTreeRes.slotTree.tree).toHaveLength(1);
    expect(slotTreeRes.slotTree.tree[0]?.id).toBe("root");
    expect(slotTreeRes.slotTree.tree[0]?.ownerPlugin).toBe("core-shell");
    expect(slotTreeRes.slotTree.tree[0]?.parentSlot).toBeNull();

    const flattened = flattenTree(slotTreeRes.slotTree.tree);
    expect(flattened).toHaveLength(CORE_SLOT_CATALOG.length);
    const composerNode = flattened.find((node) => node.id === "conversation.composer");
    expect(composerNode).toBeDefined();
    expect(composerNode?.kind).toBe("chain");
    expect(composerNode?.scope).toBe("session");
    expect(composerNode?.ownerPlugin).toBe("core-composer");
    expect(composerNode?.parentSlot).toBe("stage.conversation");
    expect(composerNode?.supportsOverlay).toBe(true);
    expect(composerNode?.children.map((c) => c.id)).toEqual([
      "composer.banners",
      "composer.toolbar",
      "composer.status",
    ]);

    expect(slotTreeRes.slotTree.overlaySlots.some((s) => s.slotKey === "composer.main")).toBe(true);
    expect(slotTreeRes.slotTree.legacySlotsCount).toBe(CLIENT_SLOT_CATALOG.length);
    expect(slotTreeRes.slotTree.legacyMapping).toHaveLength(22);
    expect(
      slotTreeRes.slotTree.legacyMapping.find((m) => m.legacySlot === "file.viewer"),
    ).toMatchObject({
      mirroredSlot: "legacy.file.viewer",
      coreSlots: ["workbench.fileViewer"],
    });

    // 2. frontend_services
    const servicesRes = await inspect<{
      frontendServices: {
        count: number;
        domainServiceCount: number;
        services: Array<{ name: string; category: string; methods: string[]; reactiveHooks: string[] }>;
        sharedHooks: string[];
      };
    }>("frontend_services");

    expect(servicesRes.frontendServices.count).toBe(FRONTEND_SERVICE_CATALOG.length);
    expect(servicesRes.frontendServices.domainServiceCount).toBeGreaterThanOrEqual(10);
    const byName = new Map(servicesRes.frontendServices.services.map((svc) => [svc.name, svc]));
    for (const required of [
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
      const entry = byName.get(required);
      expect(entry, `missing frontend service ${required}`).toBeDefined();
      expect((entry?.methods.length ?? 0) > 0).toBe(true);
      expect((entry?.reactiveHooks.length ?? 0) > 0).toBe(true);
    }
    expect(servicesRes.frontendServices.sharedHooks).toContain("useSessionHandle(sessionId, options?, explicitCtx?)");
    expect(servicesRes.frontendServices.sharedHooks).toContain("useSafeMode()");
    expect(servicesRes.frontendServices.sharedHooks).toContain("useSlotOverrides()");

    // 3. slot_owners
    const ownersRes = await inspect<{
      slotOwners: {
        precedence: string;
        electionRules: Array<{ rank: number; rule: string }>;
        abdicationFallback: { unlockCycleKey: string; recoveryTriggers: string[] };
        safeMode: { hotkey: string; macHotkey: string; cliFlag: string; queryParam: string; storageKey: string };
        defaultCoreOwners: Record<string, string>;
      };
    }>("slot_owners");

    expect(ownersRes.slotOwners.precedence).toContain("slotOverrides > workspace > user > builtin > priority");
    expect(ownersRes.slotOwners.electionRules.map((r) => r.rule)).toEqual([
      "slotOverrides",
      "tier: workspace",
      "tier: user",
      "tier: builtin",
      "priority",
      "registrationOrder",
    ]);
    expect(ownersRes.slotOwners.abdicationFallback.unlockCycleKey).toBe("(etag, configKey, reloadEpoch)");
    expect(ownersRes.slotOwners.abdicationFallback.recoveryTriggers.length).toBeGreaterThanOrEqual(3);
    expect(ownersRes.slotOwners.safeMode).toMatchObject({
      hotkey: "Ctrl+Shift+Alt+R",
      macHotkey: "Cmd+Shift+Alt+R",
      cliFlag: "--safe-mode",
      queryParam: "?safeMode=1",
      storageKey: "qianji:safe-mode",
    });
    expect(Object.keys(ownersRes.slotOwners.defaultCoreOwners)).toHaveLength(CORE_SLOT_CATALOG.length);
    expect(ownersRes.slotOwners.defaultCoreOwners.root).toBe("core-shell");
    expect(ownersRes.slotOwners.defaultCoreOwners["conversation.composer"]).toBe("core-composer");

    // 4. primitives
    const primitivesRes = await inspect<{
      primitives: {
        module: string;
        exportCount: number;
        exports: string[];
        components: Array<{ name: string; category: string; summary: string }>;
        slotFactoryCount: number;
        slotFactories: Array<{ key: string; component: string; scope: string; replaceable: boolean }>;
      };
    }>("primitives");

    expect(primitivesRes.primitives.module).toBe("@qianji/client-primitives");
    expect(primitivesRes.primitives.exportCount).toBe(17);
    expect(primitivesRes.primitives.exports).toEqual([
      "Badge",
      "Button",
      "Card",
      "Dialog",
      "DialogSection",
      "IconButton",
      "Input",
      "Markdown",
      "Popover",
      "ScrollArea",
      "Select",
      "Switch",
      "Tabs",
      "TabsContent",
      "TabsList",
      "TabsTrigger",
      "Tooltip",
    ]);
    expect(primitivesRes.primitives.components).toHaveLength(17);
    expect(primitivesRes.primitives.slotFactoryCount).toBe(5);
    expect(primitivesRes.primitives.slotFactories.map((f) => f.key)).toEqual([
      "primitive.markdown",
      "primitive.dialog",
      "primitive.popover",
      "primitive.card",
      "primitive.scrollArea",
    ]);

    // 5. all & theme_tokens include ADR 0023 topics & plugin-skin layer
    const allRes = await inspect<{
      slotTree?: unknown;
      frontendServices?: unknown;
      slotOwners?: unknown;
      primitives?: unknown;
      themeTokens?: { cascadeLayers: string; globalSkinRule: string };
    }>("all");
    expect(allRes.slotTree).toBeDefined();
    expect(allRes.frontendServices).toBeDefined();
    expect(allRes.slotOwners).toBeDefined();
    expect(allRes.primitives).toBeDefined();
    expect(allRes.themeTokens?.cascadeLayers).toContain("components, plugin-skin, utilities");
    expect(allRes.themeTokens?.globalSkinRule).toContain("injectGlobal");

    // 6. invalid topic reports new topics in error hint
    const invalidRes = await booted.ctx.tools.execute(
      { id: "inspect-bad", name: "qianji_inspect", args: { topic: "nonexistent_topic" } },
      env,
    );
    expect(invalidRes.isError).toBe(true);
    const badText = (invalidRes.content[0] as { type: "text"; text: string }).text;
    expect(badText).toContain("slot_tree");
    expect(badText).toContain("frontend_services");
    expect(badText).toContain("slot_owners");
    expect(badText).toContain("primitives");
  });

  it("scaffolds, verifies, bundles, and type-checks core-override and global-skin templates with 0 TS errors", async () => {
    const { host: booted, workspace, sessionId } = await bootHostWithDevTools();
    const session = await booted.ctx.sessions.get(sessionId);
    expect(session).toBeDefined();
    if (session !== undefined) {
      booted.ctx.permissions.set(session, { agentMode: "agent", permission: "full-access" });
    }
    const env = { sessionId, cwd: workspace, signal: new AbortController().signal };

    // Activate plugin_manager and scaffold via the real tool handler
    const activateRes = await booted.ctx.tools.execute(
      { id: "act-dev", name: "activate_tools", args: { names: ["plugin_dev"] } },
      env,
    );
    expect(activateRes.isError).not.toBe(true);

    // 1. core-override via plugin_manager(action: "scaffold")
    const overrideDir = join(workspace, "plugins", "composer-pro");
    const scaffoldOverrideRes = await booted.ctx.tools.execute(
      {
        id: "scaffold-core-override",
        name: "plugin_manager",
        args: {
          action: "scaffold",
          id: "composer-pro",
          name: "Composer Pro",
          template: "core-override",
          dir: overrideDir,
        },
      },
      env,
    );
    expect(scaffoldOverrideRes.isError).not.toBe(true);
    expect(existsSync(join(overrideDir, "package.json"))).toBe(true);
    expect(existsSync(join(overrideDir, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(overrideDir, "client.tsx"))).toBe(true);

    const overrideSource = readFileSync(join(overrideDir, "client.tsx"), "utf8");
    expect(overrideSource).toContain('declare module "@qianji/client-slots"');
    expect(overrideSource).toContain('ctx.slots.register<"composer.main"');
    expect(overrideSource).toContain("overlay: true");
    expect(overrideSource).toContain('from "@qianji/client-primitives"');
    expect(overrideSource).toContain("useComposerState");
    expect(overrideSource).toContain("useSessionState");

    const overrideVerify = await verifyPluginDirectory(overrideDir);
    expect(overrideVerify.errors).toEqual([]);
    expect(overrideVerify.warnings).toEqual([]);
    expect(overrideVerify.ok).toBe(true);
    expect(overrideVerify.hasClient).toBe(true);
    expect((overrideVerify.clientCompiled?.bytes ?? 0) > 100).toBe(true);

    const overrideRegistry = new ClientBundleRegistry();
    const overrideBundle = await overrideRegistry.compile(
      "composer-pro",
      overrideDir,
      join(overrideDir, "client.tsx"),
    );
    expect(overrideBundle.code).toContain('require("@qianji/client")');
    expect(overrideBundle.code).toContain('require("@qianji/client-primitives")');
    expect(overrideBundle.code).toContain('ctx.slots.register("composer.main"');

    const overrideDiagnostics = runProgrammaticTypecheck(overrideDir);
    expect(overrideDiagnostics).toEqual([]);

    // Confirm verifyPluginDirectory catches missing `"slots"` inject on client plugins
    const brokenInjectDir = join(tempRoot, "broken-slots-inject");
    scaffoldPluginFiles({
      pluginId: "broken-slots-inject",
      template: "core-override",
      targetDir: brokenInjectDir,
      pluginTypesDir: sharedPluginTypesDir,
    });
    const brokenSource = readFileSync(join(brokenInjectDir, "client.tsx"), "utf8").replace(
      'export const inject = ["slots", "styles"];',
      'export const inject = ["styles"];',
    );
    writeFileSync(join(brokenInjectDir, "client.tsx"), brokenSource, "utf8");
    const brokenVerify = await verifyPluginDirectory(brokenInjectDir);
    expect(brokenVerify.ok).toBe(false);
    expect(brokenVerify.errors.some((err) => err.includes("slots"))).toBe(true);

    // 2. global-skin via plugin_manager(action: "scaffold")
    const skinDir = join(workspace, "plugins", "midnight-skin");
    const scaffoldSkinRes = await booted.ctx.tools.execute(
      {
        id: "scaffold-global-skin",
        name: "plugin_manager",
        args: {
          action: "scaffold",
          id: "midnight-skin",
          name: "Midnight Skin",
          template: "global-skin",
          dir: skinDir,
        },
      },
      env,
    );
    expect(scaffoldSkinRes.isError).not.toBe(true);
    expect(existsSync(join(skinDir, "package.json"))).toBe(true);
    expect(existsSync(join(skinDir, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(skinDir, "skin.global.css"))).toBe(true);
    expect(existsSync(join(skinDir, "env.d.ts"))).toBe(true);
    expect(existsSync(join(skinDir, "client.tsx"))).toBe(true);

    const skinSource = readFileSync(join(skinDir, "client.tsx"), "utf8");
    expect(skinSource).toContain('import "./skin.global.css"');
    expect(skinSource).toContain("ctx.styles.injectGlobal(");
    expect(skinSource).toContain("ctx.contributions.registerTheme(");
    expect(skinSource).toContain("ctx.effect(");

    const skinVerify = await verifyPluginDirectory(skinDir);
    expect(skinVerify.errors).toEqual([]);
    expect(skinVerify.warnings).toEqual([]);
    expect(skinVerify.ok).toBe(true);
    expect(skinVerify.hasClient).toBe(true);

    // Compile skin client.tsx + skin.global.css via ClientBundleRegistry and verify global style channel
    const skinRegistry = new ClientBundleRegistry();
    const skinBundle = await skinRegistry.compile(
      "midnight-skin",
      skinDir,
      join(skinDir, "client.tsx"),
    );
    expect(skinBundle.code).toContain("__qianjiInjectPluginGlobalStyle");
    expect(skinBundle.code).toContain("@layer plugin-skin");
    expect(skinBundle.code).not.toContain("__qianjiInjectPluginStyle(");

    const globalInjectCalls: Array<{ pluginId: string; css: string; styleKey?: string }> = [];
    const fakeWindow = {
      __ModuleLoader__: {
        load(entry: { id: string; factory: (req: (spec: string) => unknown) => unknown }) {
          entry.factory(() => ({}));
        },
      },
    };
    const fakeGlobalThis = {
      __qianjiInjectPluginGlobalStyle(pluginId: string, css: string, styleKey?: string) {
        globalInjectCalls.push({
          pluginId,
          css,
          ...(styleKey === undefined ? {} : { styleKey }),
        });
      },
    };
    const runner = new Function("window", "globalThis", "document", skinBundle.code) as (
      win: unknown,
      g: unknown,
      doc: unknown,
    ) => void;
    runner(fakeWindow, fakeGlobalThis, undefined);
    expect(globalInjectCalls).toHaveLength(1);
    expect(globalInjectCalls[0]?.pluginId).toBe("midnight-skin");
    expect(globalInjectCalls[0]?.styleKey).toBe("skin.global.css");
    expect(globalInjectCalls[0]?.css).toContain(".app-shell");

    const skinDiagnostics = runProgrammaticTypecheck(skinDir);
    expect(skinDiagnostics).toEqual([]);

    // 3. Invalid template error lists all 5 valid template kinds
    const badTemplateRes = await booted.ctx.tools.execute(
      {
        id: "scaffold-invalid",
        name: "plugin_manager",
        args: { action: "scaffold", id: "bad-tpl", template: "not-a-template" },
      },
      env,
    );
    expect(badTemplateRes.isError).toBe(true);
    const badTplText = (badTemplateRes.content[0] as { type: "text"; text: string }).text;
    expect(badTplText).toContain("core-override");
    expect(badTplText).toContain("global-skin");
  }, 90_000);
});
