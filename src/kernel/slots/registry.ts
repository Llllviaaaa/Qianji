/**
 * Reactive Slot Registry (`@qianji/client-slots`, ADR 0023 §2 & §5).
 * Election/ownership helpers live in `election.ts`; Cordis service lives in `service.ts`.
 */
import type { Context } from "@deepseek-ai/cordis";
import { resolveContextPluginId } from "../../lib/clientPluginRuntime";
import {
  getPluginTier,
  slotOverridesStore,
  type SlotOverridesStore,
} from "../runtime/slotOverrides";
import { slotStoreRegistry, type SlotStoreRegistry } from "../store";
import { AbdicationTracker } from "./abdication";
import {
  electSlotCandidates,
  matchesRouteKey,
  mirrorContributionToSlot,
  SlotAuthorization,
  tierWeight,
  type LegacyContributionMirrorItem,
  type RankedSlotCandidate,
} from "./election";
import {
  SlotOwnershipError,
  type AnyFactoryKey,
  type AnySlotKey,
  type ChildSlotDecl,
  type ChildrenDecl,
  type PluginTier,
  type SlotCandidateSummary,
  type SlotEntryRecord,
  type SlotFactoryEntryRecord,
  type SlotFactoryRegistrationInput,
  type SlotInspection,
  type SlotKind,
  type SlotRegistrationInput,
  type SlotScope,
  type SlotScopeAdapter,
  type SlotWrapperComponent,
  type SlotWrapperInput,
  type SlotWrapperRecord,
} from "./types";

export {
  electSlotCandidates,
  matchesRouteKey,
  mirrorContributionToSlot,
  SlotAuthorization,
  tierWeight,
  type LegacyContributionMirrorItem,
  type RankedSlotCandidate,
};

interface ChildClaimRecord {
  readonly parentSlotKey: string;
  readonly entryId: string;
  readonly decl: ChildSlotDecl;
}

export interface SlotRegistryOptions {
  readonly stores?: SlotStoreRegistry;
  readonly abdication?: AbdicationTracker;
  readonly overrides?: SlotOverridesStore;
  readonly scopeAdapter?: SlotScopeAdapter;
}

function normalizeKeys(key: string | readonly string[] | undefined): readonly string[] | undefined {
  if (key === undefined) return undefined;
  return typeof key === "string" ? [key] : [...key];
}

export class SlotRegistry {
  readonly stores: SlotStoreRegistry;
  readonly abdication: AbdicationTracker;
  readonly overrides: SlotOverridesStore;

  private readonly entriesBySlot = new Map<string, SlotEntryRecord[]>();
  private readonly wrappersBySlot = new Map<string, SlotWrapperRecord[]>();
  private readonly factoriesByKey = new Map<string, SlotFactoryEntryRecord[]>();
  private readonly explicitSpecs = new Map<string, ChildSlotDecl>();
  private readonly childClaims = new Map<string, Set<ChildClaimRecord>>();
  private readonly authorizations = new Map<string, SlotAuthorization>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribers: Array<() => void> = [];
  private scopeAdapter: SlotScopeAdapter | undefined;
  private seq = 0;
  private version = 0;

  constructor(options: SlotRegistryOptions = {}) {
    this.stores = options.stores ?? slotStoreRegistry;
    this.abdication = options.abdication ?? new AbdicationTracker();
    this.overrides = options.overrides ?? slotOverridesStore;
    this.scopeAdapter = options.scopeAdapter;
    this.unsubscribers.push(
      this.abdication.subscribe(() => this.emit()),
      this.overrides.subscribe(() => this.emit()),
    );
  }

  /** Define metadata for a root/host-level slot without a parent entry. */
  defineSlot(slotKey: string, spec: ChildSlotDecl): () => void {
    this.explicitSpecs.set(slotKey, spec);
    this.emit();
    return () => {
      if (this.explicitSpecs.get(slotKey) === spec) {
        this.explicitSpecs.delete(slotKey);
        this.emit();
      }
    };
  }

  /** Register a slot entry, claim declared `children`, attach optional Store seat, and return a disposer. */
  register<K extends AnySlotKey, TStore = unknown, TSelected = unknown>(
    slotKey: K,
    input: SlotRegistrationInput<K, TStore, TSelected>,
    callerCtx?: Context,
  ): () => void {
    this.seq += 1;
    const registeredSeq = this.seq;
    const inferredPluginId = input.pluginId ?? resolveContextPluginId(callerCtx) ?? "builtin";
    const tier: PluginTier = input.tier ?? (inferredPluginId === "builtin" ? "builtin" : getPluginTier(inferredPluginId));
    const entryId = input.id ?? `${inferredPluginId}:${slotKey}:${registeredSeq}`;
    const children: ChildrenDecl = input.children ?? {};

    for (const childSlotKey of Object.keys(children)) {
      const existingClaims = this.childClaims.get(childSlotKey);
      if (existingClaims === undefined) continue;
      for (const claim of existingClaims) {
        if (claim.parentSlotKey !== slotKey) {
          throw new SlotOwnershipError(
            entryId,
            childSlotKey,
            Object.keys(children),
            `Child slot "${childSlotKey}" is already owned by parent slot "${claim.parentSlotKey}" (entry "${claim.entryId}")`,
          );
        }
      }
    }

    const keys = normalizeKeys(input.key);
    const record: SlotEntryRecord = {
      id: entryId,
      slotKey,
      pluginId: inferredPluginId,
      tier,
      priority: input.priority ?? 0,
      order: input.order ?? 100,
      registeredSeq,
      ...(keys === undefined ? {} : { keys }),
      ...(input.matchKey === undefined ? {} : { matchKey: input.matchKey }),
      ...(input.select === undefined ? {} : { select: input.select as SlotEntryRecord["select"] }),
      overlay: input.overlay === true,
      children,
      hasStore: input.store !== undefined,
      ...(input.locale === undefined ? {} : { locale: input.locale }),
      ...(callerCtx === undefined ? {} : { ctx: callerCtx }),
      component: input.component as SlotEntryRecord["component"],
    };

    const priorAuth = this.authorizations.get(entryId);
    if (priorAuth !== undefined) {
      priorAuth.markDisposed();
      for (const [childKey, claimSet] of [...this.childClaims.entries()]) {
        for (const claim of [...claimSet]) {
          if (claim.entryId === entryId) claimSet.delete(claim);
        }
        if (claimSet.size === 0) this.childClaims.delete(childKey);
      }
      this.stores.disposeEntry(entryId);
    }

    const authorization = new SlotAuthorization(entryId, slotKey, children, callerCtx);
    this.authorizations.set(entryId, authorization);

    const addedClaims: Array<{ childSlotKey: string; claim: ChildClaimRecord }> = [];
    for (const [childSlotKey, decl] of Object.entries(children)) {
      let set = this.childClaims.get(childSlotKey);
      if (set === undefined) {
        set = new Set<ChildClaimRecord>();
        this.childClaims.set(childSlotKey, set);
      }
      const claim: ChildClaimRecord = { parentSlotKey: slotKey, entryId, decl };
      set.add(claim);
      addedClaims.push({ childSlotKey, claim });
    }

    const disposeStore = input.store !== undefined
      ? this.stores.registerEntryStore(entryId, slotKey, input.store)
      : undefined;

    let list = this.entriesBySlot.get(slotKey);
    if (list === undefined) {
      list = [];
      this.entriesBySlot.set(slotKey, list);
    }
    const existingIdx = list.findIndex((item) => item.id === entryId);
    if (existingIdx >= 0) list.splice(existingIdx, 1);
    list.push(record);
    this.emit();

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const isCurrent = this.authorizations.get(entryId) === authorization;
      authorization.markDisposed();
      if (isCurrent) this.authorizations.delete(entryId);
      for (const { childSlotKey, claim } of addedClaims) {
        const set = this.childClaims.get(childSlotKey);
        if (set !== undefined) {
          set.delete(claim);
          if (set.size === 0) this.childClaims.delete(childSlotKey);
        }
      }
      const entries = this.entriesBySlot.get(slotKey);
      if (entries !== undefined) {
        const idx = entries.indexOf(record);
        if (idx >= 0) entries.splice(idx, 1);
        if (entries.length === 0) this.entriesBySlot.delete(slotKey);
      }
      if (isCurrent) {
        disposeStore?.();
        this.stores.disposeEntry(entryId);
      }
      this.emit();
    };
  }

  /** Register a reusable component factory (`registerFactory` / `renderFactory`). */
  registerFactory<K extends AnyFactoryKey, TStore = unknown>(
    factoryKey: K,
    input: SlotFactoryRegistrationInput<K, TStore>,
    callerCtx?: Context,
  ): () => void {
    this.seq += 1;
    const registeredSeq = this.seq;
    const inferredPluginId = input.pluginId ?? resolveContextPluginId(callerCtx) ?? "builtin";
    const tier: PluginTier = input.tier ?? (inferredPluginId === "builtin" ? "builtin" : getPluginTier(inferredPluginId));
    const entryId = input.id ?? `${inferredPluginId}:factory:${factoryKey}:${registeredSeq}`;
    const record: SlotFactoryEntryRecord = {
      id: entryId,
      factoryKey,
      pluginId: inferredPluginId,
      tier,
      priority: input.priority ?? 0,
      registeredSeq,
      scope: input.scope ?? "root",
      ...(input.store === undefined ? {} : { storeDecl: input.store as SlotFactoryEntryRecord["storeDecl"] }),
      ...(input.locale === undefined ? {} : { locale: input.locale }),
      ...(callerCtx === undefined ? {} : { ctx: callerCtx }),
      component: input.component as SlotFactoryEntryRecord["component"],
    };

    let list = this.factoriesByKey.get(factoryKey);
    if (list === undefined) {
      list = [];
      this.factoriesByKey.set(factoryKey, list);
    }
    list.push(record);
    this.emit();

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const entries = this.factoriesByKey.get(factoryKey);
      if (entries !== undefined) {
        const idx = entries.indexOf(record);
        if (idx >= 0) entries.splice(idx, 1);
        if (entries.length === 0) this.factoriesByKey.delete(factoryKey);
      }
      this.stores.disposeEntry(entryId);
      this.emit();
    };
  }

  /** Register an onion decorator wrapper around `slotKey`. */
  wrap<K extends AnySlotKey>(
    slotKey: K,
    input: SlotWrapperInput<K>,
    callerCtx?: Context,
  ): () => void {
    this.seq += 1;
    const registeredSeq = this.seq;
    const isFn = typeof input === "function";
    const inferredPluginId = (isFn ? undefined : input.pluginId) ?? resolveContextPluginId(callerCtx) ?? "builtin";
    const tier: PluginTier = (isFn ? undefined : input.tier) ?? (inferredPluginId === "builtin" ? "builtin" : getPluginTier(inferredPluginId));
    const wrapperId = (isFn ? undefined : input.id) ?? `${inferredPluginId}:wrap:${slotKey}:${registeredSeq}`;
    const component = (isFn ? input : input.component) as SlotWrapperComponent<Record<string, unknown>>;
    const record: SlotWrapperRecord = {
      id: wrapperId,
      slotKey,
      pluginId: inferredPluginId,
      tier,
      priority: isFn ? 0 : (input.priority ?? 0),
      order: isFn ? 100 : (input.order ?? 100),
      registeredSeq,
      component,
    };

    let list = this.wrappersBySlot.get(slotKey);
    if (list === undefined) {
      list = [];
      this.wrappersBySlot.set(slotKey, list);
    }
    list.push(record);
    list.sort((a, b) => b.priority - a.priority || a.order - b.order || a.registeredSeq - b.registeredSeq);
    this.emit();

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const entries = this.wrappersBySlot.get(slotKey);
      if (entries !== undefined) {
        const idx = entries.indexOf(record);
        if (idx >= 0) entries.splice(idx, 1);
        if (entries.length === 0) this.wrappersBySlot.delete(slotKey);
      }
      this.emit();
    };
  }

  getAuthorization(entryId: string): SlotAuthorization | undefined {
    return this.authorizations.get(entryId);
  }

  getSlotSpec(slotKey: string): ChildSlotDecl | undefined {
    const explicit = this.explicitSpecs.get(slotKey);
    if (explicit !== undefined) return explicit;
    const claims = this.childClaims.get(slotKey);
    if (claims === undefined || claims.size === 0) return undefined;
    return claims.values().next().value?.decl;
  }

  getEntries(slotKey: string): readonly SlotEntryRecord[] {
    return this.entriesBySlot.get(slotKey) ?? [];
  }

  getListEntries(slotKey: string): SlotEntryRecord[] {
    const raw = this.entriesBySlot.get(slotKey);
    if (raw === undefined || raw.length === 0) return [];
    return [...raw].sort((a, b) => a.order - b.order || a.registeredSeq - b.registeredSeq || a.id.localeCompare(b.id));
  }

  getRankedCandidates(slotKey: string): SlotEntryRecord[] {
    const raw = this.entriesBySlot.get(slotKey);
    if (raw === undefined || raw.length === 0) return [];
    return electSlotCandidates(slotKey, raw, this.overrides.getSnapshot());
  }

  getKeyedCandidates(slotKey: string, routeKey: string): SlotEntryRecord[] {
    const raw = this.entriesBySlot.get(slotKey);
    if (raw === undefined || raw.length === 0) return [];
    return electSlotCandidates(slotKey, raw.filter((e) => matchesRouteKey(e, routeKey)), this.overrides.getSnapshot());
  }

  getFactoryCandidates(factoryKey: string): SlotFactoryEntryRecord[] {
    const raw = this.factoriesByKey.get(factoryKey);
    if (raw === undefined || raw.length === 0) return [];
    return electSlotCandidates(`factory:${factoryKey}`, raw, this.overrides.getSnapshot());
  }

  getWrappers(slotKey: string): readonly SlotWrapperRecord[] {
    return this.wrappersBySlot.get(slotKey) ?? [];
  }

  inspectSlot(slotKey: string): SlotInspection {
    const spec = this.getSlotSpec(slotKey);
    const kind: SlotKind = spec?.kind ?? "single";
    const scope: SlotScope = spec?.scope ?? "root";
    const ranked = kind === "list" ? this.getListEntries(slotKey) : this.getRankedCandidates(slotKey);
    const candidates: SlotCandidateSummary[] = ranked.map((entry) => ({
      id: entry.id,
      pluginId: entry.pluginId,
      tier: entry.tier,
      priority: entry.priority,
      order: entry.order,
      abdicated: this.abdication.isAbdicated(slotKey, entry.id, entry.pluginId),
    }));
    const winner = kind === "list" ? undefined : candidates.find((item) => !item.abdicated);
    const override = this.overrides.get(slotKey);
    return {
      slotKey,
      kind,
      scope,
      ...(override === undefined ? {} : { override }),
      ...(winner === undefined ? {} : { winner }),
      candidates,
      wrapperIds: this.getWrappers(slotKey).map((w) => w.id),
    };
  }

  inspectAllSlots(): SlotInspection[] {
    const keys = new Set<string>([
      ...this.entriesBySlot.keys(),
      ...this.explicitSpecs.keys(),
      ...this.childClaims.keys(),
      ...this.wrappersBySlot.keys(),
    ]);
    return [...keys].sort().map((key) => this.inspectSlot(key));
  }

  setScopeAdapter(adapter: SlotScopeAdapter | undefined): void {
    this.scopeAdapter = adapter;
    this.emit();
  }

  getScopeAdapter(): SlotScopeAdapter | undefined {
    return this.scopeAdapter;
  }

  getVersion = (): number => this.version;

  subscribe = (listener: () => void): (() => void) => {
    this.abdication.ensureErrorSubscription();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  clear(): void {
    for (const auth of this.authorizations.values()) auth.markDisposed();
    this.entriesBySlot.clear();
    this.wrappersBySlot.clear();
    this.factoriesByKey.clear();
    this.explicitSpecs.clear();
    this.childClaims.clear();
    this.authorizations.clear();
    this.abdication.clearAll();
    this.stores.clear();
    this.emit();
  }

  dispose(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
    this.clear();
    this.listeners.clear();
  }

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

export const clientSlotsRegistry = new SlotRegistry();
