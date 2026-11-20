/**
 * Managed per-slot and per-factory-occurrence Store seat lifecycle
 * (`@qianji/client-store`, ADR 0023 §2.4).
 *
 * Each slot registration or factory definition may attach a `StoreDecl`.
 * Seats are lazily created per `(entryId, scopeKey)` (for slots) or
 * `(factoryKey, occurrenceKey, scopeKey)` (for factory occurrences) and
 * automatically disposed when the owning registration, scope, or retained
 * factory occurrence tears down.
 */
import { useSyncExternalStore } from "react";

export interface StoreCreateContext<TProps = unknown> {
  readonly entryId: string;
  readonly slotKey: string;
  readonly scopeKey: string;
  readonly occurrenceKey?: string;
  readonly props: TProps;
  /** Register a cleanup hook invoked automatically when this store seat disposes. */
  onDispose(cleanup: () => void): () => void;
}

export interface StoreDeclObject<S = unknown, TProps = unknown> {
  create(ctx: StoreCreateContext<TProps>): S;
  dispose?(store: S, ctx: StoreCreateContext<TProps>): void;
}

export type StoreDecl<S = unknown, TProps = unknown> =
  | StoreDeclObject<S, TProps>
  | ((ctx: StoreCreateContext<TProps>) => S);

export interface ReactiveStore<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(listener: () => void): () => void;
}

/** Lightweight reactive value cell usable inside any `StoreDecl` without importing Zustand. */
export function createReactiveStore<T>(initialValue: T): ReactiveStore<T> {
  let value = initialValue;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      const resolved = typeof next === "function" ? (next as (prev: T) => T)(value) : next;
      if (Object.is(resolved, value)) return;
      value = resolved;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Subscribe a React component to a `ReactiveStore<T>` safely across SSR and CSR. */
export function useStoreValue<T>(store: ReactiveStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export interface RetainedFactoryStore<S = unknown> {
  readonly store: S;
  readonly factoryKey: string;
  readonly occurrenceKey: string;
  readonly scopeKey: string;
  release(): void;
}

export class StoreSeatError extends Error {
  readonly targetId: string;

  constructor(targetId: string, message: string) {
    super(message);
    this.name = "StoreSeatError";
    this.targetId = targetId;
  }
}

interface NormalizedStoreDecl<S = unknown, TProps = unknown> {
  create(ctx: StoreCreateContext<TProps>): S;
  dispose?(store: S, ctx: StoreCreateContext<TProps>): void;
}

function normalizeStoreDecl<S, TProps>(decl: StoreDecl<S, TProps>): NormalizedStoreDecl<S, TProps> {
  if (typeof decl === "function") {
    return { create: decl };
  }
  return decl;
}

interface LiveSeat {
  readonly entryId: string;
  readonly slotKey: string;
  readonly scopeKey: string;
  readonly occurrenceKey?: string;
  readonly store: unknown;
  readonly decl: NormalizedStoreDecl;
  readonly ctx: StoreCreateContext;
  readonly cleanups: Set<() => void>;
  refCount: number;
  disposed: boolean;
}

interface RegisteredEntryDecl {
  readonly entryId: string;
  readonly slotKey: string;
  readonly decl: NormalizedStoreDecl;
}

function slotSeatKey(entryId: string, scopeKey: string): string {
  return `${entryId}\u0000${scopeKey}`;
}

function factorySeatKey(factoryKey: string, occurrenceKey: string, scopeKey: string): string {
  return `${factoryKey}\u0000${occurrenceKey}\u0000${scopeKey}`;
}

function createLiveSeat(params: {
  entryId: string;
  slotKey: string;
  scopeKey: string;
  occurrenceKey?: string;
  props: unknown;
  decl: NormalizedStoreDecl;
}): LiveSeat {
  const cleanups = new Set<() => void>();
  const ctx: StoreCreateContext = {
    entryId: params.entryId,
    slotKey: params.slotKey,
    scopeKey: params.scopeKey,
    ...(params.occurrenceKey === undefined ? {} : { occurrenceKey: params.occurrenceKey }),
    props: params.props,
    onDispose(cleanup: () => void): () => void {
      cleanups.add(cleanup);
      return () => {
        cleanups.delete(cleanup);
      };
    },
  };
  const store = params.decl.create(ctx);
  return {
    entryId: params.entryId,
    slotKey: params.slotKey,
    scopeKey: params.scopeKey,
    ...(params.occurrenceKey === undefined ? {} : { occurrenceKey: params.occurrenceKey }),
    store,
    decl: params.decl,
    ctx,
    cleanups,
    refCount: 0,
    disposed: false,
  };
}

function disposeSeat(seat: LiveSeat): void {
  if (seat.disposed) return;
  seat.disposed = true;
  const hooks = [...seat.cleanups].reverse();
  seat.cleanups.clear();
  for (const cleanup of hooks) {
    try {
      cleanup();
    } catch (error) {
      console.error(`[qianji-client-store] cleanup failed for "${seat.entryId}" (${seat.scopeKey}):`, error);
    }
  }
  if (typeof seat.decl.dispose === "function") {
    try {
      seat.decl.dispose(seat.store, seat.ctx);
    } catch (error) {
      console.error(`[qianji-client-store] dispose() failed for "${seat.entryId}" (${seat.scopeKey}):`, error);
    }
  }
}

export class SlotStoreRegistry {
  private readonly entryDecls = new Map<string, RegisteredEntryDecl>();
  private readonly factoryDecls = new Map<string, NormalizedStoreDecl>();
  private readonly entrySeats = new Map<string, LiveSeat>();
  private readonly factorySeats = new Map<string, LiveSeat>();

  /** Attach a `StoreDecl` to a slot entry ID. Disposing tears down all seats for that entry. */
  registerEntryStore<S, TProps = unknown>(
    entryId: string,
    slotKey: string,
    decl: StoreDecl<S, TProps>,
  ): () => void {
    const normalized = normalizeStoreDecl(decl) as NormalizedStoreDecl;
    const record: RegisteredEntryDecl = { entryId, slotKey, decl: normalized };
    this.entryDecls.set(entryId, record);
    return () => {
      if (this.entryDecls.get(entryId) === record) {
        this.entryDecls.delete(entryId);
      }
      this.disposeEntry(entryId);
    };
  }

  /** Attach a `StoreDecl` directly to a factory key. Disposing tears down all seats for that factory. */
  registerFactoryStore<S, TProps = unknown>(
    factoryKey: string,
    decl: StoreDecl<S, TProps>,
  ): () => void {
    const normalized = normalizeStoreDecl(decl) as NormalizedStoreDecl;
    this.factoryDecls.set(factoryKey, normalized);
    return () => {
      if (this.factoryDecls.get(factoryKey) === normalized) {
        this.factoryDecls.delete(factoryKey);
      }
      this.disposeFactory(factoryKey);
    };
  }

  hasEntryStore(entryId: string): boolean {
    return this.entryDecls.has(entryId);
  }

  hasFactoryStore(factoryKey: string): boolean {
    return this.factoryDecls.has(factoryKey);
  }

  /** Acquire (or lazily create) the managed store seat for `(entryId, scopeKey)`. */
  storeOf<S = unknown>(entryId: string, scopeKey = "root", props: unknown = undefined): S {
    const key = slotSeatKey(entryId, scopeKey);
    const existing = this.entrySeats.get(key);
    if (existing !== undefined && !existing.disposed) {
      return existing.store as S;
    }
    const registered = this.entryDecls.get(entryId);
    if (registered === undefined) {
      throw new StoreSeatError(
        entryId,
        `No StoreDecl registered for slot entry "${entryId}"`,
      );
    }
    const seat = createLiveSeat({
      entryId,
      slotKey: registered.slotKey,
      scopeKey,
      props,
      decl: registered.decl,
    });
    this.entrySeats.set(key, seat);
    return seat.store as S;
  }

  /** Read an already-instantiated entry store without creating one. */
  peekStoreOf<S = unknown>(entryId: string, scopeKey = "root"): S | undefined {
    const seat = this.entrySeats.get(slotSeatKey(entryId, scopeKey));
    return seat !== undefined && !seat.disposed ? (seat.store as S) : undefined;
  }

  /**
   * Ensure a factory occurrence seat exists synchronously (for SSR or first render)
   * without bumping refCount; pair with `retainFactoryOccurrence` in an effect.
   */
  ensureFactorySeat<S = unknown, TProps = unknown>(
    factoryKey: string,
    occurrenceKey: string,
    scopeKey = "root",
    props?: TProps,
    override?: { readonly entryId: string; readonly decl: StoreDecl<S, TProps> },
  ): S {
    const key = factorySeatKey(factoryKey, occurrenceKey, scopeKey);
    const existing = this.factorySeats.get(key);
    if (
      existing !== undefined &&
      !existing.disposed &&
      (override === undefined || existing.entryId === override.entryId)
    ) {
      return existing.store as S;
    }
    if (existing !== undefined && !existing.disposed) {
      this.factorySeats.delete(key);
      disposeSeat(existing);
    }
    const resolvedDecl = override !== undefined
      ? (normalizeStoreDecl(override.decl) as NormalizedStoreDecl)
      : this.factoryDecls.get(factoryKey);
    if (resolvedDecl === undefined) {
      throw new StoreSeatError(
        factoryKey,
        `No StoreDecl registered for factory "${factoryKey}"`,
      );
    }
    const seat = createLiveSeat({
      entryId: override?.entryId ?? factoryKey,
      slotKey: factoryKey,
      scopeKey,
      occurrenceKey,
      props,
      decl: resolvedDecl,
    });
    this.factorySeats.set(key, seat);
    return seat.store as S;
  }

  /**
   * Retain a ref-counted store seat for `(factoryKey, occurrenceKey, scopeKey)`.
   * Calling the returned `release()` decrements the ref count and disposes the
   * seat once no retainers remain.
   */
  retainFactoryOccurrence<S = unknown, TProps = unknown>(
    factoryKey: string,
    occurrenceKey: string,
    scopeKey = "root",
    props?: TProps,
    override?: { readonly entryId: string; readonly decl: StoreDecl<S, TProps> },
  ): RetainedFactoryStore<S> {
    this.ensureFactorySeat(factoryKey, occurrenceKey, scopeKey, props, override);
    const key = factorySeatKey(factoryKey, occurrenceKey, scopeKey);
    const seat = this.factorySeats.get(key);
    if (seat === undefined) {
      throw new StoreSeatError(factoryKey, `Failed to allocate factory store seat for "${factoryKey}"`);
    }
    seat.refCount += 1;
    let released = false;
    return {
      store: seat.store as S,
      factoryKey,
      occurrenceKey,
      scopeKey,
      release: () => {
        if (released) return;
        released = true;
        if (seat.disposed) return;
        seat.refCount = Math.max(0, seat.refCount - 1);
        if (seat.refCount === 0) {
          if (this.factorySeats.get(key) === seat) {
            this.factorySeats.delete(key);
          }
          disposeSeat(seat);
        }
      },
    };
  }

  /** Look up the currently live store instance for a factory occurrence, if any. */
  factoryStoreOf<S = unknown>(
    factoryKey: string,
    occurrenceKey: string,
    scopeKey = "root",
  ): S | undefined {
    const seat = this.factorySeats.get(factorySeatKey(factoryKey, occurrenceKey, scopeKey));
    return seat !== undefined && !seat.disposed ? (seat.store as S) : undefined;
  }

  /** Dispose all slot and factory seats owned by `entryId`. */
  disposeEntry(entryId: string): void {
    for (const [key, seat] of [...this.entrySeats.entries()]) {
      if (seat.entryId === entryId) {
        this.entrySeats.delete(key);
        disposeSeat(seat);
      }
    }
    for (const [key, seat] of [...this.factorySeats.entries()]) {
      if (seat.entryId === entryId) {
        this.factorySeats.delete(key);
        disposeSeat(seat);
      }
    }
  }

  /** Dispose all seats belonging to `factoryKey`. */
  disposeFactory(factoryKey: string): void {
    for (const [key, seat] of [...this.factorySeats.entries()]) {
      if (seat.slotKey === factoryKey) {
        this.factorySeats.delete(key);
        disposeSeat(seat);
      }
    }
  }

  /** Dispose every slot and factory seat bound to `scopeKey` (e.g. `"session:s1"`). */
  disposeScope(scopeKey: string): void {
    for (const [key, seat] of [...this.entrySeats.entries()]) {
      if (seat.scopeKey === scopeKey) {
        this.entrySeats.delete(key);
        disposeSeat(seat);
      }
    }
    for (const [key, seat] of [...this.factorySeats.entries()]) {
      if (seat.scopeKey === scopeKey) {
        this.factorySeats.delete(key);
        disposeSeat(seat);
      }
    }
  }

  /** Dispose all live seats and clear all declarations (used in test teardown). */
  clear(): void {
    for (const seat of [...this.entrySeats.values()]) {
      disposeSeat(seat);
    }
    for (const seat of [...this.factorySeats.values()]) {
      disposeSeat(seat);
    }
    this.entrySeats.clear();
    this.factorySeats.clear();
    this.entryDecls.clear();
    this.factoryDecls.clear();
  }

  getActiveSeatCount(): number {
    return this.entrySeats.size + this.factorySeats.size;
  }
}

export const slotStoreRegistry = new SlotStoreRegistry();

export function storeOf<S = unknown>(entryId: string, scopeKey = "root", props?: unknown): S {
  return slotStoreRegistry.storeOf<S>(entryId, scopeKey, props);
}

export function peekStoreOf<S = unknown>(entryId: string, scopeKey = "root"): S | undefined {
  return slotStoreRegistry.peekStoreOf<S>(entryId, scopeKey);
}

export function factoryStoreOf<S = unknown>(
  factoryKey: string,
  occurrenceKey: string,
  scopeKey = "root",
): S | undefined {
  return slotStoreRegistry.factoryStoreOf<S>(factoryKey, occurrenceKey, scopeKey);
}

export function retainFactoryOccurrence<S = unknown, TProps = unknown>(
  factoryKey: string,
  occurrenceKey: string,
  scopeKey = "root",
  props?: TProps,
): RetainedFactoryStore<S> {
  return slotStoreRegistry.retainFactoryOccurrence<S, TProps>(factoryKey, occurrenceKey, scopeKey, props);
}

export function disposeScopeStores(scopeKey: string): void {
  slotStoreRegistry.disposeScope(scopeKey);
}
