import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { Context, Service } from "@deepseek-ai/cordis";
import { AgentLoop } from "@qianji/agent-loop";
import type { PluginInfo } from "@qianji/protocol";
import type { RpcHandler, RpcService } from "@qianji/rpc";
import { corePlugins } from "../packages/host/src/agent-plugins.ts";
import { createHost } from "../packages/host/src/host.ts";
import { PluginManager } from "../packages/host/src/plugin-manager.ts";
import { verifyPluginDirectory } from "../packages/host/src/plugin-verify.ts";
import { generatePluginTypes } from "../scripts/generate-plugin-types.mjs";
import {
  CORE_EXTENSION_SET,
  isBundledFeaturePlugin,
} from "../src/components/plugins/pluginHelpers.tsx";
import {
  ClientContributionRegistry,
  ClientContributionService,
  ClientStylesService,
} from "../src/lib/clientContributions.ts";
import { useBuiltinPluginGatesStore } from "../src/stores/builtinPluginGatesStore.ts";
import goalTrackerClient from "../plugins/goal-tracker/client.tsx";
import quickPromptsClient from "../plugins/quick-prompts/client.tsx";
import messageActionsClient from "../plugins/message-actions/client.tsx";
import codeReviewClient from "../plugins/code-review/client.tsx";
import webPreviewClient from "../plugins/web-preview/client.tsx";
import diagramViewerClient from "../plugins/diagram-viewer/client.tsx";
import sideChatClient from "../plugins/side-chat/client.tsx";

const REPO_ROOT = resolve(__dirname, "..");
const PLUGINS_ROOT = resolve(REPO_ROOT, "plugins");

const EXPECTED_BUNDLED_PLUGIN_IDS = [
  "smart-rewind",
  "session-usage",
  "observability",
  "goal-tracker",
  "quick-prompts",
  "message-actions",
  "code-review",
  "web-preview",
  "diagram-viewer",
  "side-chat",
] as const;

interface MockStyleNode {
  tagName: string;
  textContent: string;
  isConnected: boolean;
  attributes: Map<string, string>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  remove(): void;
}

function installMockDom() {
  const headChildren: MockStyleNode[] = [];
  const head = {
    children: headChildren,
    appendChild(node: MockStyleNode) {
      if (!headChildren.includes(node)) headChildren.push(node);
      node.isConnected = true;
      return node;
    },
    querySelector(selector: string): MockStyleNode | null {
      const m = /^style\[data-qj-plugin-style="([^"]+)"\]$/.exec(selector);
      if (!m) return null;
      return headChildren.find((item) => item.attributes.get("data-qj-plugin-style") === m[1]) ?? null;
    },
  };
  const mockDoc = {
    head,
    createElement(tag: string): MockStyleNode {
      const attrs = new Map<string, string>();
      const node: MockStyleNode = {
        tagName: tag.toUpperCase(),
        textContent: "",
        isConnected: false,
        attributes: attrs,
        setAttribute(k, v) {
          attrs.set(k, v);
        },
        getAttribute(k) {
          return attrs.get(k) ?? null;
        },
        remove() {
          node.isConnected = false;
          const idx = headChildren.indexOf(node);
          if (idx >= 0) headChildren.splice(idx, 1);
        },
      };
      return node;
    },
  };

  const prevDoc = (globalThis as Record<string, unknown>).document;
  const prevWin = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).document = mockDoc;
  if (prevWin === undefined) {
    (globalThis as Record<string, unknown>).window = {
      location: { href: "http://localhost/" },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    };
  }

  return () => {
    if (prevDoc === undefined) delete (globalThis as Record<string, unknown>).document;
    else (globalThis as Record<string, unknown>).document = prevDoc;
    if (prevWin === undefined) delete (globalThis as Record<string, unknown>).window;
    else (globalThis as Record<string, unknown>).window = prevWin;
  };
}

function makePluginInfo(overrides: Partial<PluginInfo> & Pick<PluginInfo, "id">): PluginInfo {
  return {
    name: overrides.id,
    version: "0.1.0",
    tier: "builtin",
    status: "active",
    enabled: true,
    removable: false,
    overridesBuiltin: false,
    watch: false,
    hasHost: false,
    hasClient: true,
    canDisable: true,
    ...overrides,
  };
}

describe("Official bundled feature plugins suite", () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    while (disposers.length > 0) {
      disposers.pop()?.();
    }
    useBuiltinPluginGatesStore.getState().resetBuiltinPluginGates();
  });

  it("verifies manifest, Host compile, Client bundle compile, and offline plugin-types check for all 10 bundled plugins", async () => {
    const pluginDirs = readdirSync(PLUGINS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    for (const id of EXPECTED_BUNDLED_PLUGIN_IDS) {
      expect(pluginDirs).toContain(id);
    }

    const tempBase = mkdtempSync(join(tmpdir(), "qj-all-bundled-"));
    const typesDir = join(tempBase, "plugin-types");
    disposers.push(() => rmSync(tempBase, { recursive: true, force: true }));
    generatePluginTypes({ targetDir: typesDir });

    const nodeTypesDir = join(REPO_ROOT, "node_modules", "@types");

    for (const id of EXPECTED_BUNDLED_PLUGIN_IDS) {
      const dir = join(PLUGINS_ROOT, id);
      const report = await verifyPluginDirectory(dir);
      expect(report.errors, `${id} verifyPluginDirectory errors`).toEqual([]);
      expect(report.ok, `${id} verifyPluginDirectory ok`).toBe(true);
      expect(report.pluginId).toBe(id);

      const entryFiles: string[] = [];
      if (existsSync(join(dir, "host.ts"))) entryFiles.push(join(dir, "host.ts").replace(/\\/g, "/"));
      if (existsSync(join(dir, "client.tsx"))) entryFiles.push(join(dir, "client.tsx").replace(/\\/g, "/"));
      expect(entryFiles.length).toBeGreaterThan(0);

      const checkDir = join(tempBase, `check-${id}`);
      mkdirSync(checkDir, { recursive: true });
      const relTypes = relative(checkDir, typesDir).replace(/\\/g, "/");
      const tsconfigPath = join(checkDir, "tsconfig.json");
      writeFileSync(
        tsconfigPath,
        JSON.stringify(
          {
            extends: `${relTypes}/tsconfig.plugin.json`,
            compilerOptions: {
              baseUrl: ".",
              typeRoots: [nodeTypesDir.replace(/\\/g, "/")],
              types: ["node"],
              paths: {
                "react/jsx-runtime": [`${relTypes}/react/jsx-runtime.d.ts`],
                "react/jsx-dev-runtime": [`${relTypes}/react/jsx-dev-runtime.d.ts`],
                "*": [`${relTypes}/*/index.d.ts`, `${relTypes}/*`],
              },
            },
            files: entryFiles,
          },
          null,
          2,
        ),
        "utf8",
      );

      const cfg = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
      expect(cfg.error).toBeUndefined();
      const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, checkDir);
      const program = ts.createProgram(parsed.fileNames, parsed.options);
      const diagnostics = ts.getPreEmitDiagnostics(program);
      const formatted = diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      expect(formatted, `${id} offline tsc errors`).toEqual([]);
    }
  });

  it("loads all bundled plugins in PluginManager, exposes Host tools/commands/RPCs/hooks, and hot-unmounts when disabled", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "qj-pm-bundled-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "qj-ws-bundled-"));
    disposers.push(() => {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    });

    writeFileSync(
      join(workspaceDir, "package.json"),
      JSON.stringify({
        name: "demo-vite-app",
        scripts: { dev: "vite --port 5173", build: "vite build" },
        devDependencies: { vite: "^6.0.0", react: "^19.0.0" },
      }),
      "utf8",
    );

    const handlers = new Map<string, RpcHandler>();
    class TestRpcService extends Service implements RpcService {
      static provide = "rpc";
      constructor(ctx: Context) {
        super(ctx, "rpc");
      }
      method(name: string, handler: RpcHandler): () => void {
        handlers.set(name, handler);
        return () => {
          handlers.delete(name);
        };
      }
      methods(): string[] {
        return ["initialize", ...handlers.keys()];
      }
      broadcast(): void {}
    }

    const host = createHost({
      version: "0.0.0-test",
      dataDir,
      plugins: [...corePlugins(), [AgentLoop], [TestRpcService]],
    });
    await host.start();
    const manager = new PluginManager(host.ctx, {
      dataDir,
      version: "0.0.0-test",
      bundledPluginsDirs: [PLUGINS_ROOT],
    });
    disposers.push(() => {
      void manager.dispose();
      void host.stop();
    });

    await manager.sync();
    const plugins = await manager.list();

    for (const id of EXPECTED_BUNDLED_PLUGIN_IDS) {
      const info = plugins.find((p) => p.id === id);
      expect(info, `plugin ${id} discovered`).toBeDefined();
      expect(info?.tier).toBe("builtin");
      expect(info?.enabled).toBe(true);
      expect(info?.status, `plugin ${id} status (${info?.error ?? "no error"})`).toBe("active");
    }

    const rpcMethods = new Set(host.ctx.rpc.methods());
    expect(rpcMethods.has("goalTracker.get")).toBe(true);
    expect(rpcMethods.has("codeReview.summary")).toBe(true);
    expect(rpcMethods.has("webPreview.detectProject")).toBe(true);
    expect(rpcMethods.has("smartRewind.undoBranch")).toBe(true);
    expect(rpcMethods.has("sessionUsage.inspect")).toBe(true);

    const detectHandler = handlers.get("webPreview.detectProject");
    expect(detectHandler).toBeDefined();
    const detected = await detectHandler?.(
      { cwd: workspaceDir },
      { signal: new AbortController().signal, notify: () => {} },
    ) as { framework?: string; projectName?: string; scripts?: Array<{ name: string; command: string }> } | undefined;
    expect(detected?.framework).toBe("Vite");
    expect(detected?.projectName).toBe("demo-vite-app");
    expect(detected?.scripts).toEqual([{ name: "dev", command: "vite --port 5173" }]);

    // Verify Host tools & commands registered by new bundled plugins
    expect(host.ctx.tools.get("create_goal")).toBeDefined();
    expect(host.ctx.tools.get("get_goal")).toBeDefined();
    expect(host.ctx.tools.get("update_goal")).toBeDefined();
    expect(host.ctx.tools.get("code_review_diff")).toBeDefined();

    const commands = await host.ctx.commands.list(workspaceDir);
    const cmdNames = new Set(commands.map((c) => c.name));
    expect(cmdNames.has("goal")).toBe(true);
    expect(cmdNames.has("review")).toBe(true);
    expect(cmdNames.has("preview")).toBe(true);
    expect(cmdNames.has("rewind")).toBe(true);
    expect(cmdNames.has("usage")).toBe(true);

    // Exercise goal-tracker tools + CAS RPC lifecycle + agent/settled abort pause
    const env = { sessionId: "sess-gt-1", cwd: workspaceDir, signal: new AbortController().signal };
    const createRes = await host.ctx.tools.execute(
      { id: "c1", name: "create_goal", args: { objective: "Finish all plugin tests", token_budget: 50000 } },
      env,
    );
    expect(createRes.isError).not.toBe(true);

    const getRes = await host.ctx.tools.execute({ id: "c2", name: "get_goal", args: {} }, env);
    expect((getRes.content[0] as { text?: string }).text).toContain("Finish all plugin tests");

    const session = host.ctx.sessions.create({ cwd: workspaceDir });
    await host.ctx.tools.execute(
      { id: "c3", name: "create_goal", args: { objective: "Verify DSH goal lifecycle" } },
      { sessionId: session.id, cwd: workspaceDir, signal: new AbortController().signal },
    );

    const getGoalHandler = handlers.get("goalTracker.get");
    const pauseGoalHandler = handlers.get("goalTracker.pause");
    const resumeGoalHandler = handlers.get("goalTracker.resume");
    const editGoalHandler = handlers.get("goalTracker.edit");
    const rpcCtx = { signal: new AbortController().signal, notify: () => {} };

    const snap1 = (await getGoalHandler?.({ sessionId: session.id }, rpcCtx)) as {
      goal: { id: string; revision: number; phase: string; armed: boolean } | null;
    };
    expect(snap1.goal?.phase).toBe("active");
    expect(snap1.goal?.armed).toBe(true);

    const pausedSnap = (await pauseGoalHandler?.(
      { sessionId: session.id, goalId: snap1.goal?.id, revision: snap1.goal?.revision },
      rpcCtx,
    )) as { goal: { id: string; revision: number; phase: string; armed: boolean } | null };
    expect(pausedSnap.goal?.phase).toBe("paused");
    expect(pausedSnap.goal?.armed).toBe(false);

    const resumedSnap = (await resumeGoalHandler?.(
      { sessionId: session.id, goalId: pausedSnap.goal?.id, revision: pausedSnap.goal?.revision },
      rpcCtx,
    )) as { goal: { id: string; revision: number; phase: string; armed: boolean } | null };
    expect(resumedSnap.goal?.phase).toBe("active");
    expect(resumedSnap.goal?.armed).toBe(true);

    const editedSnap = (await editGoalHandler?.(
      {
        sessionId: session.id,
        goalId: resumedSnap.goal?.id,
        revision: resumedSnap.goal?.revision,
        objective: "Verify DSH goal lifecycle v2",
      },
      rpcCtx,
    )) as { goal: { objective: string; phase: string; armed: boolean } | null };
    expect(editedSnap.goal?.objective).toBe("Verify DSH goal lifecycle v2");
    expect(editedSnap.goal?.armed).toBe(true);

    await host.ctx.parallel("agent/settled", session, "aborted");
    const afterAbort = (await getGoalHandler?.({ sessionId: session.id }, rpcCtx)) as {
      goal: { phase: string; armed: boolean } | null;
    };
    expect(afterAbort.goal?.phase).toBe("paused");
    expect(afterAbort.goal?.armed).toBe(false);

    await host.ctx.tools.execute(
      { id: "c4", name: "update_goal", args: { action: "complete", notes: "All passed" } },
      { sessionId: session.id, cwd: workspaceDir, signal: new AbortController().signal },
    );
    const afterComplete = (await getGoalHandler?.({ sessionId: session.id }, rpcCtx)) as {
      goal: { phase: string; armed: boolean } | null;
    };
    expect(afterComplete.goal?.phase).toBe("complete");
    expect(afterComplete.goal?.armed).toBe(false);

    // Verify web-preview project detection command
    const previewCmd = await host.ctx.commands.run("preview", "", {
      sessionId: session.id,
      cwd: workspaceDir,
      signal: new AbortController().signal,
    });
    expect(previewCmd?.output).toContain("Vite");
    expect(previewCmd?.output).toContain("npm run dev");

    // Verify /review command expands review prompt
    const reviewCmd = await host.ctx.commands.run("review", "main", {
      sessionId: session.id,
      cwd: workspaceDir,
      signal: new AbortController().signal,
    });
    expect(reviewCmd?.prompt).toContain("main...HEAD");

    // Toggling goal-tracker off cleanly removes its tools and /goal command
    await manager.setEnabled("goal-tracker", false);
    expect(host.ctx.tools.get("create_goal")).toBeUndefined();
    const afterDisableCmds = await host.ctx.commands.list(workspaceDir);
    expect(afterDisableCmds.some((c) => c.name === "goal")).toBe(false);

    // Re-enabling restores tools and /goal
    await manager.setEnabled("goal-tracker", true);
    expect(host.ctx.tools.get("create_goal")).toBeDefined();
  });

  it("mounts all newly pluginized client modules cleanly into ClientContributionRegistry & gates workbench features", async () => {
    const restoreDom = installMockDom();
    disposers.push(restoreDom);

    const registry = new ClientContributionRegistry();
    const root = new Context();
    await root.plugin(ClientContributionService, registry);
    await root.plugin(ClientStylesService);
    disposers.push(() => {
      void root.fiber.dispose();
    });

    await root.plugin(goalTrackerClient);
    await root.plugin(quickPromptsClient, {});
    await root.plugin(messageActionsClient);
    await root.plugin(codeReviewClient);
    await root.plugin(webPreviewClient);
    await root.plugin(diagramViewerClient);
    await root.plugin(sideChatClient, {});

    const snap = registry.getSnapshot();
    expect(snap.homeQuickActions.map((a) => a.id)).toEqual([
      "quick-prompts:architecture",
      "quick-prompts:bug-hunt",
      "quick-prompts:git-review",
    ]);
    expect(snap.messageActions.some((a) => a.id === "message-actions:assistant")).toBe(true);
    expect(snap.pages.some((p) => p.id === "sites")).toBe(false);
    expect(snap.fileViewers.some((v) => v.id === "diagram-viewer:file")).toBe(true);
    expect(snap.composerBanners.some((b) => b.id === "goal-tracker:banner")).toBe(true);
    expect(snap.keybindings.some((k) => k.id === "side-chat:toggle" && k.key === "Ctrl+Alt+S")).toBe(true);
    expect(snap.menuItems.some((m) => m.id === "code-review:open-panel-tools")).toBe(true);
    expect(snap.menuItems.some((m) => m.id === "web-preview:sites-menu")).toBe(false);
    expect(snap.slashInterceptors.some((s) => s.id === "web-preview:slash")).toBe(true);
    expect(snap.menuItems.some((m) => m.id === "side-chat:thread-menu")).toBe(true);

    // Render client widgets via SSR to ensure zero throw on initial render

    const viewer = snap.fileViewers.find((v) => v.id === "diagram-viewer:file");
    expect(viewer).toBeDefined();
    if (viewer) {
      const html = renderToStaticMarkup(
        createElement(() =>
          viewer.render({
            cwd: "/demo",
            sessionFile: null,
            path: "docs/flow.mmd",
            content: "graph TD; A-->B;",
            isBinary: false,
            size: 18,
          }),
        ),
      );
      expect(html).toContain("Mermaid 图表");
    }

    // Verify plugin classification & builtin gate store synchronization
    expect(CORE_EXTENSION_SET.has("checkpoints")).toBe(true);
    for (const id of EXPECTED_BUNDLED_PLUGIN_IDS) {
      const sample = makePluginInfo({ id, dir: join(PLUGINS_ROOT, id) });
      expect(isBundledFeaturePlugin(sample), `${id} should appear in bundledList`).toBe(true);
    }

    useBuiltinPluginGatesStore.getState().syncFromPluginList([
      makePluginInfo({ id: "code-review", enabled: false, status: "disabled" }),
      makePluginInfo({ id: "web-preview", enabled: false, status: "disabled" }),
      makePluginInfo({ id: "side-chat", enabled: false, status: "disabled" }),
      makePluginInfo({
        id: "diagram-viewer",
        enabled: true,
        status: "active",
        config: { enableMermaid: true, enablePlantUml: false },
      }),
    ]);

    const gates = useBuiltinPluginGatesStore.getState();
    expect(gates.codeReviewEnabled).toBe(false);
    expect(gates.webPreviewEnabled).toBe(false);
    expect(gates.sideChatEnabled).toBe(false);
    expect(gates.diagramViewerEnabled).toBe(true);
    expect(gates.mermaidEnabled).toBe(true);
    expect(gates.plantUmlEnabled).toBe(false);
  });
});
