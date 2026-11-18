import { create } from "zustand";
import { clientContributions } from "../lib/clientContributions";
import { normalizeLocalPath } from "../lib/pathIdentity";
import {
  clampSplitRatio,
  collectTreePanes,
  flipRootDirectionInTree,
  insertPaneIntoTree,
  moveOrSwapPaneInTree,
  removePaneFromTree,
  updateSplitRatioInTree,
  type DraftDiffComment,
  type PaneDropZone,
  type UpsertDraftDiffCommentInput,
  type WorkbenchSplitDirection,
  type WorkbenchTileNode,
} from "../lib/workbenchTiling";
import { useAppStore } from "../store";
import { useBuiltinPluginGatesStore } from "./builtinPluginGatesStore";
import { useWorkbenchStore } from "./workbenchStore";

export * from "../lib/workbenchTiling";

export interface WorkbenchLayoutState {
  layoutTree: WorkbenchTileNode | null;
  openPanes: string[];
  inspectorOpen: boolean;
  maximizedPaneId: string | null;
  fileDrawerOpen: boolean;
  twoPaneDirection: WorkbenchSplitDirection;
  leftColumnCount: number | null;
  colRatio: number;
  leftRowRatio: number;
  rightRowRatio: number;
  /** Legacy compatibility fields retained for smooth callers/tests. */
  splitOpen: boolean;
  splitDirection: WorkbenchSplitDirection;
  secondaryTab: string;
  splitRatio: number;
  draftCommentsByCwd: Record<string, DraftDiffComment[]>;

  togglePane: (paneId: string) => void;
  openPane: (paneId: string) => void;
  activateExtensionPane: (paneId: string) => void;
  closePane: (paneId: string) => void;
  toggleInspector: () => void;
  setInspectorOpen: (open: boolean) => void;
  toggleMaximizePane: (paneId: string) => void;
  swapOrDockPanes: (sourceId: string, targetId: string, zone?: PaneDropZone) => void;
  setTwoPaneDirection: (direction: WorkbenchSplitDirection) => void;
  setSplitNodeRatio: (splitId: string, ratio: number) => void;
  setColRatio: (ratio: number) => void;
  setLeftRowRatio: (ratio: number) => void;
  setRightRowRatio: (ratio: number) => void;
  toggleTerminalShortcutPanel: () => void;

  setFileDrawerOpen: (open: boolean) => void;
  toggleFileDrawer: () => void;
  toggleSplit: (primaryTab: string, workbenchWidth: number, maximized: boolean) => void;
  setSplitDirection: (direction: WorkbenchSplitDirection) => void;
  setSecondaryTab: (tab: string) => void;
  setSplitRatio: (ratio: number) => void;
  closeSplit: () => void;
  upsertDraftComment: (cwd: string, input: UpsertDraftDiffCommentInput) => void;
  removeDraftComment: (cwd: string, id: string) => void;
  clearDraftComments: (cwd: string) => void;
  resetLayoutForTest: () => void;
}

const EMPTY_DRAFT_COMMENTS: DraftDiffComment[] = [];

export function normalizePaneId(rawId: string): string {
  const trimmed = rawId.trim();
  if (!trimmed || trimmed === "editor") return "files";
  if (
    trimmed === "code"
    && !clientContributions.getSnapshot().rightWorkbenchTabs.some((entry) => entry.id === "code")
  ) {
    return "files";
  }
  return trimmed;
}

function deriveDirection(
  tree: WorkbenchTileNode | null,
  fallback: WorkbenchSplitDirection,
): WorkbenchSplitDirection {
  return tree?.type === "split" ? tree.direction : fallback;
}

export function isCodePaneTab(tab: string): boolean {
  return tab === "files" || tab === "editor";
}

export function pickSecondaryTab(primaryTab: string): string {
  const gates = useBuiltinPluginGatesStore.getState();
  if (isCodePaneTab(primaryTab)) {
    if (gates.webPreviewEnabled) return "preview";
    return gates.codeReviewEnabled ? "review" : "summary";
  }
  if (primaryTab === "review") return "files";
  if (primaryTab === "summary") {
    return gates.codeReviewEnabled ? "review" : "files";
  }
  return "summary";
}

export function filterAllowedPanes(panes: readonly string[]): string[] {
  const gates = useBuiltinPluginGatesStore.getState();
  const pluginIds = new Set(clientContributions.getSnapshot().rightWorkbenchTabs.map((t) => t.id));
  return panes.filter((id) => {
    if (id === "review") return gates.codeReviewEnabled;
    if (id === "preview") return gates.webPreviewEnabled;
    if (id === "side-chat") return gates.sideChatEnabled;
    if (id === "files" || id === "terminal") return true;
    return pluginIds.has(id);
  });
}

export function selectDraftCommentsForCwd(
  state: Pick<WorkbenchLayoutState, "draftCommentsByCwd">,
  cwd: string,
): readonly DraftDiffComment[] {
  const key = cwd ? normalizeLocalPath(cwd) : "";
  if (!key) return EMPTY_DRAFT_COMMENTS;
  return state.draftCommentsByCwd[key] ?? EMPTY_DRAFT_COMMENTS;
}

export async function dispatchWorkbenchPrompt(
  prompt: string,
  options?: { prefillOnly?: boolean },
): Promise<boolean> {
  const trimmed = prompt.trim();
  if (!trimmed) return false;
  const appState = useAppStore.getState();
  if (options?.prefillOnly || appState.connection !== "running") {
    useAppStore.setState({ composerPrefill: trimmed });
    appState.showToast("已填入对话输入框", "info");
    return true;
  }
  const sent = await appState.sendMessage(trimmed, undefined, "followUp");
  if (!sent) {
    useAppStore.setState({ composerPrefill: trimmed });
    appState.showToast("发送失败，已保留在输入框中", "warning");
    return false;
  }
  appState.showToast("已发送给 Agent 处理", "info");
  return true;
}

let suppressWorkbenchSync = false;

function syncLegacyWorkbenchStore(openPanes: readonly string[], inspectorOpen: boolean, preferredActive?: string): void {
  suppressWorkbenchSync = true;
  try {
    const anyOpen = inspectorOpen || openPanes.length > 0;
    const prev = useWorkbenchStore.getState();
    let nextActive = prev.activeTab;
    if (!anyOpen) {
      nextActive = "summary";
    } else if (preferredActive && (preferredActive === "summary" || openPanes.includes(preferredActive))) {
      nextActive = preferredActive;
    } else if (openPanes.length > 0 && !openPanes.includes(normalizePaneId(prev.activeTab))) {
      nextActive = openPanes[0] ?? "summary";
    } else if (openPanes.length === 0 && inspectorOpen) {
      nextActive = "summary";
    }
    useWorkbenchStore.setState({
      rightOpen: anyOpen,
      activeTab: nextActive,
      ...(anyOpen ? {} : { rightMaximized: false }),
    });
  } finally {
    suppressWorkbenchSync = false;
  }
}

const initialLayoutState = {
  layoutTree: null as WorkbenchTileNode | null,
  openPanes: [] as string[],
  inspectorOpen: false,
  maximizedPaneId: null as string | null,
  fileDrawerOpen: true,
  twoPaneDirection: "vertical" as WorkbenchSplitDirection,
  leftColumnCount: null as number | null,
  colRatio: 0.62,
  leftRowRatio: 0.5,
  rightRowRatio: 0.5,
  splitOpen: false,
  splitDirection: "vertical" as WorkbenchSplitDirection,
  secondaryTab: "preview",
  splitRatio: 0.5,
  draftCommentsByCwd: {} as Record<string, DraftDiffComment[]>,
};

function buildTreePatch(nextTree: WorkbenchTileNode | null, fallbackDir: WorkbenchSplitDirection = "vertical") {
  const nextPanes = collectTreePanes(nextTree);
  const nextDir = deriveDirection(nextTree, fallbackDir);
  return {
    layoutTree: nextTree,
    openPanes: nextPanes,
    twoPaneDirection: nextDir,
    splitDirection: nextDir,
  };
}

export const useWorkbenchLayoutStore = create<WorkbenchLayoutState>((set, get) => ({
  ...initialLayoutState,

  togglePane: (rawId) => {
    const id = normalizePaneId(rawId);
    const current = get();
    if (current.openPanes.includes(id)) {
      const patch = buildTreePatch(removePaneFromTree(current.layoutTree, id));
      set({
        ...patch,
        maximizedPaneId: current.maximizedPaneId === id ? null : current.maximizedPaneId,
        leftColumnCount: patch.openPanes.length < 3 ? null : current.leftColumnCount,
      });
      syncLegacyWorkbenchStore(patch.openPanes, current.inspectorOpen);
      return;
    }
    const patch = buildTreePatch(insertPaneIntoTree(current.layoutTree, id));
    set({
      ...patch,
      maximizedPaneId: null,
      ...(id === "files" && rawId === "files" ? { fileDrawerOpen: true } : {}),
    });
    syncLegacyWorkbenchStore(patch.openPanes, current.inspectorOpen, id);
  },

  openPane: (rawId) => {
    const id = normalizePaneId(rawId);
    const current = get();
    const patch = buildTreePatch(insertPaneIntoTree(current.layoutTree, id));
    set({
      ...patch,
      maximizedPaneId: current.maximizedPaneId && current.maximizedPaneId !== id ? null : current.maximizedPaneId,
    });
    syncLegacyWorkbenchStore(patch.openPanes, current.inspectorOpen, id);
  },

  activateExtensionPane: (rawId) => {
    const id = normalizePaneId(rawId);
    const current = get();
    const shouldReplaceSoleInspector = current.openPanes.length === 0 && current.inspectorOpen;
    const nextInspector = shouldReplaceSoleInspector ? false : current.inspectorOpen;
    const patch = buildTreePatch(insertPaneIntoTree(current.layoutTree, id));
    set({
      ...patch,
      inspectorOpen: nextInspector,
      maximizedPaneId: current.maximizedPaneId && current.maximizedPaneId !== id ? null : current.maximizedPaneId,
    });
    syncLegacyWorkbenchStore(patch.openPanes, nextInspector, id);
  },

  closePane: (rawId) => {
    const id = normalizePaneId(rawId);
    const current = get();
    const patch = buildTreePatch(removePaneFromTree(current.layoutTree, id));
    set({
      ...patch,
      maximizedPaneId: current.maximizedPaneId === id ? null : current.maximizedPaneId,
      leftColumnCount: patch.openPanes.length < 3 ? null : current.leftColumnCount,
    });
    syncLegacyWorkbenchStore(patch.openPanes, current.inspectorOpen);
  },

  toggleInspector: () => {
    const current = get();
    const nextInspector = !current.inspectorOpen;
    set({ inspectorOpen: nextInspector });
    syncLegacyWorkbenchStore(current.openPanes, nextInspector, nextInspector && current.openPanes.length === 0 ? "summary" : undefined);
  },

  setInspectorOpen: (open) => {
    const current = get();
    if (current.inspectorOpen === open) return;
    set({ inspectorOpen: open });
    syncLegacyWorkbenchStore(current.openPanes, open, open && current.openPanes.length === 0 ? "summary" : undefined);
  },

  toggleMaximizePane: (rawId) => {
    const id = normalizePaneId(rawId);
    const current = get();
    const nextMax = current.maximizedPaneId === id ? null : id;
    set({ maximizedPaneId: nextMax });
    suppressWorkbenchSync = true;
    try {
      useWorkbenchStore.setState({ rightOpen: true, rightMaximized: nextMax !== null });
    } finally {
      suppressWorkbenchSync = false;
    }
  },

  swapOrDockPanes: (rawSource, rawTarget, zone = "swap") => {
    const source = normalizePaneId(rawSource);
    const target = normalizePaneId(rawTarget);
    if (!source || !target || source === target) return;
    const current = get();
    const patch = buildTreePatch(
      moveOrSwapPaneInTree(current.layoutTree, source, target, zone),
      current.twoPaneDirection,
    );
    set(patch);
  },

  setTwoPaneDirection: (direction) => set((state) => ({
    layoutTree: flipRootDirectionInTree(state.layoutTree, direction),
    twoPaneDirection: direction,
    splitDirection: direction,
  })),

  setSplitNodeRatio: (splitId, ratio) => set((state) => ({
    layoutTree: updateSplitRatioInTree(state.layoutTree, splitId, ratio),
  })),

  setColRatio: (ratio) => set((state) => {
    const next = clampSplitRatio(ratio);
    const tree = state.layoutTree?.type === "split" && state.layoutTree.direction === "horizontal"
      ? updateSplitRatioInTree(state.layoutTree, state.layoutTree.id, next)
      : state.layoutTree;
    return { colRatio: next, layoutTree: tree };
  }),

  setLeftRowRatio: (ratio) => set((state) => {
    const next = clampSplitRatio(ratio);
    const tree = state.layoutTree?.type === "split" && state.layoutTree.direction === "vertical"
      ? updateSplitRatioInTree(state.layoutTree, state.layoutTree.id, next)
      : state.layoutTree;
    return { leftRowRatio: next, layoutTree: tree };
  }),

  setRightRowRatio: (ratio) => set({ rightRowRatio: clampSplitRatio(ratio) }),

  toggleTerminalShortcutPanel: () => {
    if (clientContributions.getSnapshot().bottomPanelTabs.length > 0) {
      useWorkbenchStore.getState().toggleBottom();
      return;
    }
    get().togglePane("terminal");
  },

  setFileDrawerOpen: (open) => set({ fileDrawerOpen: open }),
  toggleFileDrawer: () => set((state) => ({ fileDrawerOpen: !state.fileDrawerOpen })),

  toggleSplit: (primaryTab) => set((state) => {
    if (state.splitOpen && state.openPanes.length >= 2) {
      const keep = state.openPanes[0] ?? normalizePaneId(primaryTab);
      const keepTree: WorkbenchTileNode = { type: "leaf", paneId: keep };
      return { splitOpen: false, layoutTree: keepTree, openPanes: [keep], twoPaneDirection: "vertical", splitDirection: "vertical" };
    }
    const sec = normalizePaneId(pickSecondaryTab(primaryTab));
    const baseTree = state.layoutTree ?? insertPaneIntoTree(null, normalizePaneId(primaryTab));
    const nextTree = insertPaneIntoTree(baseTree, sec);
    const nextPanes = collectTreePanes(nextTree);
    const direction = deriveDirection(nextTree, "vertical");
    return {
      splitOpen: true,
      splitDirection: direction,
      twoPaneDirection: direction,
      secondaryTab: sec,
      layoutTree: nextTree,
      openPanes: nextPanes,
    };
  }),

  setSplitDirection: (direction) => set((state) => ({
    layoutTree: flipRootDirectionInTree(state.layoutTree, direction),
    splitDirection: direction,
    twoPaneDirection: direction,
  })),
  setSecondaryTab: (tab) => set({ secondaryTab: tab }),
  setSplitRatio: (ratio) => set({ splitRatio: clampSplitRatio(ratio), colRatio: clampSplitRatio(ratio) }),
  closeSplit: () => set((state) => {
    const first = state.openPanes[0];
    const nextTree: WorkbenchTileNode | null = first ? { type: "leaf", paneId: first } : null;
    return { splitOpen: false, layoutTree: nextTree, openPanes: first ? [first] : [] };
  }),

  upsertDraftComment: (cwd, input) => set((state) => {
    const key = cwd ? normalizeLocalPath(cwd) : "";
    const trimmedBody = input.body.trim();
    if (!key || !trimmedBody) return state;
    const current = state.draftCommentsByCwd[key] ?? [];
    if (input.id && current.some((item) => item.id === input.id)) {
      return {
        draftCommentsByCwd: {
          ...state.draftCommentsByCwd,
          [key]: current.map((item) => (item.id === input.id ? { ...item, body: trimmedBody } : item)),
        },
      };
    }
    const created: DraftDiffComment = {
      id: input.id ?? `dc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      file: input.file,
      line: input.line,
      side: input.side,
      lineText: input.lineText,
      body: trimmedBody,
      createdAt: Date.now(),
    };
    return { draftCommentsByCwd: { ...state.draftCommentsByCwd, [key]: [...current, created] } };
  }),

  removeDraftComment: (cwd, id) => set((state) => {
    const key = cwd ? normalizeLocalPath(cwd) : "";
    const current = key ? state.draftCommentsByCwd[key] : undefined;
    if (!key || !current || current.length === 0) return state;
    return { draftCommentsByCwd: { ...state.draftCommentsByCwd, [key]: current.filter((item) => item.id !== id) } };
  }),

  clearDraftComments: (cwd) => set((state) => {
    const key = cwd ? normalizeLocalPath(cwd) : "";
    if (!key || !(key in state.draftCommentsByCwd)) return state;
    const next = { ...state.draftCommentsByCwd };
    delete next[key];
    return { draftCommentsByCwd: next };
  }),

  resetLayoutForTest: () => set({ ...initialLayoutState }),
}));

useWorkbenchStore.subscribe((state, prev) => {
  if (suppressWorkbenchSync) return;
  const layout = useWorkbenchLayoutStore.getState();
  if (!state.rightOpen) {
    if (layout.openPanes.length > 0 || layout.layoutTree !== null || layout.inspectorOpen || layout.maximizedPaneId !== null) {
      useWorkbenchLayoutStore.setState({ layoutTree: null, openPanes: [], inspectorOpen: false, maximizedPaneId: null, splitOpen: false });
    }
    return;
  }
  const reopened = !prev.rightOpen;
  const changedTab = state.activeTab !== prev.activeTab;
  const clickedFile = state.activeTab === "editor" && (state.activeFilePath !== prev.activeFilePath || state.openFiles.length !== prev.openFiles.length);
  const changedSummary = state.activeTab === "summary" && state.summaryFocus !== prev.summaryFocus;
  const changedPreview = state.activeTab === "preview" && state.previewUrl !== prev.previewUrl;
  if (!reopened && !changedTab && !clickedFile && !changedSummary && !changedPreview) return;

  if (state.activeTab === "summary") {
    useWorkbenchLayoutStore.setState({ inspectorOpen: true });
    return;
  }
  const targetPane = normalizePaneId(state.activeTab);
  const patch = buildTreePatch(insertPaneIntoTree(layout.layoutTree, targetPane));
  useWorkbenchLayoutStore.setState({ ...patch, maximizedPaneId: state.rightMaximized ? targetPane : null });
});
