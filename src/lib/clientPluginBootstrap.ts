/**
 * Unified self-owned client plugin bootstrap (`src/lib/clientPluginBootstrap.ts`).
 *
 * Replaces `src/dsh-host/client-plugins.ts` and `src/dsh-host/boot.ts` with a
 * single lightweight Cordis root context (`pidClientRoot`) wired directly to
 * `ClientContributionService` and `createClientPluginRuntime`.
 */
import { Context, type Plugin } from "@deepseek-ai/cordis";
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
  installIntelligentUiAutoOpenSync,
  registerHostComponentFactories,
} from "../kernel/primitives/hostComponentFactories";
import {
  createBuiltinCorePluginCoordinator,
  createSafeModeGatedTransport,
  installPluginStyleGlobals,
  safeModeController,
  setBuiltinFeatureCoordinatorActive,
  setPluginTier,
  type BuiltinCorePluginCoordinator,
  type BuiltinCorePluginDescriptor,
} from "../kernel/runtime";
import { DEFAULT_BUILTIN_CLIENT_PLUGINS } from "../kernel/runtime/registerDefaultBuiltinPlugins";
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
import { pluginClient } from "./pluginClient";
import { DiagramBlock } from "../components/DiagramBlock";
import { qianjiClientSdk } from "../sdk";
import { bindClientRootContext } from "../sdk/rootContext";
import { useAppStore } from "../store";
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

function mergeInitialBuiltinDescriptors(): BuiltinCorePluginDescriptor[] {
  const byId = new Map<string, BuiltinCorePluginDescriptor>();
  for (const desc of DEFAULT_BUILTIN_CLIENT_PLUGINS) {
    byId.set(desc.id, desc);
  }
  for (const desc of pendingBuiltinDescriptors) {
    byId.set(desc.id, desc);
  }
  return [...byId.values()];
}

export function ensureClientPluginRuntime(): ClientPluginRuntimeHandle {
  if (singletonRuntime !== undefined) return singletonRuntime;
  installPluginStyleGlobals();
  safeModeController.install();
  if (typeof window !== "undefined") {
    window.__qianjiDiagramComponent = DiagramBlock;
  }
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
  registerHostComponentFactories(clientSlotsRegistry);
  const stopIntelligentUiSync = installIntelligentUiAutoOpenSync();
  clientSlotsRegistry.abdication.onAbdicate((record) => {
    // When built-in `core-shell` is mounted, its own `ctx.slots.onAbdicate` handler
    // emits the user-facing toast; keep this fallback active when `core-shell` is
    // overridden or unloaded so abdication is always surfaced.
    if (singletonBuiltinCoordinator?.getMountedIds().includes("core-shell") === true) {
      return;
    }
    const fallbackNote = record.fallbackPluginId === undefined ? "" : `，已回退至 ${record.fallbackPluginId}`;
    useAppStore.getState().showToast(`插件 "${record.pluginId}" 槽位 ${record.slotKey} 渲染异常${fallbackNote}`, "warning");
  });
  singletonRoot = root;
  singletonBuiltinCoordinator = createBuiltinCorePluginCoordinator(root, {
    transport: rawHostPluginTransport,
    safeMode: safeModeController,
    descriptors: mergeInitialBuiltinDescriptors(),
  });
  // Mount all Vite-bundled builtin core & feature Fibers immediately for zero-latency cold start,
  // then let the background transport sync reconcile against Host plugin state & user overrides.
  const immediateBuiltinReady = singletonBuiltinCoordinator.sync({ fetchList: false }).then(() => {
    setBuiltinFeatureCoordinatorActive(true);
  });
  singletonServicesReady = Promise.all([...coreFibers, frontendServicesReady, immediateBuiltinReady]).then(
    () => undefined,
  );
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
      stopIntelligentUiSync();
      setBuiltinFeatureCoordinatorActive(false);
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
