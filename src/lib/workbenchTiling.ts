export type WorkbenchSplitDirection = "horizontal" | "vertical";
export type PaneDropZone = "swap" | "left" | "right" | "top" | "bottom";

export interface WorkbenchLeafNode {
  type: "leaf";
  paneId: string;
}

export interface WorkbenchSplitNode {
  type: "split";
  id: string;
  direction: WorkbenchSplitDirection;
  ratio: number;
  first: WorkbenchTileNode;
  second: WorkbenchTileNode;
}

export type WorkbenchTileNode = WorkbenchLeafNode | WorkbenchSplitNode;

export interface NormalizedRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface WorkbenchTileSash {
  id: string;
  direction: WorkbenchSplitDirection;
  /** Fraction [0..1] along primary axis (`left` for horizontal split, `top` for vertical split). */
  offset: number;
  /** Fraction [0..1] along secondary axis (`top` for horizontal split, `left` for vertical split). */
  start: number;
  /** Fraction [0..1] span along secondary axis (`height` for horizontal split, `width` for vertical split). */
  span: number;
  container: NormalizedRect;
}

export interface ComputedTileLayout {
  panes: Record<string, NormalizedRect>;
  sashes: WorkbenchTileSash[];
  hasHorizontalSplit: boolean;
}

const MIN_SPLIT_RATIO = 0.22;
const MAX_SPLIT_RATIO = 0.78;
let splitSeq = 0;

function nextSplitId(): string {
  splitSeq += 1;
  return `tile-split-${splitSeq}`;
}

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

export function collectTreePanes(root: WorkbenchTileNode | null): string[] {
  if (!root) return [];
  if (root.type === "leaf") return [root.paneId];
  return [...collectTreePanes(root.first), ...collectTreePanes(root.second)];
}

export function hasPaneInTree(root: WorkbenchTileNode | null, paneId: string): boolean {
  if (!root) return false;
  if (root.type === "leaf") return root.paneId === paneId;
  return hasPaneInTree(root.first, paneId) || hasPaneInTree(root.second, paneId);
}

export function hasHorizontalSplitInTree(root: WorkbenchTileNode | null): boolean {
  if (!root || root.type === "leaf") return false;
  if (root.direction === "horizontal") return true;
  return hasHorizontalSplitInTree(root.first) || hasHorizontalSplitInTree(root.second);
}

function countLeaves(root: WorkbenchTileNode): number {
  if (root.type === "leaf") return 1;
  return countLeaves(root.first) + countLeaves(root.second);
}

/**
 * Inserts a new pane following Claude Desktop's top-and-bottom priority:
 * 1 -> 2 stacks vertically (existing top, new bottom), 2+ vertically expands into 2 columns.
 */
export function insertPaneIntoTree(root: WorkbenchTileNode | null, paneId: string): WorkbenchTileNode {
  if (!root) return { type: "leaf", paneId };
  if (hasPaneInTree(root, paneId)) return root;
  if (root.type === "leaf") {
    return {
      type: "split",
      id: nextSplitId(),
      direction: "vertical",
      ratio: 0.5,
      first: root,
      second: { type: "leaf", paneId },
    };
  }
  if (root.direction === "vertical") {
    return {
      type: "split",
      id: nextSplitId(),
      direction: "horizontal",
      ratio: 0.56,
      first: root,
      second: { type: "leaf", paneId },
    };
  }
  const firstCount = countLeaves(root.first);
  const secondCount = countLeaves(root.second);
  if (firstCount < secondCount) {
    return { ...root, first: insertPaneIntoTree(root.first, paneId) };
  }
  return { ...root, second: insertPaneIntoTree(root.second, paneId) };
}

export function removePaneFromTree(root: WorkbenchTileNode | null, paneId: string): WorkbenchTileNode | null {
  if (!root) return null;
  if (root.type === "leaf") return root.paneId === paneId ? null : root;
  const first = removePaneFromTree(root.first, paneId);
  const second = removePaneFromTree(root.second, paneId);
  if (!first) return second;
  if (!second) return first;
  if (first === root.first && second === root.second) return root;
  return { ...root, first, second };
}

export function pruneTreeToAllowed(root: WorkbenchTileNode | null, allowed: ReadonlySet<string>): WorkbenchTileNode | null {
  if (!root) return null;
  if (root.type === "leaf") return allowed.has(root.paneId) ? root : null;
  const first = pruneTreeToAllowed(root.first, allowed);
  const second = pruneTreeToAllowed(root.second, allowed);
  if (!first) return second;
  if (!second) return first;
  if (first === root.first && second === root.second) return root;
  return { ...root, first, second };
}

function swapLeavesInTree(node: WorkbenchTileNode, a: string, b: string): WorkbenchTileNode {
  if (node.type === "leaf") {
    if (node.paneId === a) return { type: "leaf", paneId: b };
    if (node.paneId === b) return { type: "leaf", paneId: a };
    return node;
  }
  return {
    ...node,
    first: swapLeavesInTree(node.first, a, b),
    second: swapLeavesInTree(node.second, a, b),
  };
}

function dockLeafInTree(
  node: WorkbenchTileNode,
  sourceId: string,
  targetId: string,
  zone: Exclude<PaneDropZone, "swap">,
): WorkbenchTileNode {
  if (node.type === "leaf") {
    if (node.paneId !== targetId) return node;
    const direction: WorkbenchSplitDirection = zone === "left" || zone === "right" ? "horizontal" : "vertical";
    const sourceFirst = zone === "left" || zone === "top";
    const sourceLeaf: WorkbenchLeafNode = { type: "leaf", paneId: sourceId };
    return {
      type: "split",
      id: nextSplitId(),
      direction,
      ratio: 0.5,
      first: sourceFirst ? sourceLeaf : node,
      second: sourceFirst ? node : sourceLeaf,
    };
  }
  return {
    ...node,
    first: dockLeafInTree(node.first, sourceId, targetId, zone),
    second: dockLeafInTree(node.second, sourceId, targetId, zone),
  };
}

export function moveOrSwapPaneInTree(
  root: WorkbenchTileNode | null,
  sourceId: string,
  targetId: string,
  zone: PaneDropZone = "swap",
): WorkbenchTileNode | null {
  if (!root || !sourceId || !targetId || sourceId === targetId) return root;
  if (!hasPaneInTree(root, sourceId) || !hasPaneInTree(root, targetId)) return root;
  if (zone === "swap") return swapLeavesInTree(root, sourceId, targetId);
  const withoutSource = removePaneFromTree(root, sourceId);
  if (!withoutSource) return root;
  return dockLeafInTree(withoutSource, sourceId, targetId, zone);
}

export function updateSplitRatioInTree(
  root: WorkbenchTileNode | null,
  splitId: string,
  ratio: number,
): WorkbenchTileNode | null {
  if (!root || root.type === "leaf") return root;
  const clamped = clampSplitRatio(ratio);
  if (root.id === splitId) {
    return root.ratio === clamped ? root : { ...root, ratio: clamped };
  }
  const first = updateSplitRatioInTree(root.first, splitId, clamped);
  const second = updateSplitRatioInTree(root.second, splitId, clamped);
  if (!first || !second) return root;
  if (first === root.first && second === root.second) return root;
  return { ...root, first, second };
}

export function flipRootDirectionInTree(
  root: WorkbenchTileNode | null,
  direction: WorkbenchSplitDirection,
): WorkbenchTileNode | null {
  if (!root || root.type === "leaf") return root;
  return root.direction === direction ? root : { ...root, direction };
}

export function computeTileLayout(root: WorkbenchTileNode | null): ComputedTileLayout {
  const panes: Record<string, NormalizedRect> = {};
  const sashes: WorkbenchTileSash[] = [];
  if (!root) return { panes, sashes, hasHorizontalSplit: false };

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

export interface DraftDiffComment {
  id: string;
  file: string;
  line: number;
  side: "new" | "old";
  lineText: string;
  body: string;
  createdAt: number;
}

export interface UpsertDraftDiffCommentInput {
  id?: string;
  file: string;
  line: number;
  side: "new" | "old";
  lineText: string;
  body: string;
}

export interface WorkbenchGridColumns {
  col1: string[];
  col2: string[];
  hasCol2: boolean;
}

export function computeGridColumns(
  panes: readonly string[],
  twoPaneDirection: WorkbenchSplitDirection,
  leftColumnCount: number | null,
): WorkbenchGridColumns {
  if (panes.length === 0) return { col1: [], col2: [], hasCol2: false };
  if (panes.length === 1) return { col1: [panes[0] ?? "files"], col2: [], hasCol2: false };
  if (panes.length === 2) {
    return twoPaneDirection === "vertical"
      ? { col1: [...panes], col2: [], hasCol2: false }
      : { col1: [panes[0] ?? "files"], col2: [panes[1] ?? "preview"], hasCol2: true };
  }
  const splitIndex = Math.min(panes.length - 1, Math.max(1, leftColumnCount ?? 2));
  return { col1: panes.slice(0, splitIndex), col2: panes.slice(splitIndex), hasCol2: true };
}

export function formatDraftDiffCommentsPrompt(comments: readonly DraftDiffComment[]): string {
  if (comments.length === 0) return "";
  const lines: string[] = [`请根据以下 ${comments.length} 条代码审查行内批注进行修改：`, ""];
  comments.forEach((item, index) => {
    const loc = item.side === "old" ? `${item.file} (旧行 ${item.line})` : `${item.file}:${item.line}`;
    lines.push(`${index + 1}. **${loc}**`);
    const snippet = item.lineText.trim();
    if (snippet) lines.push(`   > \`${snippet.slice(0, 140)}\``);
    lines.push(`   - 修改意见：${item.body.trim()}`);
  });
  lines.push("", "请逐项应用上述修改，并简要说明改动内容。");
  return lines.join("\n");
}
