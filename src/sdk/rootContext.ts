/**
 * Internal root Cordis `Context` binding shared between
 * `src/lib/clientPluginBootstrap.ts` and `src/sdk/frontendServices.ts`
 * without introducing circular imports.
 */
import { useContext } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { SlotKernelContext } from "../kernel/slots/boundaries";

let boundRootContext: Context | undefined;

interface ContextServiceCache {
  readonly values: Map<string, unknown>;
  readonly listeners: Map<string, Set<() => void>>;
  attached: boolean;
}

const contextServiceCaches = new WeakMap<Context, ContextServiceCache>();

function getOrCreateServiceCache(ctx: Context): ContextServiceCache {
  let cache = contextServiceCaches.get(ctx);
  if (cache === undefined) {
    cache = {
      values: new Map(),
      listeners: new Map(),
      attached: false,
    };
    contextServiceCaches.set(ctx, cache);
  }
  if (!cache.attached && typeof ctx.on === "function") {
    cache.attached = true;
    const activeCache = cache;
    (ctx as { on(event: string, listener: (name: string) => void): () => void }).on(
      "internal/service",
      (changedName: string) => {
        if (typeof changedName !== "string") return;
        const nextValue = ctx.get(changedName);
        if (nextValue === undefined) {
          activeCache.values.delete(changedName);
        } else {
          activeCache.values.set(changedName, nextValue);
        }
        const subs = activeCache.listeners.get(changedName);
        if (subs !== undefined) {
          for (const listener of [...subs]) listener();
        }
      },
    );
  }
  return cache;
}

/**
 * Resolve a Cordis service with referential stability across renders.
 * Cordis 4.x creates a fresh bound Proxy on every `ctx.get(name)` call;
 * caching per `(ctx, name)` and invalidating on `internal/service` prevents
 * `useMemo` / `useSyncExternalStore` thrashing in React hooks.
 */
export function getStableClientService(ctx: Context | undefined, name: string): unknown {
  if (ctx === undefined) return undefined;
  const cache = getOrCreateServiceCache(ctx);
  if (cache.values.has(name)) {
    return cache.values.get(name);
  }
  const current = ctx.get(name);
  if (current !== undefined) {
    cache.values.set(name, current);
  }
  return current;
}

/** Subscribe to Cordis `internal/service` mount/replace/dispose events for `name`. */
export function subscribeClientService(
  ctx: Context | undefined,
  name: string,
  listener: () => void,
): () => void {
  if (ctx === undefined) return () => undefined;
  const cache = getOrCreateServiceCache(ctx);
  let subs = cache.listeners.get(name);
  if (subs === undefined) {
    subs = new Set();
    cache.listeners.set(name, subs);
  }
  subs.add(listener);
  return () => {
    subs.delete(listener);
    if (subs.size === 0) {
      cache.listeners.delete(name);
    }
  };
}

/** Bind the active client microkernel root `Context` during bootstrap. */
export function bindClientRootContext(ctx: Context | undefined): void {
  boundRootContext = ctx;
}

/** Resolve the active client Cordis `Context` (explicit arg > `<SlotKernelProvider>` > booted singleton root). */
export function useClientContext(explicitCtx?: Context): Context | undefined {
  const kernel = useContext(SlotKernelContext);
  return explicitCtx ?? kernel.rootCtx ?? boundRootContext;
}
