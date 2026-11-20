/**
 * Abdication Fallback tracker for single, keyed, chain, and factory slots
 * (ADR 0023 §5.1).
 *
 * When a winning plugin entry crashes during render/select or enters a circuit-
 * breaker lockout for `(etag, configKey, reloadEpoch)`, the tracker marks that
 * entry abdicated for the current cycle, reports the render error, invokes
 * registered `onAbdicate` callbacks (e.g. non-blocking toast notifications),
 * and wakes slot renderers so they fall back immediately to the next candidate
 * (ultimately down to the builtin default).
 */
import {
  getClientPluginRuntimeMeta,
  getClientSlotLockout,
  getPluginReloadEpoch,
  recordClientRenderError,
  subscribeClientPluginErrors,
} from "../../lib/clientPluginState";

export interface AbdicationCycle {
  readonly etag: string;
  readonly configKey: string;
  readonly reloadEpoch: number;
}

export interface AbdicationRecord {
  readonly slotKey: string;
  readonly entryId: string;
  readonly pluginId: string;
  readonly reason: string;
  readonly error?: Error;
  readonly cycle: AbdicationCycle;
  readonly fallbackEntryId?: string;
  readonly fallbackPluginId?: string;
  readonly timestamp: number;
}

export type AbdicationListener = (record: AbdicationRecord) => void;
export type AbdicationCycleProvider = (pluginId: string) => AbdicationCycle;

export interface AbdicationTrackerOptions {
  readonly getCycle?: AbdicationCycleProvider;
  readonly recordError?: (pluginId: string | undefined, slotId: string, error: unknown) => void;
  readonly getLockout?: (pluginId: string | undefined, slotId: string) => { locked: boolean; message?: string };
  readonly subscribeErrors?: (listener: () => void) => () => void;
}

export function resolveDefaultPluginCycle(pluginId: string): AbdicationCycle {
  if (pluginId === "" || pluginId === "builtin") {
    return {
      etag: "",
      configKey: "{}",
      reloadEpoch: getPluginReloadEpoch(pluginId),
    };
  }
  const meta = getClientPluginRuntimeMeta(pluginId);
  return {
    etag: meta?.etag ?? "",
    configKey: meta?.configKey ?? "{}",
    reloadEpoch: getPluginReloadEpoch(pluginId),
  };
}

function cyclesMatch(a: AbdicationCycle, b: AbdicationCycle): boolean {
  return (
    a.etag === b.etag &&
    a.configKey === b.configKey &&
    a.reloadEpoch === b.reloadEpoch
  );
}

function abdicationMapKey(slotKey: string, entryId: string): string {
  return `${slotKey}\u0000${entryId}`;
}

export interface AbdicateParams {
  readonly slotKey: string;
  readonly entryId: string;
  readonly pluginId: string;
  readonly error: unknown;
  readonly fallbackEntryId?: string;
  readonly fallbackPluginId?: string;
  readonly cycle?: AbdicationCycle;
  /** Defer state-listener emission to a microtask when invoked during React's render phase. */
  readonly deferEmit?: boolean;
}

export class AbdicationTracker {
  private readonly getCycle: AbdicationCycleProvider;
  private readonly recordError: (pluginId: string | undefined, slotId: string, error: unknown) => void;
  private readonly getLockout: (pluginId: string | undefined, slotId: string) => { locked: boolean; message?: string };
  private readonly subscribeErrorsFn: (listener: () => void) => () => void;
  private readonly records = new Map<string, AbdicationRecord>();
  private readonly abdicateListeners = new Set<AbdicationListener>();
  private readonly stateListeners = new Set<() => void>();
  private offClientErrors: (() => void) | undefined;
  private disposed = false;
  private recordsSnapshot: readonly AbdicationRecord[] = [];

  constructor(options: AbdicationTrackerOptions = {}) {
    this.getCycle = options.getCycle ?? resolveDefaultPluginCycle;
    this.recordError = options.recordError ?? recordClientRenderError;
    this.getLockout = options.getLockout ?? getClientSlotLockout;
    this.subscribeErrorsFn = options.subscribeErrors ?? subscribeClientPluginErrors;
    // Defer subscribing to the default `clientPluginState` store until first runtime use
    // so module-evaluation cycles (e.g. `clientPluginRuntime -> clientPluginState -> store ->
    // clientContributions -> clientSlotsRegistry`) never hit TDZ on `clientErrorListeners`.
    if (options.subscribeErrors !== undefined) {
      this.ensureErrorSubscription();
    }
  }

  /** Lazily attach the `clientPluginState` listener once modules have finished initializing. */
  ensureErrorSubscription(): void {
    if (this.disposed || this.offClientErrors !== undefined) return;
    this.offClientErrors = this.subscribeErrorsFn(() => {
      this.pruneExpiredRecords();
      this.emitState();
    });
  }

  /**
   * Mark `(slotKey, entryId)` abdicated for its current `(etag, configKey, reloadEpoch)`
   * cycle, record client error state, invoke `onAbdicate` listeners, and notify renderers.
   */
  abdicate(params: AbdicateParams): AbdicationRecord {
    this.ensureErrorSubscription();
    const key = abdicationMapKey(params.slotKey, params.entryId);
    const cycle = params.cycle ?? this.getCycle(params.pluginId);
    const errObj = params.error instanceof Error ? params.error : new Error(String(params.error));
    const existing = this.records.get(key);
    if (existing !== undefined && cyclesMatch(existing.cycle, cycle)) {
      return existing;
    }

    const record: AbdicationRecord = {
      slotKey: params.slotKey,
      entryId: params.entryId,
      pluginId: params.pluginId,
      reason: errObj.message || "Plugin slot render failure",
      error: errObj,
      cycle,
      ...(params.fallbackEntryId === undefined ? {} : { fallbackEntryId: params.fallbackEntryId }),
      ...(params.fallbackPluginId === undefined ? {} : { fallbackPluginId: params.fallbackPluginId }),
      timestamp: Date.now(),
    };

    this.records.set(key, record);
    this.recordsSnapshot = [...this.records.values()];

    const slotErrorKey = `${params.slotKey}:${params.entryId}`;
    this.recordError(params.pluginId, slotErrorKey, errObj);

    for (const listener of this.abdicateListeners) {
      try {
        listener(record);
      } catch (callbackErr) {
        console.error("[qianji-slot-abdication] onAbdicate callback failed:", callbackErr);
      }
    }
    if (params.deferEmit === true) {
      queueMicrotask(() => this.emitState());
    } else {
      this.emitState();
    }
    return record;
  }

  /** Stable string key for a plugin's active `(etag, configKey, reloadEpoch)` cycle. */
  getCycleKey(pluginId: string): string {
    const c = this.getCycle(pluginId);
    return `${c.etag}:${c.configKey}:${c.reloadEpoch}`;
  }

  /**
   * Check whether `(slotKey, entryId)` is currently abdicated or circuit-breaker locked out
   * for its live `(etag, configKey, reloadEpoch)`. Automatically clears stale records once
   * a plugin reloads, updates config, or receives a new HMR bundle ETag.
   */
  isAbdicated(slotKey: string, entryId: string, pluginId: string): boolean {
    this.ensureErrorSubscription();
    const key = abdicationMapKey(slotKey, entryId);
    const currentCycle = this.getCycle(pluginId);
    const existing = this.records.get(key);
    if (existing !== undefined) {
      if (cyclesMatch(existing.cycle, currentCycle)) {
        return true;
      }
      this.records.delete(key);
      this.recordsSnapshot = [...this.records.values()];
    }

    const lockout = this.getLockout(pluginId, `${slotKey}:${entryId}`);
    if (lockout.locked) {
      return true;
    }
    return false;
  }

  /**
   * Inspect lockout state and promote an externally locked-out entry into a recorded
   * abdication (firing `onAbdicate` once for the current cycle) when a fallback exists.
   */
  promoteLockoutIfNeeded(
    slotKey: string,
    entryId: string,
    pluginId: string,
    fallback?: { readonly id: string; readonly pluginId: string },
  ): boolean {
    if (!this.isAbdicated(slotKey, entryId, pluginId)) {
      return false;
    }
    const key = abdicationMapKey(slotKey, entryId);
    const currentCycle = this.getCycle(pluginId);
    const existing = this.records.get(key);
    if (existing !== undefined && cyclesMatch(existing.cycle, currentCycle)) {
      return true;
    }
    const lockout = this.getLockout(pluginId, `${slotKey}:${entryId}`);
    if (lockout.locked) {
      this.abdicate({
        slotKey,
        entryId,
        pluginId,
        error: new Error(lockout.message ?? "Slot locked out after previous render crash"),
        ...(fallback === undefined ? {} : { fallbackEntryId: fallback.id, fallbackPluginId: fallback.pluginId }),
        cycle: currentCycle,
        deferEmit: true,
      });
      return true;
    }
    return false;
  }

  getRecord(slotKey: string, entryId: string): AbdicationRecord | undefined {
    return this.records.get(abdicationMapKey(slotKey, entryId));
  }

  getRecords = (): readonly AbdicationRecord[] => this.recordsSnapshot;

  onAbdicate(listener: AbdicationListener): () => void {
    this.ensureErrorSubscription();
    this.abdicateListeners.add(listener);
    return () => {
      this.abdicateListeners.delete(listener);
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  };

  clearEntry(slotKey: string, entryId: string): void {
    const key = abdicationMapKey(slotKey, entryId);
    if (!this.records.delete(key)) return;
    this.recordsSnapshot = [...this.records.values()];
    this.emitState();
  }

  clearPlugin(pluginId: string): void {
    let changed = false;
    for (const [key, record] of [...this.records.entries()]) {
      if (record.pluginId === pluginId) {
        this.records.delete(key);
        changed = true;
      }
    }
    if (!changed) return;
    this.recordsSnapshot = [...this.records.values()];
    this.emitState();
  }

  clearAll(): void {
    if (this.records.size === 0) return;
    this.records.clear();
    this.recordsSnapshot = [];
    this.emitState();
  }

  dispose(): void {
    this.disposed = true;
    this.offClientErrors?.();
    this.offClientErrors = undefined;
    this.abdicateListeners.clear();
    this.stateListeners.clear();
  }

  private pruneExpiredRecords(): void {
    let changed = false;
    for (const [key, record] of [...this.records.entries()]) {
      const currentCycle = this.getCycle(record.pluginId);
      if (!cyclesMatch(record.cycle, currentCycle)) {
        this.records.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.recordsSnapshot = [...this.records.values()];
    }
  }

  private emitState(): void {
    for (const listener of this.stateListeners) {
      listener();
    }
  }
}
