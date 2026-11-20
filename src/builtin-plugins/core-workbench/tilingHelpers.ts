/**
 * Pure tiling layout math, slot-registry pane discovery, and fault-isolated
 * legacy contribution wrapper for `core-workbench` (ADR 0023).
 */
import { createElement, useSyncExternalStore, type ReactNode } from "react";
import type {
  ClientWorkbenchTabContribution,
  PaneDropZone,
  WorkbenchSplitDirection,
  WorkbenchTileNode,
} from "@qianji/client";
import {
  SlotKernelErrorBoundary,
  type SlotRegistry,
} from "@qianji/client-slots";

export interface NormalizedRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface WorkbenchTileSash {
  readonly id: string;
  readonly direction: WorkbenchSplitDirection;
  readonly offset: number;
  readonly start: number;
  readonly span: number;
  readonly container: NormalizedRect;
}

export interface ComputedTileLayout {
  readonly panes: Readonly<Record<string, NormalizedRect>>;
  readonly sashes: readonly WorkbenchTileSash[];
  readonly hasHorizontalSplit: boolean;
}

const MIN_SPLIT_RATIO = 0.22;
const MAX_SPLIT_RATIO = 0.78;
let syntheticSplitSeq = 0;

function nextSyntheticSplitId(): string {
  syntheticSplitSeq += 1;
  return `cw-tile-split-${syntheticSplitSeq}`;
}

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

export function hasPaneInTree(root: WorkbenchTileNode | null, paneId: string): boolean {
  if (root === null) return false;
  if (root.type === "leaf") return root.paneId === paneId;
  return hasPaneInTree(root.first, paneId) || hasPaneInTree(root.second, paneId);
}

function countLeaves(root: WorkbenchTileNode): number {
  if (root.type === "leaf") return 1;
  return countLeaves(root.first) + countLeaves(root.second);
}

export function insertPaneIntoTree(root: WorkbenchTileNode | null, paneId: string): WorkbenchTileNode {
  if (root === null) return { type: "leaf", paneId };
  if (hasPaneInTree(root, paneId)) return root;
  if (root.type === "leaf") {
    return {
      type: "split",
      id: nextSyntheticSplitId(),
      direction: "vertical",
      ratio: 0.5,
      first: root,
      second: { type: "leaf", paneId },
    };
  }
  if (root.direction === "vertical") {
    return {
      type: "split",
      id: nextSyntheticSplitId(),
      direction: "horizontal",
      ratio: 0.56,
      first: root,
      second: { type: "leaf", paneId },
    };
  }
  if (countLeaves(root.first) < countLeaves(root.second)) {
    return { ...root, first: insertPaneIntoTree(root.first, paneId) };
  }
  return { ...root, second: insertPaneIntoTree(root.second, paneId) };
}

export function pruneTreeToAllowed(
  root: WorkbenchTileNode | null,
  allowed: ReadonlySet<string>,
): WorkbenchTileNode | null {
  if (root === null) return null;
  if (root.type === "leaf") return allowed.has(root.paneId) ? root : null;
  const first = pruneTreeToAllowed(root.first, allowed);
  const second = pruneTreeToAllowed(root.second, allowed);
  if (first === null) return second;
  if (second === null) return first;
  if (first === root.first && second === root.second) return root;
  return { ...root, first, second };
}

export function buildEffectiveTree(
  layoutTree: WorkbenchTileNode | null,
  activePanes: readonly string[],
): WorkbenchTileNode | null {
  const allowed = new Set(activePanes);
  let tree = pruneTreeToAllowed(layoutTree, allowed);
  for (const id of activePanes) {
    if (!hasPaneInTree(tree, id)) {
      tree = insertPaneIntoTree(tree, id);
    }
  }
  return tree;
}

export function computeTileLayout(root: WorkbenchTileNode | null): ComputedTileLayout {
  const panes: Record<string, NormalizedRect> = {};
  const sashes: WorkbenchTileSash[] = [];
  if (root === null) return { panes, sashes, hasHorizontalSplit: false };

  let hasHorizontalSplit = false;
  const walk = (node: WorkbenchTileNode, rect: NormalizedRect) => {
    if (node.type === "leaf") {
      panes[node.paneId] = rect;
      return;
    }
    const r = clampSplitRatio(node.ratio);
    if (node.direction === "horizontal") {
      hasHorizontalSplit = true;
      const firstWidth = rect.width * r;
      sashes.push({
        id: node.id,
        direction: "horizontal",
        offset: rect.left + firstWidth,
        start: rect.top,
        span: rect.height,
        container: rect,
      });
      walk(node.first, { left: rect.left, top: rect.top, width: firstWidth, height: rect.height });
      walk(node.second, {
        left: rect.left + firstWidth,
        top: rect.top,
        width: rect.width - firstWidth,
        height: rect.height,
      });
      return;
    }
    const firstHeight = rect.height * r;
    sashes.push({
      id: node.id,
      direction: "vertical",
      offset: rect.top + firstHeight,
      start: rect.left,
      span: rect.width,
      container: rect,
    });
    walk(node.first, { left: rect.left, top: rect.top, width: rect.width, height: firstHeight });
    walk(node.second, {
      left: rect.left,
      top: rect.top + firstHeight,
      width: rect.width,
      height: rect.height - firstHeight,
    });
  };

  walk(root, { left: 0, top: 0, width: 1, height: 1 });
  return { panes, sashes, hasHorizontalSplit };
}

export function detectPaneDropZone(relX: number, relY: number): PaneDropZone {
  const x = Math.min(1, Math.max(0, relX));
  const y = Math.min(1, Math.max(0, relY));
  if (x >= 0.28 && x <= 0.72 && y >= 0.28 && y <= 0.72) return "swap";
  const dLeft = x;
  const dRight = 1 - x;
  const dTop = y;
  const dBottom = 1 - y;
  const minDist = Math.min(dLeft, dRight, dTop, dBottom);
  if (minDist === dLeft) return "left";
  if (minDist === dRight) return "right";
  if (minDist === dTop) return "top";
  return "bottom";
}

export function hitTestPaneTarget(
  gridEl: HTMLDivElement | null,
  sourceId: string,
  clientX: number,
  clientY: number,
): { targetId: string | null; zone: PaneDropZone | null } {
  if (gridEl === null) return { targetId: null, zone: null };
  for (const el of gridEl.querySelectorAll<HTMLElement>("[data-pane-id]")) {
    const candidateId = el.dataset.paneId;
    if (!candidateId || candidateId === sourceId || el.hidden || el.style.display === "none") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
    return {
      targetId: candidateId,
      zone: detectPaneDropZone((clientX - rect.left) / rect.width, (clientY - rect.top) / rect.height),
    };
  }
  return { targetId: null, zone: null };
}

const NOOP_UNSUB = (): void => undefined;
const NOOP_SUBSCRIBE = (_listener: () => void): (() => void) => NOOP_UNSUB;
const ZERO_VERSION = (): number => 0;

/** Subscribe reactively to a `SlotRegistry`'s structural version counter. */
export function useSlotRegistryVersion(registry: SlotRegistry | undefined): number {
  return useSyncExternalStore(
    registry === undefined ? NOOP_SUBSCRIBE : registry.subscribe,
    registry === undefined ? ZERO_VERSION : registry.getVersion,
    registry === undefined ? ZERO_VERSION : registry.getVersion,
  );
}

/** True when at least one non-abdicated candidate is registered for `paneId` in `workbench.panes`. */
export function isPaneRegistered(registry: SlotRegistry | undefined, paneId: string): boolean {
  if (registry === undefined || paneId.trim() === "") return false;
  const candidates = registry.getKeyedCandidates("workbench.panes", paneId);
  return candidates.some((entry) => !registry.abdication.isAbdicated("workbench.panes", entry.id, entry.pluginId));
}

/** Filter requested open panes strictly against live `workbench.panes` entries + legacy `rightWorkbenchTabs`. */
export function filterRegisteredPanes(
  openPanes: readonly string[],
  registry: SlotRegistry | undefined,
  legacyTabs: readonly ClientWorkbenchTabContribution[],
): string[] {
  const legacyIds = new Set(legacyTabs.map((tab) => tab.id));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of openPanes) {
    const id = raw.trim();
    if (id === "" || seen.has(id)) continue;
    if (isPaneRegistered(registry, id) || legacyIds.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

const PRIMARY_WORKBENCH_PANE_KEYS = new Set(["files", "editor", "code", "terminal", "review", "preview"]);

/** Discover registered non-primary extension pane IDs dynamically from `workbench.panes`. */
export function listRegisteredExtensionPaneIds(registry: SlotRegistry | undefined): string[] {
  if (registry === undefined) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of registry.getEntries("workbench.panes")) {
    if (registry.abdication.isAbdicated("workbench.panes", entry.id, entry.pluginId)) continue;
    for (const rawKey of entry.keys ?? []) {
      const key = rawKey.trim();
      if (key === "" || key === "*" || key.endsWith("*") || PRIMARY_WORKBENCH_PANE_KEYS.has(key)) continue;
      if (!seen.has(key)) {
        seen.add(key);
        ids.push(key);
      }
    }
  }
  return ids;
}

/** Discover registered keyed bottom tab IDs dynamically from `workbench.bottom.tabs`. */
export function listRegisteredBottomTabIds(registry: SlotRegistry | undefined): string[] {
  if (registry === undefined) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of registry.getEntries("workbench.bottom.tabs")) {
    if (registry.abdication.isAbdicated("workbench.bottom.tabs", entry.id, entry.pluginId)) continue;
    for (const rawKey of entry.keys ?? []) {
      const key = rawKey.trim();
      if (key === "" || key === "*" || key.endsWith("*")) continue;
      if (!seen.has(key)) {
        seen.add(key);
        ids.push(key);
      }
    }
  }
  return ids;
}

const KNOWN_PANE_TITLES: Readonly<Record<string, string>> = {
  files: "工作区文件",
  editor: "工作区文件",
  code: "工作区文件",
  terminal: "终端",
  review: "代码变更",
  preview: "浏览器预览",
  "side-chat": "侧边对话",
  "intelligent-ui-canvas": "画布",
};

export function resolvePaneTitle(
  paneId: string,
  legacyTabs: readonly ClientWorkbenchTabContribution[],
): string {
  const known = KNOWN_PANE_TITLES[paneId];
  if (known !== undefined) return known;
  return legacyTabs.find((tab) => tab.id === paneId)?.label ?? paneId;
}

function LegacyBodyInvoker<TCtx>({
  renderFn,
  context,
}: {
  readonly renderFn: (ctx: TCtx) => ReactNode;
  readonly context: TCtx;
}): ReactNode {
  return renderFn(context);
}

/** Fault-isolated child Fiber wrapper for legacy `ctx.contributions` render callbacks. */
export function LegacyContributionHost<TCtx>({
  pluginId,
  entryId,
  slotKey,
  renderFn,
  context,
}: {
  readonly pluginId: string;
  readonly entryId: string;
  readonly slotKey: string;
  readonly renderFn: (ctx: TCtx) => ReactNode;
  readonly context: TCtx;
}): ReactNode {
  return createElement(
    "div",
    {
      "data-qj-plugin": pluginId,
      "data-qj-slot": slotKey,
      style: { display: "contents" },
    },
    createElement(SlotKernelErrorBoundary, {
      pluginId,
      entryId,
      slotKey,
      children: createElement(LegacyBodyInvoker<TCtx>, { renderFn, context }),
    }),
  );
}
