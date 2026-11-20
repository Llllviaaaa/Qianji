/**
 * Core types, declaration-merged registries, scope contracts, and error
 * classes for Qianji's typed slot kernel (`@qianji/client-slots`, ADR 0023 §2).
 */
import type { ComponentType, ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { StoreDecl } from "../store";
import type {
  LocaleNamespaceMap,
  ResourceProtocolMap,
  SlotFactoryMap,
  SlotMap,
} from "./index";

export type { LocaleNamespaceMap, ResourceProtocolMap, SlotFactoryMap, SlotMap };

export type SlotKind = "single" | "list" | "keyed" | "chain";
export type SlotScope = "root" | "session-maybe" | "session";
export type PluginTier = "builtin" | "user" | "workspace";

export interface SlotSpec<
  TProps = Record<string, unknown>,
  TKind extends SlotKind = SlotKind,
  TScope extends SlotScope = SlotScope,
  TKey extends string = string,
> {
  readonly kind: TKind;
  readonly scope: TScope;
  readonly props: TProps;
  readonly key?: TKey;
}

export interface SlotFactorySpec<
  TProps = Record<string, unknown>,
  TScope extends SlotScope = SlotScope,
> {
  readonly props: TProps;
  readonly scope?: TScope;
}

export type KnownSlotKey = Extract<keyof SlotMap, string>;
export type AnySlotKey = KnownSlotKey | (string & {});

export type KnownFactoryKey = Extract<keyof SlotFactoryMap, string>;
export type AnyFactoryKey = KnownFactoryKey | (string & {});

export type LocaleNamespaceKey = Extract<keyof LocaleNamespaceMap, string> | (string & {});
export type ResourceProtocolKey = Extract<keyof ResourceProtocolMap, string> | (string & {});

export type SlotPropsOf<K extends string> =
  K extends keyof SlotMap
    ? SlotMap[K] extends { props: infer P }
      ? P
      : SlotMap[K]
    : Record<string, unknown>;

export type SlotKindOf<K extends string> =
  K extends keyof SlotMap
    ? SlotMap[K] extends { kind: infer Kind extends SlotKind }
      ? Kind
      : SlotKind
    : SlotKind;

export type SlotScopeOf<K extends string> =
  K extends keyof SlotMap
    ? SlotMap[K] extends { scope: infer S extends SlotScope }
      ? S
      : SlotScope
    : SlotScope;

export type FactoryPropsOf<K extends string> =
  K extends keyof SlotFactoryMap
    ? SlotFactoryMap[K] extends { props: infer P }
      ? P
      : SlotFactoryMap[K]
    : Record<string, unknown>;

export type FactoryScopeOf<K extends string> =
  K extends keyof SlotFactoryMap
    ? SlotFactoryMap[K] extends { scope: infer S extends SlotScope }
      ? S
      : "root"
    : SlotScope;

export type ResourceValueOf<P extends string> =
  P extends keyof ResourceProtocolMap ? ResourceProtocolMap[P] : unknown;

export type TranslateFn<NS extends string = string> = (
  key: NS extends keyof LocaleNamespaceMap ? Extract<keyof LocaleNamespaceMap[NS], string> | (string & {}) : string,
  params?: Readonly<Record<string, string | number | boolean>>,
) => string;

/** Declaration-merged target descriptor table for each `SlotScope`. */
export interface SlotScopeTargetMap {
  root: {
    readonly scope: "root";
    readonly scopeKey: "root";
  };
  "session-maybe": {
    readonly scope: "session-maybe";
    readonly sessionId: string | null;
    readonly scopeKey: string;
  };
  session: {
    readonly scope: "session";
    readonly sessionId: string;
    readonly scopeKey: string;
  };
}

export interface RenderSlotOptions {
  /** Route key for `"keyed"` slots (e.g. tool name, file extension, paneId). */
  readonly key?: string;
  /** When `"all"` on a `"keyed"` slot, renders every matching candidate instead of only the elected winner. */
  readonly mode?: "single" | "all";
  /** Explicit session override for `"session"` or `"session-maybe"` slots. */
  readonly sessionId?: string | null;
  /** Render compact crash fallback chrome if no fallback candidate remains. */
  readonly compact?: boolean;
  /** Optional fallback element when no candidate matches (or a session-scoped slot has no sessionId). */
  readonly fallback?: ReactNode;
}

export interface RenderSlotChainOptions {
  /** Explicit session override for `"session"` or `"session-maybe"` chain slots. */
  readonly sessionId?: string | null;
  /** Render compact crash fallback chrome if every candidate in the chain crashes. */
  readonly compact?: boolean;
  /** Optional fallback element when no chain candidate matches. */
  readonly fallback?: ReactNode;
}

export interface RenderFactoryOptions {
  /** Explicit occurrence key isolating per-occurrence Store seats & ErrorBoundary keys. */
  readonly occurrenceKey?: string;
  /** Explicit session override when factory uses `"session"` or `"session-maybe"` scope. */
  readonly sessionId?: string | null;
  /** Render compact crash fallback chrome if no fallback factory remains. */
  readonly compact?: boolean;
  /** Optional fallback element when no factory is registered. */
  readonly fallback?: ReactNode;
}

export type BoundRenderSlotFn = <K extends AnySlotKey>(
  slotKey: K,
  props?: SlotPropsOf<K>,
  options?: RenderSlotOptions,
) => ReactNode;

export type BoundRenderSlotChainFn = <K extends AnySlotKey>(
  slotKey: K,
  props?: SlotPropsOf<K>,
  options?: RenderSlotChainOptions,
) => ReactNode;

export type BoundRenderFactoryFn = <K extends AnyFactoryKey>(
  factoryKey: K,
  props?: FactoryPropsOf<K>,
  options?: RenderFactoryOptions,
) => ReactNode;

/** Standard props injected into `"root"`-scoped slot components (augmentable). */
export interface GlobalStandardProps {
  readonly ctx?: Context;
  readonly scope: SlotScopeTargetMap["root"];
  readonly renderSlot: BoundRenderSlotFn;
  readonly renderSlotChain: BoundRenderSlotChainFn;
  readonly renderFactory: BoundRenderFactoryFn;
  readonly t?: TranslateFn;
  readonly store?: unknown;
}

/** Standard props injected into `"session-maybe"`-scoped slot components (augmentable). */
export interface SessionMaybeStandardProps {
  readonly ctx?: Context;
  readonly scope: SlotScopeTargetMap["session-maybe"];
  readonly sessionId: string | null;
  readonly renderSlot: BoundRenderSlotFn;
  readonly renderSlotChain: BoundRenderSlotChainFn;
  readonly renderFactory: BoundRenderFactoryFn;
  readonly t?: TranslateFn;
  readonly store?: unknown;
}

/** Standard props injected into `"session"`-scoped slot components (augmentable). */
export interface SessionStandardProps {
  readonly ctx?: Context;
  readonly scope: SlotScopeTargetMap["session"];
  readonly sessionId: string;
  readonly renderSlot: BoundRenderSlotFn;
  readonly renderSlotChain: BoundRenderSlotChainFn;
  readonly renderFactory: BoundRenderFactoryFn;
  readonly t?: TranslateFn;
  readonly store?: unknown;
}

export type StandardPropsForScope<S extends SlotScope> =
  S extends "session"
    ? SessionStandardProps
    : S extends "session-maybe"
      ? SessionMaybeStandardProps
      : GlobalStandardProps;

export interface ChildSlotDecl<
  TKind extends SlotKind = SlotKind,
  TScope extends SlotScope = SlotScope,
> {
  readonly kind: TKind;
  readonly scope: TScope;
  readonly inject?: readonly string[];
  readonly description?: string;
}

export type ChildrenDecl = Readonly<Record<string, ChildSlotDecl>>;

export type SlotChainSelector<TProps = Record<string, unknown>, TSelected = unknown> = (
  ownerProps: TProps,
) => TSelected | null | undefined | false;

export type SlotComponentProps<
  TProps = Record<string, unknown>,
  TScope extends SlotScope = SlotScope,
  TStore = unknown,
  TSelected = unknown,
> = TProps &
  Omit<StandardPropsForScope<TScope>, "store"> & {
    readonly store: TStore;
    readonly selected?: TSelected;
  };

export interface SlotRegistrationInput<
  K extends AnySlotKey = AnySlotKey,
  TStore = unknown,
  TSelected = unknown,
  TScope extends SlotScope = SlotScopeOf<K>,
> {
  readonly id?: string;
  readonly pluginId?: string;
  readonly tier?: PluginTier;
  /** Election priority for `single`, `keyed`, and `chain` slots (higher wins; default `0`). */
  readonly priority?: number;
  /** Sort order for `list` slots (lower comes first; default `100`). */
  readonly order?: number;
  /** Route key(s) or prefix wildcards (e.g. `"sqlite_*"`) for `keyed` slots. */
  readonly key?: string | readonly string[];
  /** Custom route key predicate for `keyed` slots. */
  readonly matchKey?: (routeKey: string) => boolean;
  /** Pure selector predicate for `chain` slots; non-null/non-false return elects this entry. */
  readonly select?: SlotChainSelector<SlotPropsOf<K>, TSelected>;
  /**
   * When `true` on a `chain` slot entry, keeps the shadowed fallback entry mounted
   * under `display: none` so composer drafts and DOM/React state survive takeover.
   */
  readonly overlay?: boolean;
  /** Child slots owned and authorized to be rendered by this registration's bound `renderSlot`. */
  readonly children?: ChildrenDecl;
  /** Optional managed store seat bound to `(entryId, scopeKey)` lifecycle. */
  readonly store?: StoreDecl<TStore, SlotPropsOf<K>>;
  /** Optional i18n namespace bound into injected `t`. */
  readonly locale?: LocaleNamespaceKey;
  readonly component: ComponentType<SlotComponentProps<SlotPropsOf<K>, TScope, TStore, TSelected>>;
}

export interface SlotEntryRecord {
  readonly id: string;
  readonly slotKey: string;
  readonly pluginId: string;
  readonly tier: PluginTier;
  readonly priority: number;
  readonly order: number;
  readonly registeredSeq: number;
  readonly keys?: readonly string[];
  readonly matchKey?: (routeKey: string) => boolean;
  readonly select?: SlotChainSelector<Record<string, unknown>, unknown>;
  readonly overlay: boolean;
  readonly children: ChildrenDecl;
  readonly hasStore: boolean;
  readonly locale?: LocaleNamespaceKey;
  readonly ctx?: Context;
  readonly component: ComponentType<Record<string, unknown>>;
}

export interface SlotFactoryRegistrationInput<
  K extends AnyFactoryKey = AnyFactoryKey,
  TStore = unknown,
  TScope extends SlotScope = FactoryScopeOf<K>,
> {
  readonly id?: string;
  readonly pluginId?: string;
  readonly tier?: PluginTier;
  readonly priority?: number;
  readonly scope?: TScope;
  readonly store?: StoreDecl<TStore, FactoryPropsOf<K>>;
  readonly locale?: LocaleNamespaceKey;
  readonly component: ComponentType<SlotComponentProps<FactoryPropsOf<K>, TScope, TStore, never>>;
}

export interface SlotFactoryEntryRecord {
  readonly id: string;
  readonly factoryKey: string;
  readonly pluginId: string;
  readonly tier: PluginTier;
  readonly priority: number;
  readonly registeredSeq: number;
  readonly scope: SlotScope;
  readonly storeDecl?: StoreDecl<unknown, unknown>;
  readonly locale?: LocaleNamespaceKey;
  readonly ctx?: Context;
  readonly component: ComponentType<Record<string, unknown>>;
}

export interface SlotWrapperProps<TProps = Record<string, unknown>> {
  readonly slotKey: string;
  readonly props: TProps;
  readonly children: ReactNode;
}

export type SlotWrapperComponent<TProps = Record<string, unknown>> = ComponentType<SlotWrapperProps<TProps>>;

export interface SlotWrapperRegistrationInput<K extends AnySlotKey = AnySlotKey> {
  readonly id?: string;
  readonly pluginId?: string;
  readonly tier?: PluginTier;
  readonly priority?: number;
  readonly order?: number;
  readonly component: SlotWrapperComponent<SlotPropsOf<K>>;
}

export type SlotWrapperInput<K extends AnySlotKey = AnySlotKey> =
  | SlotWrapperComponent<SlotPropsOf<K>>
  | SlotWrapperRegistrationInput<K>;

export interface SlotWrapperRecord {
  readonly id: string;
  readonly slotKey: string;
  readonly pluginId: string;
  readonly tier: PluginTier;
  readonly priority: number;
  readonly order: number;
  readonly registeredSeq: number;
  readonly component: SlotWrapperComponent<Record<string, unknown>>;
}

/** Adapter bridging external session state and `<SessionArea>` lifecycle into the slot kernel. */
export interface SlotScopeAdapter {
  /** Resolve the ambient active session ID when no `<SessionArea>` overrides it. */
  getActiveSessionId(): string | null;
  /** Subscribe to active session ID changes for reactive re-renders. */
  subscribeActiveSession?(listener: () => void): () => void;
  /** Optional lifecycle hook invoked when a `<SessionArea sessionId>` mounts/unmounts. */
  onScopeMount?(scopeKey: string, sessionId: string): (() => void) | void;
}

export interface SlotCandidateSummary {
  readonly id: string;
  readonly pluginId: string;
  readonly tier: PluginTier;
  readonly priority: number;
  readonly order: number;
  readonly abdicated: boolean;
}

export interface SlotInspection {
  readonly slotKey: string;
  readonly kind: SlotKind;
  readonly scope: SlotScope;
  readonly override?: string;
  readonly winner?: SlotCandidateSummary;
  readonly candidates: readonly SlotCandidateSummary[];
  readonly wrapperIds: readonly string[];
}

/** Thrown when a component attempts to render or claim a child slot it does not own. */
export class SlotOwnershipError extends Error {
  readonly entryId: string;
  readonly slotKey: string;
  readonly ownedSlots: readonly string[];

  constructor(entryId: string, slotKey: string, ownedSlots: readonly string[], detail?: string) {
    const summary = ownedSlots.length > 0 ? ownedSlots.join(", ") : "(none)";
    super(
      detail ??
        `Slot entry "${entryId}" is not authorized to render child slot "${slotKey}" (owned children: ${summary})`,
    );
    this.name = "SlotOwnershipError";
    this.entryId = entryId;
    this.slotKey = slotKey;
    this.ownedSlots = ownedSlots;
  }
}

/** Thrown when a captured `renderSlot` / `renderSlotChain` handle is invoked after its Fiber disposed. */
export class StaleAuthorizationError extends Error {
  readonly entryId: string;
  readonly slotKey: string;

  constructor(entryId: string, slotKey: string) {
    super(`Stale slot authorization handle for disposed entry "${entryId}" attempting to render "${slotKey}"`);
    this.name = "StaleAuthorizationError";
    this.entryId = entryId;
    this.slotKey = slotKey;
  }
}
