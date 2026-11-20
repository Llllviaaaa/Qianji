/**
 * React hooks and public type exports for Qianji's Frontend Cordis Service Mesh
 * (`src/sdk/frontendServices.ts`, ADR 0023 Phase 2).
 *
 * Consumed via `@qianji/client` by both built-in core plugins and external
 * dynamic plugins without exposing raw internal Zustand slices.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  useSafeMode,
  useSlotOverrides,
  type SafeModeReason,
  type SafeModeSnapshot,
} from "../kernel/runtime";
import {
  getStableClientService,
  subscribeClientService,
  useClientContext,
} from "./rootContext";
import type {
  AppearanceCatalog,
  ComposerService,
  ComposerSessionBucket,
  ComposerSnapshot,
  FrontendServiceName,
  HostStatus,
  LocaleBundle,
  LocaleCode,
  LocaleDictionary,
  LocaleService,
  LocaleServiceSnapshot,
  MenuService,
  MenuServiceSnapshot,
  NavigationHubView,
  NavigationRoute,
  NavigationService,
  NavigationSnapshot,
  OpenFileOptions,
  OpenWorkbenchFile,
  PaneDropZone,
  ParsedResourceUri,
  ResolvedMenuItem,
  ResourceProtocolHandler,
  ResourcesService,
  ResourcesServiceSnapshot,
  RetainSessionOptions,
  RpcCallOptions,
  RpcNotificationOptions,
  RpcService,
  RpcServiceSnapshot,
  SessionHandle,
  SessionHandleSnapshot,
  SessionService,
  SessionServiceSnapshot,
  ShortcutContext,
  ShortcutEntry,
  ShortcutRegistration,
  ShortcutService,
  ShortcutServiceSnapshot,
  ThemeService,
  ThemeServiceSnapshot,
  TranscriptDensity,
  TranslateFn,
  TranslateParams,
  WorkbenchService,
  WorkbenchServiceSnapshot,
  WorkbenchSplitDirection,
  WorkbenchTileNode,
  WorkspaceService,
  WorkspaceServiceSnapshot,
  WorkspaceTrustStatus,
} from "../kernel/services";

const NOOP_UNSUB = (): void => undefined;

export { useClientContext };

/** Resolve any mounted frontend Cordis Service by name with referential stability across renders. */
export function useFrontendService<K extends FrontendServiceName>(
  name: K,
  explicitCtx?: Context,
): Context[K] | undefined {
  const ctx = useClientContext(explicitCtx);
  const subscribe = useCallback(
    (listener: () => void) => subscribeClientService(ctx, name, listener),
    [ctx, name],
  );
  const getSnapshot = useCallback(
    () => getStableClientService(ctx, name) as Context[K] | undefined,
    [ctx, name],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

interface SubscribableService<S> {
  getSnapshot(): S;
  subscribe(listener: () => void): () => void;
}

function useServiceSnapshot<S>(service: SubscribableService<S> | undefined): S | undefined {
  const subscribe = useCallback(
    (listener: () => void) => (service === undefined ? NOOP_UNSUB : service.subscribe(listener)),
    [service],
  );
  const getSnapshot = useCallback(
    () => (service === undefined ? undefined : service.getSnapshot()),
    [service],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export interface SessionHandleHookResult {
  readonly handle: SessionHandle | null;
  readonly snapshot: SessionHandleSnapshot | null;
}

const EMPTY_HANDLE_RESULT: SessionHandleHookResult = {
  handle: null,
  snapshot: null,
};

interface SessionHandleCell {
  subscribe(onStoreChange: () => void): () => void;
  getSnapshot(): SessionHandleHookResult;
  getServerSnapshot(): SessionHandleHookResult;
}

function createSessionHandleCell(
  service: SessionService | undefined,
  sessionId: string | null | undefined,
  options: RetainSessionOptions | undefined,
): SessionHandleCell {
  let state: SessionHandleHookResult = EMPTY_HANDLE_RESULT;
  const trimmedId = typeof sessionId === "string" ? sessionId.trim() : "";

  return {
    getSnapshot: () => state,
    getServerSnapshot: () => EMPTY_HANDLE_RESULT,
    subscribe(onStoreChange: () => void): () => void {
      if (service === undefined || trimmedId === "") {
        return NOOP_UNSUB;
      }
      const handle = service.retain(trimmedId, options);
      state = { handle, snapshot: handle.getSnapshot() };
      onStoreChange();

      const off = handle.subscribe(() => {
        const nextSnap = handle.getSnapshot();
        if (nextSnap !== state.snapshot) {
          state = { handle, snapshot: nextSnap };
          onStoreChange();
        }
      });

      return () => {
        off();
        handle.release();
        state = EMPTY_HANDLE_RESULT;
      };
    },
  };
}

/** Reactive snapshot of `sessionService` (active session, full messages, streaming, catalog, tree). */
export function useSessionState(explicitCtx?: Context): SessionServiceSnapshot | undefined {
  return useServiceSnapshot(useFrontendService("sessionService", explicitCtx));
}

/**
 * Retain a ref-counted multi-session `SessionHandle` bound to this component's
 * mount lifecycle via `useSyncExternalStore` (auto-released on unmount or sessionId change).
 */
export function useSessionHandle(
  sessionId: string | null | undefined,
  options?: RetainSessionOptions,
  explicitCtx?: Context,
): SessionHandleHookResult {
  const service = useFrontendService("sessionService", explicitCtx);
  const cwd = options?.cwd;
  const parentSessionFile = options?.parentSessionFile;
  const isolated = options?.isolated;
  const autoStart = options?.autoStart;
  const initialMessages = options?.initialMessages;
  const model = options?.model;
  const thinkingLevel = options?.thinkingLevel;
  const permissionMode = options?.permissionMode;
  const agentMode = options?.agentMode;

  const hasOptions = options !== undefined;
  const stableOptions = useMemo<RetainSessionOptions | undefined>(
    () =>
      hasOptions
        ? {
            ...(cwd === undefined ? {} : { cwd }),
            ...(parentSessionFile === undefined ? {} : { parentSessionFile }),
            ...(isolated === undefined ? {} : { isolated }),
            ...(autoStart === undefined ? {} : { autoStart }),
            ...(initialMessages === undefined ? {} : { initialMessages }),
            ...(model === undefined ? {} : { model }),
            ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
            ...(permissionMode === undefined ? {} : { permissionMode }),
            ...(agentMode === undefined ? {} : { agentMode }),
          }
        : undefined,
    [
      hasOptions,
      cwd,
      parentSessionFile,
      isolated,
      autoStart,
      initialMessages,
      model,
      thinkingLevel,
      permissionMode,
      agentMode,
    ],
  );

  const cell = useMemo(
    () => createSessionHandleCell(service, sessionId, stableOptions),
    [service, sessionId, stableOptions],
  );
  return useSyncExternalStore(cell.subscribe, cell.getSnapshot, cell.getServerSnapshot);
}

/** Reactive snapshot of `workspaceService` (cwd, git, workspace trust, project list). */
export function useWorkspaceState(explicitCtx?: Context): WorkspaceServiceSnapshot | undefined {
  return useServiceSnapshot(useFrontendService("workspaceService", explicitCtx));
}

/** Reactive snapshot of `composerService` (per-session draft, prefill, attachments, queues, interceptors). */
export function useComposerState(
  sessionKey?: string,
  explicitCtx?: Context,
): ComposerSnapshot | undefined {
  const service = useFrontendService("composerService", explicitCtx);
  const subscribe = useCallback(
    (listener: () => void) => (service === undefined ? NOOP_UNSUB : service.subscribe(listener)),
    [service],
  );
  const getSnapshot = useCallback(
    () => (service === undefined ? undefined : service.getSnapshot(sessionKey)),
    [service, sessionKey],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Reactive snapshot of `workbenchService` (tiling layout tree, panes, open files, bottom drawer). */
export function useWorkbenchState(explicitCtx?: Context): WorkbenchServiceSnapshot | undefined {
  return useServiceSnapshot(useFrontendService("workbenchService", explicitCtx));
}

/** Reactive snapshot of `navigationService` (active route, history, settings, sidebar, toasts, notifications). */
export function useNavigationState(explicitCtx?: Context): NavigationSnapshot | undefined {
  return useServiceSnapshot(useFrontendService("navigationService", explicitCtx));
}

/** Reactive snapshot of `themeService` (merged appearance catalog, scheme, accent, UI scale, density). */
export function useThemeState(explicitCtx?: Context): ThemeServiceSnapshot | undefined {
  return useServiceSnapshot(useFrontendService("themeService", explicitCtx));
}

/** Reactive snapshot of `shortcutService` (registered global keybindings). */
export function useShortcutsState(explicitCtx?: Context): ShortcutServiceSnapshot | undefined {
  return useServiceSnapshot(useFrontendService("shortcutService", explicitCtx));
}

/** Reactive snapshot of `menuService` (all menu locations & registered items). */
export function useMenusState(explicitCtx?: Context): MenuServiceSnapshot | undefined {
  return useServiceSnapshot(useFrontendService("menuService", explicitCtx));
}

/** Reactive snapshot of `rpcService` (Harness Host connection status & reconnect count). */
export function useRpcState(explicitCtx?: Context): RpcServiceSnapshot | undefined {
  return useServiceSnapshot(useFrontendService("rpcService", explicitCtx));
}

/** Reactive snapshot of `localeService` (active locale, fallback locale, registered namespaces). */
export function useLocaleState(explicitCtx?: Context): LocaleServiceSnapshot | undefined {
  return useServiceSnapshot(useFrontendService("localeService", explicitCtx));
}

/** Reactive snapshot of `resourcesService` (registered resource URI schemes). */
export function useResourcesState(explicitCtx?: Context): ResourcesServiceSnapshot | undefined {
  return useServiceSnapshot(useFrontendService("resourcesService", explicitCtx));
}

export { useSafeMode, useSlotOverrides };

export type {
  AppearanceCatalog,
  ComposerService,
  ComposerSessionBucket,
  ComposerSnapshot,
  FrontendServiceName,
  HostStatus,
  LocaleBundle,
  LocaleCode,
  LocaleDictionary,
  LocaleService,
  LocaleServiceSnapshot,
  MenuService,
  MenuServiceSnapshot,
  NavigationHubView,
  NavigationRoute,
  NavigationService,
  NavigationSnapshot,
  OpenFileOptions,
  OpenWorkbenchFile,
  PaneDropZone,
  ParsedResourceUri,
  ResolvedMenuItem,
  ResourceProtocolHandler,
  ResourcesService,
  ResourcesServiceSnapshot,
  RetainSessionOptions,
  RpcCallOptions,
  RpcNotificationOptions,
  RpcService,
  RpcServiceSnapshot,
  SafeModeReason,
  SafeModeSnapshot,
  SessionHandle,
  SessionHandleSnapshot,
  SessionService,
  SessionServiceSnapshot,
  ShortcutContext,
  ShortcutEntry,
  ShortcutRegistration,
  ShortcutService,
  ShortcutServiceSnapshot,
  ThemeService,
  ThemeServiceSnapshot,
  TranscriptDensity,
  TranslateFn,
  TranslateParams,
  WorkbenchService,
  WorkbenchServiceSnapshot,
  WorkbenchSplitDirection,
  WorkbenchTileNode,
  WorkspaceService,
  WorkspaceServiceSnapshot,
  WorkspaceTrustStatus,
};
