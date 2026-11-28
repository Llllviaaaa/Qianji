/**
 * React contexts, `<SessionArea>`, scope/resource/translator hooks, and
 * fault-isolating ErrorBoundaries for `@qianji/client-slots`.
 */
import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ErrorInfo,
  type ReactNode,
} from "react";
import type { Context } from "@deepseek-ai/cordis";
import { clientSlotsRegistry, type SlotRegistry } from "./registry";
import type {
  ResourceValueOf,
  SlotScope,
  SlotScopeTargetMap,
  TranslateFn,
} from "./types";

export interface SlotKernelContextValue {
  readonly registry: SlotRegistry;
  readonly rootCtx?: Context;
}

export interface SlotScopeContextValue {
  readonly sessionId: string | null;
  readonly hasExplicitArea: boolean;
}

export const SlotKernelContext = createContext<SlotKernelContextValue>({
  registry: clientSlotsRegistry,
});

export const SlotScopeContext = createContext<SlotScopeContextValue>({
  sessionId: null,
  hasExplicitArea: false,
});

const NOOP_UNSUB = (): void => undefined;
const NULL_SESSION = (): string | null => null;

export interface SlotKernelProviderProps {
  readonly registry?: SlotRegistry;
  readonly ctx?: Context;
  readonly children?: ReactNode;
}

export function SlotKernelProvider({
  registry = clientSlotsRegistry,
  ctx,
  children,
}: SlotKernelProviderProps): ReactNode {
  const value = useMemo<SlotKernelContextValue>(
    () => (ctx === undefined ? { registry } : { registry, rootCtx: ctx }),
    [registry, ctx],
  );
  return <SlotKernelContext.Provider value={value}>{children}</SlotKernelContext.Provider>;
}

export interface SessionAreaProps {
  readonly sessionId: string | null;
  /** When true, disposes per-slot & per-factory stores bound to `session:<id>` on unmount. */
  readonly disposeStoresOnUnmount?: boolean;
  readonly children?: ReactNode;
}

/** Bind a concrete `sessionId` scope to all descendant `"session"` / `"session-maybe"` slots. */
export function SessionArea({
  sessionId,
  disposeStoresOnUnmount = false,
  children,
}: SessionAreaProps): ReactNode {
  const { registry } = useContext(SlotKernelContext);
  const value = useMemo<SlotScopeContextValue>(
    () => ({ sessionId, hasExplicitArea: true }),
    [sessionId],
  );

  useEffect(() => {
    if (sessionId === null || sessionId === "") return undefined;
    const scopeKey = `session:${sessionId}`;
    const adapter = registry.getScopeAdapter();
    const cleanupAdapter = adapter?.onScopeMount?.(scopeKey, sessionId);
    return () => {
      if (typeof cleanupAdapter === "function") cleanupAdapter();
      if (disposeStoresOnUnmount) {
        registry.stores.disposeScope(scopeKey);
      }
    };
  }, [registry, sessionId, disposeStoresOnUnmount]);

  return <SlotScopeContext.Provider value={value}>{children}</SlotScopeContext.Provider>;
}

export const SessionProvider = SessionArea;

export function useSlotScope(): SlotScopeContextValue {
  return useContext(SlotScopeContext);
}

export interface ResourceServiceLike {
  subscribe?(uri: string, listener: (value: unknown) => void): () => void;
  read?(uri: string): unknown;
}

export interface ResourceCell {
  subscribe(onStoreChange: () => void): () => void;
  getSnapshot(): unknown;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * External-store adapter bridging `resourcesService.subscribe(uri, (value) => void)`
 * and async/sync `resourcesService.read(uri)` into a stable cached snapshot for
 * `useSyncExternalStore` (never returning a `Promise` or triggering `setState` in effects).
 */
export function createResourceCell(
  service: ResourceServiceLike | undefined,
  address: string,
): ResourceCell {
  let cached: unknown = undefined;
  let hasValue = false;

  return {
    getSnapshot: () => cached,
    subscribe(onStoreChange: () => void): () => void {
      if (service === undefined) return NOOP_UNSUB;
      let active = true;
      let receivedFromSubscribe = false;

      const commit = (next: unknown): void => {
        if (!active || isPromiseLike(next)) return;
        if (hasValue && Object.is(cached, next)) return;
        cached = next;
        hasValue = true;
        onStoreChange();
      };

      const offSub =
        typeof service.subscribe === "function"
          ? service.subscribe(address, (value) => {
              receivedFromSubscribe = true;
              commit(value);
            })
          : undefined;

      if (!receivedFromSubscribe && typeof service.read === "function") {
        try {
          const readResult = service.read(address);
          if (isPromiseLike(readResult)) {
            void readResult.then(
              (resolved) => {
                if (!receivedFromSubscribe) {
                  commit(resolved);
                }
              },
              () => undefined,
            );
          } else {
            commit(readResult);
          }
        } catch {
          // Ignore read errors; subscription or subsequent reads may recover.
        }
      }

      return () => {
        active = false;
        if (typeof offSub === "function") offSub();
      };
    },
  };
}

/** Reserved resource protocol hook (`useResource<P>(address)`, ADR 0023 §2.5). */
export function useResource<P extends string = string>(address: string): ResourceValueOf<P> | undefined {
  const { rootCtx } = useContext(SlotKernelContext);
  const cell = useMemo(() => {
    const service = (rootCtx as { get?(name: string): unknown } | undefined)?.get?.("resourcesService") as
      | ResourceServiceLike
      | undefined;
    return createResourceCell(service, address);
  }, [rootCtx, address]);
  return useSyncExternalStore(cell.subscribe, cell.getSnapshot, cell.getSnapshot) as ResourceValueOf<P> | undefined;
}

export function useResolvedScopeTarget(
  registry: SlotRegistry,
  scope: SlotScope,
  explicitSessionId: string | null | undefined,
): SlotScopeTargetMap[SlotScope] | null {
  const area = useContext(SlotScopeContext);
  const adapter = registry.getScopeAdapter();
  const subscribeSession = useCallback(
    (listener: () => void) => adapter?.subscribeActiveSession?.(listener) ?? NOOP_UNSUB,
    [adapter],
  );
  const getAdapterSession = useCallback(
    () => (adapter !== undefined ? adapter.getActiveSessionId() : NULL_SESSION()),
    [adapter],
  );
  const adapterSessionId = useSyncExternalStore(subscribeSession, getAdapterSession, getAdapterSession);

  if (scope === "root") {
    return { scope: "root", scopeKey: "root" };
  }
  const resolvedId = explicitSessionId !== undefined
    ? explicitSessionId
    : area.hasExplicitArea
      ? area.sessionId
      : adapterSessionId;

  if (scope === "session-maybe") {
    return {
      scope: "session-maybe",
      sessionId: resolvedId,
      scopeKey: resolvedId !== null && resolvedId !== "" ? `session:${resolvedId}` : "session:none",
    };
  }
  if (resolvedId === null || resolvedId === "") {
    return null;
  }
  return {
    scope: "session",
    sessionId: resolvedId,
    scopeKey: `session:${resolvedId}`,
  };
}

export function resolveTranslator(ctx: Context | undefined, localeNs: string | undefined): TranslateFn | undefined {
  if (localeNs === undefined) return undefined;
  const localeSvc = (ctx as { get?(name: string): unknown } | undefined)?.get?.("localeService") as
    | { bind?(ns: string): TranslateFn }
    | undefined;
  if (typeof localeSvc?.bind === "function") {
    return localeSvc.bind(localeNs);
  }
  return (key: string) => key;
}

export interface SlotKernelErrorBoundaryProps {
  readonly pluginId: string;
  readonly entryId: string;
  readonly slotKey: string;
  readonly compact?: boolean;
  readonly hasFallbackCandidate?: boolean;
  readonly onCrash?: (error: Error, info: ErrorInfo) => void;
  readonly children: ReactNode;
}

interface SlotKernelErrorBoundaryState {
  readonly error: Error | null;
}

export class SlotKernelErrorBoundary extends Component<
  SlotKernelErrorBoundaryProps,
  SlotKernelErrorBoundaryState
> {
  override state: SlotKernelErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): SlotKernelErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onCrash?.(error, info);
  }

  private readonly handleRetry = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (this.state.error !== null) {
      if (this.props.hasFallbackCandidate === true) {
        return null;
      }
      return (
        <div
          role="alert"
          data-testid={`kernel-slot-error-${this.props.entryId}`}
          data-qj-plugin={this.props.pluginId}
          style={{
            display: this.props.compact ? "inline-flex" : "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
            padding: this.props.compact ? "2px 6px" : "8px 12px",
            borderRadius: "6px",
            fontSize: "12px",
            background: "var(--qj-status-danger-bg, rgba(239, 68, 68, 0.1))",
            color: "var(--qj-status-danger, #dc2626)",
            border: "1px solid var(--qj-status-danger-border, rgba(239, 68, 68, 0.28))",
          }}
        >
          <span>
            槽位异常 ({this.props.pluginId}): {this.state.error.message || "渲染失败"}
          </span>
          <button
            type="button"
            onClick={this.handleRetry}
            style={{
              padding: "2px 8px",
              borderRadius: "4px",
              border: "1px solid currentColor",
              background: "transparent",
              color: "inherit",
              fontSize: "11px",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export interface WrapperErrorBoundaryProps {
  readonly wrapperId: string;
  readonly pluginId: string;
  readonly slotKey: string;
  readonly fallback: ReactNode;
  readonly onCrash?: (error: Error, info: ErrorInfo) => void;
  readonly children: ReactNode;
}

interface WrapperErrorBoundaryState {
  readonly failed: boolean;
}

/** Fault-skipping boundary for `ctx.slots.wrap`: skips the throwing wrapper and renders `fallback` (inner content). */
export class WrapperErrorBoundary extends Component<WrapperErrorBoundaryProps, WrapperErrorBoundaryState> {
  override state: WrapperErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): WrapperErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onCrash?.(error, info);
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}
