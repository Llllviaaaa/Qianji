/**
 * Per-occurrence isolated factory renderer (`<SlotFactoryHost>`) with
 * independent ErrorBoundary, Abdication fallback, and managed Store retention.
 */
import { useContext, useEffect, useId, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  resolveTranslator,
  SlotKernelContext,
  SlotKernelErrorBoundary,
  useResolvedScopeTarget,
} from "./boundaries";
import type { SlotRegistry } from "./registry";
import type {
  BoundRenderFactoryFn,
  BoundRenderSlotChainFn,
  BoundRenderSlotFn,
  SlotFactoryEntryRecord,
  SlotScope,
  SlotScopeTargetMap,
} from "./types";

export interface SlotFactoryHostProps {
  readonly factoryKey: string;
  readonly props?: Record<string, unknown>;
  readonly occurrenceKey?: string;
  readonly sessionId?: string | null;
  readonly compact?: boolean;
  readonly fallback?: ReactNode;
  readonly registry?: SlotRegistry;
  readonly rootCtx?: Context;
}

function FactoryOccurrenceBody({
  factoryKey,
  entry,
  occurrenceKey,
  registry,
  rootCtx,
  ownerProps,
  scopeTarget,
}: {
  readonly factoryKey: string;
  readonly entry: SlotFactoryEntryRecord;
  readonly occurrenceKey: string;
  readonly registry: SlotRegistry;
  readonly rootCtx?: Context;
  readonly ownerProps: Record<string, unknown>;
  readonly scopeTarget: SlotScopeTargetMap[SlotScope];
}): ReactNode {
  const store = entry.storeDecl !== undefined
    ? registry.stores.ensureFactorySeat(
        factoryKey,
        occurrenceKey,
        scopeTarget.scopeKey,
        ownerProps,
        { entryId: entry.id, decl: entry.storeDecl },
      )
    : undefined;

  useEffect(() => {
    if (entry.storeDecl === undefined) return undefined;
    const retained = registry.stores.retainFactoryOccurrence(
      factoryKey,
      occurrenceKey,
      scopeTarget.scopeKey,
      ownerProps,
      { entryId: entry.id, decl: entry.storeDecl },
    );
    return () => {
      retained.release();
    };
    // Retain strictly per (factoryKey, entry, occurrenceKey, scopeKey) seat lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, factoryKey, entry.id, entry.storeDecl, occurrenceKey, scopeTarget.scopeKey]);

  const renderFactory = useMemo<BoundRenderFactoryFn>(
    () => (nestedKey, nestedProps, nestedOpts) => (
      <SlotFactoryHost
        factoryKey={nestedKey}
        props={(nestedProps ?? {}) as Record<string, unknown>}
        occurrenceKey={nestedOpts?.occurrenceKey}
        sessionId={nestedOpts?.sessionId}
        compact={nestedOpts?.compact}
        fallback={nestedOpts?.fallback}
        registry={registry}
        rootCtx={rootCtx}
      />
    ),
    [registry, rootCtx],
  );
  const unownedSlot: BoundRenderSlotFn = (childSlotKey) => {
    throw new Error(`Factory "${factoryKey}" entry "${entry.id}" cannot render unowned slot "${childSlotKey}"`);
  };
  const unownedChain: BoundRenderSlotChainFn = (childSlotKey) => {
    throw new Error(`Factory "${factoryKey}" entry "${entry.id}" cannot render unowned chain "${childSlotKey}"`);
  };

  const effectiveCtx = entry.ctx ?? rootCtx;
  const t = resolveTranslator(effectiveCtx, entry.locale);
  const Comp = entry.component;
  const injectedProps: Record<string, unknown> = {
    ...ownerProps,
    ...(effectiveCtx === undefined ? {} : { ctx: effectiveCtx }),
    scope: scopeTarget,
    ...(scopeTarget.scope === "root" ? {} : { sessionId: scopeTarget.sessionId }),
    renderSlot: unownedSlot,
    renderSlotChain: unownedChain,
    renderFactory,
    ...(t === undefined ? {} : { t }),
    store,
  };
  return <Comp {...injectedProps} />;
}

/** Per-occurrence isolated factory renderer with independent ErrorBoundary and Store retention. */
export function SlotFactoryHost({
  factoryKey,
  props,
  occurrenceKey,
  sessionId,
  compact = false,
  fallback = null,
  registry: explicitRegistry,
  rootCtx: explicitCtx,
}: SlotFactoryHostProps): ReactNode {
  const autoId = useId();
  const resolvedOccurrenceKey = occurrenceKey ?? autoId;
  const kernel = useContext(SlotKernelContext);
  const registry = explicitRegistry ?? kernel.registry;
  const rootCtx = explicitCtx ?? kernel.rootCtx;

  useSyncExternalStore(registry.subscribe, registry.getVersion, registry.getVersion);

  const ranked = registry.getFactoryCandidates(factoryKey);
  const slotKey = `factory:${factoryKey}`;
  const available: SlotFactoryEntryRecord[] = [];
  for (let i = 0; i < ranked.length; i += 1) {
    const cand = ranked[i];
    if (cand === undefined) continue;
    const nextFallbackCand = ranked.slice(i + 1).find(
      (next) => !registry.abdication.isAbdicated(slotKey, next.id, next.pluginId),
    );
    if (
      registry.abdication.promoteLockoutIfNeeded(
        slotKey,
        cand.id,
        cand.pluginId,
        nextFallbackCand === undefined ? undefined : { id: nextFallbackCand.id, pluginId: nextFallbackCand.pluginId },
      )
    ) {
      continue;
    }
    available.push(cand);
  }
  const winner = available[0];
  const nextFallback = available[1];
  const scopeTarget = useResolvedScopeTarget(registry, winner?.scope ?? "root", sessionId);

  if (winner === undefined || scopeTarget === null) {
    return fallback;
  }

  const ownerProps = props ?? {};
  return (
    <div
      data-qj-plugin={winner.pluginId}
      data-qj-factory={factoryKey}
      data-qj-occurrence={resolvedOccurrenceKey}
      style={{ display: "contents" }}
    >
      <SlotKernelErrorBoundary
        key={`${winner.id}:${resolvedOccurrenceKey}:${registry.abdication.getCycleKey(winner.pluginId)}`}
        pluginId={winner.pluginId}
        entryId={winner.id}
        slotKey={slotKey}
        compact={compact}
        hasFallbackCandidate={nextFallback !== undefined}
        onCrash={(error) => {
          registry.abdication.abdicate({
            slotKey,
            entryId: winner.id,
            pluginId: winner.pluginId,
            error,
            ...(nextFallback === undefined
              ? {}
              : { fallbackEntryId: nextFallback.id, fallbackPluginId: nextFallback.pluginId }),
          });
        }}
      >
        <FactoryOccurrenceBody
          factoryKey={factoryKey}
          entry={winner}
          occurrenceKey={resolvedOccurrenceKey}
          registry={registry}
          rootCtx={rootCtx}
          ownerProps={ownerProps}
          scopeTarget={scopeTarget}
        />
      </SlotKernelErrorBoundary>
    </div>
  );
}
