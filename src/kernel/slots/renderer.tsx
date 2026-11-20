/**
 * React 19 Fault-Isolated Slot Kernel Renderer (`@qianji/client-slots`, ADR 0023 §2 & §5).
 *
 * Renders `single`, `list`, `keyed`, and `chain` (with `overlay: true`) slots,
 * onion decorators (`ctx.slots.wrap`), ownership-bound `renderSlot` / `renderSlotChain`,
 * and `<SlotRoot>`. Boundaries, chain logic, and factory hosting live in sibling modules.
 */
import { useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  createResourceCell,
  resolveTranslator,
  SessionArea,
  SessionProvider,
  SlotKernelContext,
  SlotKernelErrorBoundary,
  SlotKernelProvider,
  useResolvedScopeTarget,
  useResource,
  useSlotScope,
  WrapperErrorBoundary,
  type ResourceCell,
  type ResourceServiceLike,
  type SessionAreaProps,
  type SlotKernelErrorBoundaryProps,
  type SlotKernelProviderProps,
  type WrapperErrorBoundaryProps,
} from "./boundaries";
import { filterAvailableCandidates, resolveChainItems, type ResolvedChainItem } from "./chain";
import { SlotFactoryHost, type SlotFactoryHostProps } from "./factoryHost";
import { clientSlotsRegistry, type SlotAuthorization, type SlotRegistry } from "./registry";
import {
  StaleAuthorizationError,
  type AnyFactoryKey,
  type AnySlotKey,
  type BoundRenderFactoryFn,
  type BoundRenderSlotChainFn,
  type BoundRenderSlotFn,
  type FactoryPropsOf,
  type RenderFactoryOptions,
  type RenderSlotChainOptions,
  type RenderSlotOptions,
  type SlotEntryRecord,
  type SlotKind,
  type SlotPropsOf,
  type SlotScope,
  type SlotScopeTargetMap,
} from "./types";

export {
  createResourceCell,
  resolveChainItems,
  SessionArea,
  SessionProvider,
  SlotFactoryHost,
  SlotKernelErrorBoundary,
  SlotKernelProvider,
  useResource,
  useSlotScope,
  WrapperErrorBoundary,
  type ResolvedChainItem,
  type ResourceCell,
  type ResourceServiceLike,
  type SessionAreaProps,
  type SlotFactoryHostProps,
  type SlotKernelErrorBoundaryProps,
  type SlotKernelProviderProps,
  type WrapperErrorBoundaryProps,
};

/** Create ownership- and liveness-enforced `renderSlot` / `renderSlotChain` / `renderFactory` handles. */
export function createBoundRenderers(
  registry: SlotRegistry,
  auth: SlotAuthorization,
  rootCtx?: Context,
): {
  readonly renderSlot: BoundRenderSlotFn;
  readonly renderSlotChain: BoundRenderSlotChainFn;
  readonly renderFactory: BoundRenderFactoryFn;
} {
  const renderSlot: BoundRenderSlotFn = <K extends AnySlotKey>(
    childSlotKey: K,
    props?: SlotPropsOf<K>,
    options?: RenderSlotOptions,
  ): ReactNode => {
    const spec = auth.assertAuthorized(childSlotKey);
    return (
      <SlotHost
        slotKey={childSlotKey}
        kind={spec.kind}
        scope={spec.scope}
        props={(props ?? {}) as Record<string, unknown>}
        routeKey={options?.key}
        mode={options?.mode}
        sessionId={options?.sessionId}
        compact={options?.compact}
        fallback={options?.fallback}
        registry={registry}
        rootCtx={rootCtx}
      />
    );
  };

  const renderSlotChain: BoundRenderSlotChainFn = <K extends AnySlotKey>(
    childSlotKey: K,
    props?: SlotPropsOf<K>,
    options?: RenderSlotChainOptions,
  ): ReactNode => {
    const spec = auth.assertAuthorized(childSlotKey, "chain");
    return (
      <SlotHost
        slotKey={childSlotKey}
        kind="chain"
        scope={spec.scope}
        props={(props ?? {}) as Record<string, unknown>}
        sessionId={options?.sessionId}
        compact={options?.compact}
        fallback={options?.fallback}
        registry={registry}
        rootCtx={rootCtx}
      />
    );
  };

  const renderFactory: BoundRenderFactoryFn = <K extends AnyFactoryKey>(
    factoryKey: K,
    props?: FactoryPropsOf<K>,
    options?: RenderFactoryOptions,
  ): ReactNode => {
    if (auth.isDisposed) {
      throw new StaleAuthorizationError(auth.entryId, factoryKey);
    }
    return (
      <SlotFactoryHost
        factoryKey={factoryKey}
        props={(props ?? {}) as Record<string, unknown>}
        occurrenceKey={options?.occurrenceKey}
        sessionId={options?.sessionId}
        compact={options?.compact}
        fallback={options?.fallback}
        registry={registry}
        rootCtx={rootCtx}
      />
    );
  };

  return { renderSlot, renderSlotChain, renderFactory };
}

function buildBoundRenderersOrFallback(
  registry: SlotRegistry,
  entryId: string,
  rootCtx?: Context,
  _registeredSeq?: number,
): {
  readonly renderSlot: BoundRenderSlotFn;
  readonly renderSlotChain: BoundRenderSlotChainFn;
  readonly renderFactory: BoundRenderFactoryFn;
} {
  const auth = registry.getAuthorization(entryId);
  if (auth !== undefined) {
    return createBoundRenderers(registry, auth, rootCtx);
  }
  return {
    renderSlot: (childSlotKey) => {
      throw new StaleAuthorizationError(entryId, childSlotKey);
    },
    renderSlotChain: (childSlotKey) => {
      throw new StaleAuthorizationError(entryId, childSlotKey);
    },
    renderFactory: (factoryKey) => {
      throw new StaleAuthorizationError(entryId, factoryKey);
    },
  };
}

function EntryInvokeBody({
  entry,
  registry,
  rootCtx,
  ownerProps,
  scopeTarget,
  selected,
}: {
  readonly entry: SlotEntryRecord;
  readonly registry: SlotRegistry;
  readonly rootCtx?: Context;
  readonly ownerProps: Record<string, unknown>;
  readonly scopeTarget: SlotScopeTargetMap[SlotScope];
  readonly selected?: unknown;
}): ReactNode {
  const bound = useMemo(
    () => buildBoundRenderersOrFallback(registry, entry.id, rootCtx, entry.registeredSeq),
    [registry, entry.id, rootCtx, entry.registeredSeq],
  );
  const store = entry.hasStore
    ? registry.stores.storeOf(entry.id, scopeTarget.scopeKey, ownerProps)
    : undefined;
  const effectiveCtx = entry.ctx ?? rootCtx;
  const t = resolveTranslator(effectiveCtx, entry.locale);
  const Comp = entry.component;
  const injectedProps: Record<string, unknown> = {
    ...ownerProps,
    ...(effectiveCtx === undefined ? {} : { ctx: effectiveCtx }),
    scope: scopeTarget,
    ...(scopeTarget.scope === "root" ? {} : { sessionId: scopeTarget.sessionId }),
    renderSlot: bound.renderSlot,
    renderSlotChain: bound.renderSlotChain,
    renderFactory: bound.renderFactory,
    ...(t === undefined ? {} : { t }),
    store,
    ...(selected === undefined ? {} : { selected }),
  };
  return <Comp {...injectedProps} />;
}

function SlotWrapOnion({
  slotKey,
  registry,
  ownerProps,
  children,
}: {
  readonly slotKey: string;
  readonly registry: SlotRegistry;
  readonly ownerProps: Record<string, unknown>;
  readonly children: ReactNode;
}): ReactNode {
  const wrappers = registry.getWrappers(slotKey);
  if (wrappers.length === 0) return children;
  const activeWrappers = wrappers.filter(
    (w) => !registry.abdication.isAbdicated(`wrap:${slotKey}`, w.id, w.pluginId),
  );
  let node: ReactNode = children;
  for (let i = activeWrappers.length - 1; i >= 0; i -= 1) {
    const wrapper = activeWrappers[i];
    if (wrapper === undefined) continue;
    const innerNode = node;
    const WrapperComp = wrapper.component;
    const cycleKey = registry.abdication.getCycleKey(wrapper.pluginId);
    node = (
      <WrapperErrorBoundary
        key={`${wrapper.id}:${cycleKey}`}
        wrapperId={wrapper.id}
        pluginId={wrapper.pluginId}
        slotKey={slotKey}
        fallback={innerNode}
        onCrash={(error) => {
          registry.abdication.abdicate({
            slotKey: `wrap:${slotKey}`,
            entryId: wrapper.id,
            pluginId: wrapper.pluginId,
            error,
          });
        }}
      >
        <div
          data-qj-plugin={wrapper.pluginId}
          data-qj-wrapper={wrapper.id}
          style={{ display: "contents" }}
        >
          <WrapperComp slotKey={slotKey} props={ownerProps}>
            {innerNode}
          </WrapperComp>
        </div>
      </WrapperErrorBoundary>
    );
  }
  return node;
}

export interface SlotHostProps {
  readonly slotKey: string;
  readonly kind?: SlotKind;
  readonly scope?: SlotScope;
  readonly props?: Record<string, unknown>;
  readonly routeKey?: string;
  readonly mode?: "single" | "all";
  readonly sessionId?: string | null;
  readonly compact?: boolean;
  readonly fallback?: ReactNode;
  readonly registry?: SlotRegistry;
  readonly rootCtx?: Context;
}

export function SlotHost({
  slotKey,
  kind,
  scope,
  props,
  routeKey,
  mode = "single",
  sessionId,
  compact = false,
  fallback = null,
  registry: explicitRegistry,
  rootCtx: explicitCtx,
}: SlotHostProps): ReactNode {
  const kernel = useContext(SlotKernelContext);
  const registry = explicitRegistry ?? kernel.registry;
  const rootCtx = explicitCtx ?? kernel.rootCtx;

  useSyncExternalStore(registry.subscribe, registry.getVersion, registry.getVersion);

  const spec = registry.getSlotSpec(slotKey);
  const resolvedKind: SlotKind = kind ?? spec?.kind ?? "single";
  const resolvedScope: SlotScope = scope ?? spec?.scope ?? "root";
  const scopeTarget = useResolvedScopeTarget(registry, resolvedScope, sessionId);
  const ownerProps = props ?? {};

  if (scopeTarget === null) return fallback;

  const renderEntry = (
    entry: SlotEntryRecord,
    nextCandidate?: SlotEntryRecord,
    selected?: unknown,
    chainHidden?: boolean,
  ): ReactNode => (
    <div
      key={entry.id}
      data-qj-plugin={entry.pluginId}
      data-qj-slot={slotKey}
      data-qj-entry={chainHidden === undefined ? entry.id : undefined}
      data-qj-chain-entry={chainHidden === undefined ? undefined : entry.id}
      data-qj-chain-hidden={chainHidden ? "true" : undefined}
      aria-hidden={chainHidden ? true : undefined}
      style={chainHidden ? { display: "none" } : { display: "contents" }}
    >
      <SlotKernelErrorBoundary
        key={`${entry.id}:${registry.abdication.getCycleKey(entry.pluginId)}`}
        pluginId={entry.pluginId}
        entryId={entry.id}
        slotKey={slotKey}
        compact={compact}
        hasFallbackCandidate={nextCandidate !== undefined}
        onCrash={(error) => {
          registry.abdication.abdicate({
            slotKey,
            entryId: entry.id,
            pluginId: entry.pluginId,
            error,
            ...(nextCandidate === undefined
              ? {}
              : { fallbackEntryId: nextCandidate.id, fallbackPluginId: nextCandidate.pluginId }),
          });
        }}
      >
        <EntryInvokeBody
          entry={entry}
          registry={registry}
          rootCtx={rootCtx}
          ownerProps={ownerProps}
          scopeTarget={scopeTarget}
          selected={selected}
        />
      </SlotKernelErrorBoundary>
    </div>
  );

  let body: ReactNode;
  if (resolvedKind === "list") {
    const entries = registry.getListEntries(slotKey);
    if (entries.length === 0) return fallback;
    body = <>{entries.map((entry) => renderEntry(entry))}</>;
  } else if (resolvedKind === "chain") {
    const chainItems = resolveChainItems(slotKey, registry.getRankedCandidates(slotKey), ownerProps, registry);
    if (chainItems.length === 0) return fallback;
    body = <>{chainItems.map((item) => renderEntry(item.entry, item.fallbackCandidate, item.selected, item.hidden))}</>;
  } else {
    const ranked = resolvedKind === "keyed"
      ? registry.getKeyedCandidates(slotKey, routeKey ?? "")
      : registry.getRankedCandidates(slotKey);
    const available = filterAvailableCandidates(slotKey, ranked, registry);
    if (available.length === 0) return fallback;
    const toRender = resolvedKind === "keyed" && mode === "all" ? available : [available[0]];
    body = (
      <>
        {toRender.map((entry, idx) => (entry === undefined ? null : renderEntry(entry, available[idx + 1])))}
      </>
    );
  }

  return (
    <SlotWrapOnion slotKey={slotKey} registry={registry} ownerProps={ownerProps}>
      {body}
    </SlotWrapOnion>
  );
}

/** Trusted root entry point rendering the microkernel's `"root"` slot tree. */
export function SlotRoot({
  slotKey = "root",
  props,
  registry = clientSlotsRegistry,
  ctx,
  fallback = null,
}: {
  readonly slotKey?: string;
  readonly props?: Record<string, unknown>;
  readonly registry?: SlotRegistry;
  readonly ctx?: Context;
  readonly fallback?: ReactNode;
}): ReactNode {
  return (
    <SlotKernelProvider registry={registry} ctx={ctx}>
      <SlotHost
        slotKey={slotKey}
        kind="single"
        scope="root"
        props={props}
        fallback={fallback}
        registry={registry}
        rootCtx={ctx}
      />
    </SlotKernelProvider>
  );
}
