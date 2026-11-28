/**
 * Pure candidate filtering & chain selector evaluation (`select(ownerProps)` +
 * `overlay: true` shadowed fallback preservation) for `@qianji/client-slots`.
 */
import type { SlotRegistry } from "./registry";
import type { SlotEntryRecord } from "./types";

export interface ResolvedChainItem {
  readonly entry: SlotEntryRecord;
  readonly selected: unknown;
  readonly hidden: boolean;
  readonly fallbackCandidate?: SlotEntryRecord;
}

/** Filter out abdicated/locked-out candidates while promoting external lockouts into abdication records. */
export function filterAvailableCandidates(
  slotKey: string,
  rankedCandidates: readonly SlotEntryRecord[],
  registry: SlotRegistry,
): SlotEntryRecord[] {
  const available: SlotEntryRecord[] = [];
  for (let i = 0; i < rankedCandidates.length; i += 1) {
    const cand = rankedCandidates[i];
    if (cand === undefined) continue;
    const nextFallback = rankedCandidates.slice(i + 1).find(
      (next) => !registry.abdication.isAbdicated(slotKey, next.id, next.pluginId),
    );
    if (
      registry.abdication.promoteLockoutIfNeeded(
        slotKey,
        cand.id,
        cand.pluginId,
        nextFallback === undefined ? undefined : { id: nextFallback.id, pluginId: nextFallback.pluginId },
      )
    ) {
      continue;
    }
    available.push(cand);
  }
  return available;
}

/**
 * Evaluate pure `select(ownerProps)` predicates along a ranked chain.
 * - Synchronous throws inside `select` immediately abdicate that entry and fall through.
 * - When a winning entry declares `overlay: true`, lower-priority matching entries
 *   remain mounted beneath it (marked `hidden: true` so the renderer applies `display: none`)
 *   down to the first non-overlay fallback entry, preserving composer drafts & DOM state.
 */
export function resolveChainItems(
  slotKey: string,
  rankedCandidates: readonly SlotEntryRecord[],
  ownerProps: Record<string, unknown>,
  registry: SlotRegistry,
): ResolvedChainItem[] {
  const eligible = filterAvailableCandidates(slotKey, rankedCandidates, registry);
  const matchedStack: Array<{ entry: SlotEntryRecord; selected: unknown; fallback?: SlotEntryRecord }> = [];

  for (let i = 0; i < eligible.length; i += 1) {
    const entry = eligible[i];
    if (entry === undefined) continue;
    let selected: unknown;
    if (entry.select !== undefined) {
      try {
        const result = entry.select(ownerProps);
        if (result === null || result === undefined || result === false) {
          continue;
        }
        selected = result;
      } catch (selectError) {
        const fallback = eligible[i + 1];
        registry.abdication.abdicate({
          slotKey,
          entryId: entry.id,
          pluginId: entry.pluginId,
          error: selectError,
          ...(fallback === undefined ? {} : { fallbackEntryId: fallback.id, fallbackPluginId: fallback.pluginId }),
          deferEmit: true,
        });
        continue;
      }
    }
    const nextMatchingFallback = eligible.slice(i + 1).find((cand) => {
      if (cand.select === undefined) return true;
      try {
        const res = cand.select(ownerProps);
        return res !== null && res !== undefined && res !== false;
      } catch {
        return false;
      }
    });
    matchedStack.push({ entry, selected, fallback: nextMatchingFallback });
    if (!entry.overlay) {
      break;
    }
  }

  if (matchedStack.length === 0) return [];
  // Emit bottom-to-top so base fallback keeps a stable DOM position/key across overlay takeovers.
  const ordered: ResolvedChainItem[] = [];
  for (let i = matchedStack.length - 1; i >= 0; i -= 1) {
    const item = matchedStack[i];
    if (item === undefined) continue;
    ordered.push({
      entry: item.entry,
      selected: item.selected,
      hidden: i > 0,
      ...(item.fallback === undefined ? {} : { fallbackCandidate: item.fallback }),
    });
  }
  return ordered;
}
