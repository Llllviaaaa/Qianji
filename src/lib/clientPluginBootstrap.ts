/**
 * Unified self-owned client plugin bootstrap (`src/lib/clientPluginBootstrap.ts`).
 *
 * Replaces `src/dsh-host/client-plugins.ts` and `src/dsh-host/boot.ts` with a
 * single lightweight Cordis root context (`pidClientRoot`) wired directly to
 * `ClientContributionService` and `createClientPluginRuntime`.
 */
import { createElement } from "react";
import { Context, type Plugin } from "@deepseek-ai/cordis";
import { Layers } from "lucide-react";
import { agent } from "./agent";
import {
  BetterSidebarCompatService,
  betterSidebarCompatModule,
  type LegacyFileViewerDescriptor,
  type LegacySidebarTabDescriptor,
} from "./betterSidebarCompat";
import {
  ClientContributionService,
  ClientStylesService,
  clientContributions,
  useClientContributions,
} from "./clientContributions";
import { registerCorePrimitiveFactories } from "../kernel/primitives/factories";
import {
  createBuiltinCorePluginCoordinator,
  createSafeModeGatedTransport,
  installPluginStyleGlobals,
  safeModeController,
  setPluginTier,
  type BuiltinCorePluginCoordinator,
  type BuiltinCorePluginDescriptor,
} from "../kernel/runtime";
import { installSessionScopeAdapter, registerFrontendServices } from "../kernel/services";
import { ClientSlotsService, clientSlotsRegistry } from "../kernel/slots";
import {
  createClientPluginRuntime,
  type ClientPluginRuntimeHandle,
  type ClientPluginTransport,
  type ModuleLoaderGlobal,
} from "./clientPluginRuntime";
import { harnessRuntimes } from "./harnessRuntime";
import { messageImagesToAttachments, rewindController } from "./rewindController";
import {
  deriveSessionIntelligentUis,
  INTELLIGENT_UI_CANVAS_TAB_ID,
  messageMayContainIntelligentUi,
} from "./intelligentUi";
import { pluginClient } from "./pluginClient";
import { groupTranscriptMessages } from "./transcriptTurns";
import { IntelligentUiCanvasTab } from "../components/workbench/IntelligentUiCanvasTab";
import { DiagramBlock } from "../components/DiagramBlock";
import { qianjiClientSdk } from "../sdk";
import { bindClientRootContext } from "../sdk/rootContext";
import { useAppStore } from "../store";
import { useBuiltinPluginGatesStore } from "../stores/builtinPluginGatesStore";
import { useIntelligentUiStore } from "../stores/intelligentUiStore";
import { useWorkbenchStore } from "../stores/workbenchStore";

declare global {
  interface Window {
    __ModuleLoader__?: ModuleLoaderGlobal;
    __qianjiDiagramComponent?: typeof DiagramBlock;
  }
}

export {
  BetterSidebarCompatService,
  ClientStylesService,
  type BuiltinCorePluginDescriptor,
  type LegacyFileViewerDescriptor,
  type LegacySidebarTabDescriptor,
};

export * from "../sdk";
export {
  clientContributions,
  useClientContributions,
  useWorkbenchStore,
  harnessRuntimes,
  rewindController,
  messageImagesToAttachments,
  agent,
  useAppStore,
};

export const pidClientSdk = qianjiClientSdk;

/** Shared browser singletons exposed via both `ctx.modules.import()` and CJS `require()`. */
export const CLIENT_MODULES: Record<string, () => Promise<unknown>> = {
  "react": () => import("react"),
  "react/jsx-runtime": () => import("react/jsx-runtime"),
  "react/jsx-dev-runtime": async () => {
    const [devMod, prodMod] = await Promise.all([
      import("react/jsx-dev-runtime"),
      import("react/jsx-runtime"),
    ]);
    const devRecord = devMod as Record<string, unknown>;
    if (typeof devRecord.jsxDEV === "function") return devMod;
    const prodRecord = prodMod as {
      Fragment: unknown;
      jsx: (type: unknown, props: unknown, key?: unknown) => unknown;
      jsxs: (type: unknown, props: unknown, key?: unknown) => unknown;
    };
    const jsxDEV = (
      type: unknown,
      props: unknown,
      key?: unknown,
      isStaticChildren?: boolean,
    ) => (isStaticChildren ? prodRecord.jsxs(type, props, key) : prodRecord.jsx(type, props, key));
    return {
      Fragment: prodRecord.Fragment,
      jsxDEV,
      default: { Fragment: prodRecord.Fragment, jsxDEV },
    };
  },
  "react-dom": () => import("react-dom"),
  "react-dom/client": () => import("react-dom/client"),
  "cordis": () => import("@deepseek-ai/cordis"),
  "@deepseek-ai/cordis": () => import("@deepseek-ai/cordis"),
  "schemastery": () => import("@deepseek-ai/schemastery"),
  "@deepseek-ai/schemastery": () => import("@deepseek-ai/schemastery"),
  "@qianji/client": async () => qianjiClientSdk,
  "@qianji/client-slots": () => import("../kernel/slots"),
  "@qianji/client-store": () => import("../kernel/store"),
  "@qianji/client-primitives": () => import("../kernel/primitives"),
  "@qianji/protocol": () => import("@qianji/protocol"),
  "@pid/client": async () => qianjiClientSdk,
  "@pid/protocol": () => import("@qianji/protocol"),
  "dsh-better-sidebar": async () => betterSidebarCompatModule,
  "dsh-better-sidebar/client": async () => betterSidebarCompatModule,
  "lucide-react": () => import("lucide-react"),
};

/** Register an additional shared module specifier (e.g. `@qianji/client-primitives`) before runtime preload. */
export function registerClientModule(specifier: string, loader: () => Promise<unknown>): void {
  CLIENT_MODULES[specifier] = loader;
}

const rawHostPluginTransport: ClientPluginTransport = {
  list: (workspace) => pluginClient.list(workspace),
  clientBundle: (params) => pluginClient.clientBundle(params),
  reportClientError: (params) => pluginClient.reportClientError(params),
  clearClientError: (params) => pluginClient.clearClientError(params),
  onChanged: (listener) => pluginClient.onChanged((payload) => listener(payload)),
  onTrustChanged: (listener) => pluginClient.onTrustChanged(() => listener()),
  onHostReconnect: (listener) => {
    let seenConnected = false;
    return harnessRuntimes.onHostStatus((status) => {
      if (status === "connected") {
        if (seenConnected) listener();
        seenConnected = true;
      }
    });
  },
};

const defaultTransport: ClientPluginTransport = createSafeModeGatedTransport(
  rawHostPluginTransport,
  safeModeController,
  (plugins) => {
    for (const item of plugins) {
      setPluginTier(item.id, item.tier);
    }
  },
);

let singletonRoot: Context | undefined;
let singletonRuntime: ClientPluginRuntimeHandle | undefined;
let singletonBuiltinCoordinator: BuiltinCorePluginCoordinator | undefined;
let singletonServicesReady: Promise<void> | undefined;
const pendingBuiltinDescriptors: BuiltinCorePluginDescriptor[] = [];

/**
 * Register Vite-bundled built-in core/feature client plugins with the microkernel
 * coordinator. Safe to call either before or after `ensureClientPluginRuntime()`.
 */
export function registerBuiltinCorePlugins(
  descriptors: readonly BuiltinCorePluginDescriptor[],
): () => void {
  if (singletonBuiltinCoordinator !== undefined) {
    return singletonBuiltinCoordinator.register(descriptors);
  }
  for (const desc of descriptors) {
    const existingIdx = pendingBuiltinDescriptors.findIndex((item) => item.id === desc.id);
    if (existingIdx >= 0) {
      pendingBuiltinDescriptors[existingIdx] = desc;
    } else {
      pendingBuiltinDescriptors.push(desc);
    }
  }
  const ids = descriptors.map((desc) => desc.id);
  const idSet = new Set(ids);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (let i = pendingBuiltinDescriptors.length - 1; i >= 0; i -= 1) {
      const item = pendingBuiltinDescriptors[i];
      if (item !== undefined && idSet.has(item.id)) {
        pendingBuiltinDescriptors.splice(i, 1);
      }
    }
    singletonBuiltinCoordinator?.unregister(ids);
  };
}

function mountBuiltinIntelligentUiSync(): void {
  let mountedDisposers: Array<() => void> = [];
  let currentWorkspace: string | undefined;

  const applyEnabled = (enabled: boolean) => {
    useIntelligentUiStore.getState().setPluginEnabled(enabled);
    if (enabled) {
      if (mountedDisposers.length > 0) return;
      mountedDisposers = [
        clientContributions.registerRightWorkbenchTab({
          id: INTELLIGENT_UI_CANVAS_TAB_ID,
          label: "画布",
          icon: createElement(Layers, { size: 13 }),
          order: 15,
          render: () => createElement(IntelligentUiCanvasTab),
        }),
      ];
    } else {
      for (const dispose of mountedDisposers) dispose();
      mountedDisposers = [];
      if (useWorkbenchStore.getState().activeTab === INTELLIGENT_UI_CANVAS_TAB_ID) {
        useWorkbenchStore.getState().openTab("files");
      }
    }
  };

  // Mount immediately by default so offline / browser / fixture boots have Intelligent UI ready.
  applyEnabled(true);
  if (typeof window !== "undefined") {
    window.__qianjiDiagramComponent = DiagramBlock;
  }

  const syncFromHost = async () => {
    try {
      const items = await pluginClient.list(currentWorkspace);
      const entry = items.find((item) => item.id === "intelligent-ui");
      if (entry !== undefined) {
        applyEnabled(entry.enabled !== false && entry.status !== "disabled");
      }
      useBuiltinPluginGatesStore.getState().syncFromPluginList(items);
      const gates = useBuiltinPluginGatesStore.getState();
      const wb = useWorkbenchStore.getState();
      if (
        (!gates.codeReviewEnabled && wb.activeTab === "review") ||
        (!gates.webPreviewEnabled && wb.activeTab === "preview") ||
        (!gates.sideChatEnabled && wb.activeTab === "side-chat")
      ) {
        wb.openTab("files");
      }
    } catch {
      // Keep current state when host is not yet connected or running in browser mode.
    }
  };

  void syncFromHost();
  pluginClient.onChanged(() => {
    void syncFromHost();
  });
  harnessRuntimes.onHostStatus((status) => {
    if (status === "connected") {
      void syncFromHost();
    }
  });
  const MAX_SEEN_HTML_ARTIFACTS = 512;
  const seenHtmlArtifacts = new Set<string>();
  const rememberSeenArtifact = (key: string) => {
    if (seenHtmlArtifacts.size >= MAX_SEEN_HTML_ARTIFACTS) {
      const oldest = seenHtmlArtifacts.values().next().value;
      if (oldest !== undefined) seenHtmlArtifacts.delete(oldest);
    }
    seenHtmlArtifacts.add(key);
  };
  const initial = useAppStore.getState();
  let hydratedSessionKey: string | null = initial.messages.length > 0
    ? (initial.sessionFile ?? "__draft__")
    : null;

  useAppStore.subscribe((state, prev) => {
    if (state.cwd !== prev.cwd) {
      currentWorkspace = state.cwd || undefined;
      void syncFromHost();
    }
    if (state.messages !== prev.messages || state.sessionFile !== prev.sessionFile) {
      if (state.sessionFile !== prev.sessionFile && state.messages.length === 0) {
        hydratedSessionKey = null;
      }
      if (!useIntelligentUiStore.getState().pluginEnabled) return;
      if (state.messages.length === 0) return;

      const sessionKey = state.sessionFile ?? "__draft__";
      const sameHydratedSession = hydratedSessionKey === sessionKey;
      const isIdleSessionHydration = !sameHydratedSession && !state.isStreaming;
      hydratedSessionKey = sessionKey;

      // Fast path during 32ms streaming updates: if all prior messages are referentially identical
      // and the tail message carries neither `render_ui`/`update_ui` nor an `intelligent-ui` fence, skip full derivation.
      if (
        sameHydratedSession
        && state.sessionFile === prev.sessionFile
        && prev.messages.length > 0
        && state.messages.length >= prev.messages.length
        && state.messages.length - prev.messages.length <= 1
      ) {
        const prefixEnd = state.messages.length === prev.messages.length
          ? prev.messages.length - 1
          : prev.messages.length;
        let prefixUnchanged = true;
        for (let i = 0; i < prefixEnd; i += 1) {
          if (state.messages[i] !== prev.messages[i]) {
            prefixUnchanged = false;
            break;
          }
        }
        const tail = state.messages[state.messages.length - 1];
        if (prefixUnchanged && !messageMayContainIntelligentUi(tail)) return;
      }

      const summary = deriveSessionIntelligentUis(groupTranscriptMessages(state.messages));
      for (const grp of summary.orderedGroups) {
        if (grp.latest.engine !== "html") continue;
        const key = `${state.sessionFile ?? "draft"}::${grp.id}::v${grp.latest.version}`;
        if (!seenHtmlArtifacts.has(key)) {
          rememberSeenArtifact(key);
          if (!isIdleSessionHydration) {
            useIntelligentUiStore.getState().openInCanvas(grp.id, grp.latest.version);
          }
        }
      }
    }
  });
}

export function ensureClientPluginRuntime(): ClientPluginRuntimeHandle {
  if (singletonRuntime !== undefined) return singletonRuntime;
  installPluginStyleGlobals();
  safeModeController.install();
  const root = new Context();
  bindClientRootContext(root);
  const coreFibers = [
    root.plugin(ClientSlotsService, clientSlotsRegistry),
    root.plugin(ClientContributionService, clientContributions),
    root.plugin(ClientStylesService),
    root.plugin(BetterSidebarCompatService, clientContributions),
  ];
  const frontendServicesReady = registerFrontendServices(root, { contributionRegistry: clientContributions });
  installSessionScopeAdapter(root);
  registerCorePrimitiveFactories(clientSlotsRegistry);
  singletonServicesReady = Promise.all([...coreFibers, frontendServicesReady]).then(() => undefined);
  clientSlotsRegistry.abdication.onAbdicate((record) => {
    const fallbackNote = record.fallbackPluginId === undefined ? "" : `，已回退至 ${record.fallbackPluginId}`;
    useAppStore.getState().showToast(`插件 "${record.pluginId}" 槽位 ${record.slotKey} 渲染异常${fallbackNote}`, "warning");
  });
  mountBuiltinIntelligentUiSync();
  singletonRoot = root;
  singletonBuiltinCoordinator = createBuiltinCorePluginCoordinator(root, {
    transport: rawHostPluginTransport,
    safeMode: safeModeController,
    descriptors: pendingBuiltinDescriptors,
  });
  const baseRuntime = createClientPluginRuntime<Plugin>(root, {
    transport: defaultTransport,
    modules: CLIENT_MODULES,
  });
  singletonRuntime = {
    setWorkspace(workspace) {
      singletonBuiltinCoordinator?.setWorkspace(workspace);
      baseRuntime.setWorkspace(workspace);
    },
    async sync() {
      await Promise.all([
        baseRuntime.sync(),
        singletonBuiltinCoordinator?.sync() ?? Promise.resolve(),
      ]);
    },
    async dispose() {
      await singletonBuiltinCoordinator?.dispose();
      await baseRuntime.dispose();
    },
  };
  return singletonRuntime;
}

export function getClientRootContext(): Context | undefined {
  return singletonRoot;
}

export function getBuiltinCorePluginCoordinator(): BuiltinCorePluginCoordinator | undefined {
  return singletonBuiltinCoordinator;
}

export function whenClientPluginServicesReady(): Promise<void> {
  return singletonServicesReady ?? Promise.resolve();
}
