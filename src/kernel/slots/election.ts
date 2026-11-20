/**
 * Pure conflict election, route key matching, ownership authorization,
 * and legacy `ctx.contributions` mirroring helpers for `@qianji/client-slots`.
 */
import type { ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  SlotOwnershipError,
  StaleAuthorizationError,
  type ChildSlotDecl,
  type ChildrenDecl,
  type PluginTier,
  type SlotEntryRecord,
  type SlotKind,
  type SlotRegistrationInput,
} from "./types";

export interface RankedSlotCandidate {
  readonly id: string;
  readonly pluginId: string;
  readonly tier: PluginTier;
  readonly priority: number;
  readonly registeredSeq: number;
}

export function tierWeight(tier: PluginTier): number {
  if (tier === "workspace") return 3;
  if (tier === "user") return 2;
  return 1;
}

/**
 * Rank competing candidates for a `single`, `keyed`, `chain`, or `factory` slot:
 *   user `slotOverrides[slotKey]` > tier (`workspace` > `user` > `builtin`)
 *   > explicit `priority` (higher wins) > registration order (earlier wins).
 */
export function electSlotCandidates<T extends RankedSlotCandidate>(
  slotKey: string,
  candidates: readonly T[],
  overrides: Readonly<Record<string, string>>,
): T[] {
  const override = overrides[slotKey];
  const overrideScore = (item: RankedSlotCandidate): number => {
    if (override === undefined) return 0;
    if (item.id === override) return 2;
    if (item.pluginId === override) return 1;
    return 0;
  };
  return [...candidates].sort((a, b) => {
    const ovDiff = overrideScore(b) - overrideScore(a);
    if (ovDiff !== 0) return ovDiff;
    const tierDiff = tierWeight(b.tier) - tierWeight(a.tier);
    if (tierDiff !== 0) return tierDiff;
    const prioDiff = b.priority - a.priority;
    if (prioDiff !== 0) return prioDiff;
    return a.registeredSeq - b.registeredSeq;
  });
}

/** Match a `"keyed"` slot entry against `routeKey` via predicate, exact match, or prefix wildcard. */
export function matchesRouteKey(
  entry: Pick<SlotEntryRecord, "keys" | "matchKey">,
  routeKey: string,
): boolean {
  if (entry.matchKey !== undefined) {
    try {
      return entry.matchKey(routeKey);
    } catch {
      return false;
    }
  }
  if (entry.keys === undefined || entry.keys.length === 0) {
    return true;
  }
  const normalized = routeKey.trim();
  for (const rawPattern of entry.keys) {
    const pattern = rawPattern.trim();
    if (pattern === "") continue;
    if (pattern === "*" || pattern === normalized) return true;
    if (pattern.endsWith("*") && normalized.startsWith(pattern.slice(0, -1))) {
      return true;
    }
  }
  return false;
}

function isContextFiberDisposed(ctx: Context | undefined): boolean {
  const state = (ctx as { fiber?: { state?: number } } | undefined)?.fiber?.state;
  return state === 4 || state === 5;
}

/** Live authorization token binding a registered component's `renderSlot` handles to its claimed children. */
export class SlotAuthorization {
  readonly entryId: string;
  readonly parentSlotKey: string;
  readonly ownedChildren: ReadonlyMap<string, ChildSlotDecl>;
  private readonly ctx?: Context;
  private disposedFlag = false;

  constructor(
    entryId: string,
    parentSlotKey: string,
    children: ChildrenDecl,
    ctx?: Context,
  ) {
    this.entryId = entryId;
    this.parentSlotKey = parentSlotKey;
    this.ownedChildren = new Map(Object.entries(children));
    this.ctx = ctx;
  }

  get isDisposed(): boolean {
    return this.disposedFlag || isContextFiberDisposed(this.ctx);
  }

  markDisposed(): void {
    this.disposedFlag = true;
  }

  assertAuthorized(slotKey: string, requiredKind?: SlotKind): ChildSlotDecl {
    if (this.isDisposed) {
      throw new StaleAuthorizationError(this.entryId, slotKey);
    }
    const spec = this.ownedChildren.get(slotKey);
    if (spec === undefined) {
      throw new SlotOwnershipError(this.entryId, slotKey, [...this.ownedChildren.keys()]);
    }
    if (requiredKind !== undefined && spec.kind !== requiredKind) {
      throw new SlotOwnershipError(
        this.entryId,
        slotKey,
        [...this.ownedChildren.keys()],
        `Child slot "${slotKey}" owned by "${this.entryId}" has kind "${spec.kind}", expected "${requiredKind}"`,
      );
    }
    return spec;
  }
}

export interface LegacyContributionMirrorItem {
  readonly id: string;
  readonly pluginId?: string;
  readonly order?: number;
  readonly toolNames?: readonly string[];
  readonly languages?: readonly string[];
  readonly extensions?: readonly string[];
  readonly render?: (context: Record<string, unknown>) => ReactNode;
}

export interface SlotRegistrarLike {
  register(slotKey: string, input: SlotRegistrationInput, callerCtx?: Context): () => void;
}

/**
 * Mirror a legacy `ctx.contributions` registration into a `SlotRegistry` under
 * `legacy.<kind>` so introspection and slot tooling see all 22 contribution kinds
 * while keeping legacy registries 100% backward compatible.
 */
export function mirrorContributionToSlot(
  registry: SlotRegistrarLike,
  kind: string,
  item: LegacyContributionMirrorItem,
): () => void {
  const slotKey = `legacy.${kind}`;
  const keys =
    item.toolNames ??
    item.languages ??
    item.extensions?.map((ext) => (ext.startsWith(".") ? ext.slice(1).toLowerCase() : ext.toLowerCase()));
  const renderFn = item.render;
  const LegacyMirroredComponent = (props: Record<string, unknown>): ReactNode => {
    if (typeof renderFn !== "function") return null;
    return renderFn(props);
  };
  return registry.register(slotKey, {
    id: `legacy:${kind}:${item.id}`,
    ...(item.pluginId === undefined ? {} : { pluginId: item.pluginId }),
    order: item.order ?? 100,
    ...(keys === undefined ? {} : { key: keys }),
    component: LegacyMirroredComponent as SlotRegistrationInput["component"],
  });
}
