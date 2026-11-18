import { create } from "zustand";
import { clientContributions } from "../lib/clientContributions";
import { normalizeLocalPath } from "../lib/pathIdentity";
import { useAppStore } from "../store";
import { useBuiltinPluginGatesStore } from "./builtinPluginGatesStore";
import { useWorkbenchStore } from "./workbenchStore";

export type WorkbenchSplitDirection = "horizontal" | "vertical";
export type PaneDropZone = "swap" | "left" | "right" | "top" | "bottom";

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

export interface WorkbenchLayoutState {
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
  closePane: (paneId: string) => void;
  toggleInspector: () => void;
  setInspectorOpen: (open: boolean) => void;
  toggleMaximizePane: (paneId: string) => void;
  swapOrDockPanes: (sourceId: string, targetId: string, zone?: PaneDropZone) => void;
  setTwoPaneDirection: (direction: WorkbenchSplitDirection) => void;
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

const MIN_SPLIT_RATIO = 0.22;
const MAX_SPLIT_RATIO = 0.78;
const EMPTY_DRAFT_COMMENTS: DraftDiffComment[] = [];

const PANE_PRIORITY: Record<string, number> = {
  review: 10,
  preview: 20,
  "side-chat": 25,
  files: 30,
  terminal: 40,
};

function paneOrderWeight(id: string): number {
  return PANE_PRIORITY[id] ?? 28;
}

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

function insertPaneSorted(panes: readonly string[], paneId: string): string[] {
  if (panes.includes(paneId)) return [...panes];
  const weight = paneOrderWeight(paneId);
  const next = [...panes];
  const insertAt = next.findIndex((existing) => paneOrderWeight(existing) > weight);
  if (insertAt < 0) next.push(paneId);
  else next.splice(insertAt, 0, paneId);
  return next;
}

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
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

export function computeGridColumns(
  panes: readonly string[],
  twoPaneDirection: WorkbenchSplitDirection,
  leftColumnCount: number | null,
): WorkbenchGridColumns {
  if (panes.length === 0) return { col1: [], col2: [], hasCol2: false };
  if (panes.length === 1) return { col1: [panes[0] ?? "files"], col2: [], hasCol2: false };
  if (panes.length === 2) {
    if (twoPaneDirection === "vertical") {
      return { col1: [...panes], col2: [], hasCol2: false };
    }
    return { col1: [panes[0] ?? "files"], col2: [panes[1] ?? "preview"], hasCol2: true };
  }
  const desiredSplit = leftColumnCount ?? 2;
  const splitIndex = Math.min(panes.length - 1, Math.max(1, desiredSplit));
  return {
    col1: panes.slice(0, splitIndex),
    col2: panes.slice(splitIndex),
    hasCol2: true,
  };
}

export function selectDraftCommentsForCwd(
  state: Pick<WorkbenchLayoutState, "draftCommentsByCwd">,
  cwd: string,
): readonly DraftDiffComment[] {
  const key = cwd ? normalizeLocalPath(cwd) : "";
  if (!key) return EMPTY_DRAFT_COMMENTS;
  return state.draftCommentsByCwd[key] ?? EMPTY_DRAFT_COMMENTS;
}

export function formatDraftDiffCommentsPrompt(comments: readonly DraftDiffComment[]): string {
  if (comments.length === 0) return "";
  const lines: string[] = [
    `请根据以下 ${comments.length} 条代码审查行内批注进行修改：`,
    "",
  ];
  comments.forEach((item, index) => {
    const sideLabel = item.side === "old" ? "旧行" : "第";
    const loc = item.side === "old" ? `${item.file} (${sideLabel} ${item.line})` : `${item.file}:${item.line}`;
    lines.push(`${index + 1}. **${loc}**`);
    const snippet = item.lineText.trim();
    if (snippet) {
      lines.push(`   > \`${snippet.slice(0, 140)}\``);
    }
    lines.push(`   - 修改意见：${item.body.trim()}`);
  });
  lines.push("", "请逐项应用上述修改，并简要说明改动内容。");
  return lines.join("\n");
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
  openPanes: [] as string[],
  inspectorOpen: false,
  maximizedPaneId: null as string | null,
  fileDrawerOpen: true,
  twoPaneDirection: "horizontal" as WorkbenchSplitDirection,
  leftColumnCount: null as number | null,
  colRatio: 0.54,
  leftRowRatio: 0.5,
  rightRowRatio: 0.5,
  splitOpen: false,
  splitDirection: "horizontal" as WorkbenchSplitDirection,
  secondaryTab: "preview",
  splitRatio: 0.5,
  draftCommentsByCwd: {} as Record<string, DraftDiffComment[]>,
};

export const useWorkbenchLayoutStore = create<WorkbenchLayoutState>((set, get) => ({
  ...initialLayoutState,

  togglePane: (rawId) => {
    const id = normalizePaneId(rawId);
    const current = get();
    if (current.openPanes.includes(id)) {
      const nextPanes = current.openPanes.filter((pane) => pane !== id);
      const nextMax = current.maximizedPaneId === id ? null : current.maximizedPaneId;
      set({
        openPanes: nextPanes,
        maximizedPaneId: nextMax,
        leftColumnCount: nextPanes.length < 3 ? null : current.leftColumnCount,
      });
      syncLegacyWorkbenchStore(nextPanes, current.inspectorOpen);
      return;
    }
    const nextPanes = insertPaneSorted(current.openPanes, id);
    set({
      openPanes: nextPanes,
      maximizedPaneId: null,
      ...(id === "files" && rawId === "files" ? { fileDrawerOpen: true } : {}),
    });
    syncLegacyWorkbenchStore(nextPanes, current.inspectorOpen, id);
  },

  openPane: (rawId) => {
    const id = normalizePaneId(rawId);
    const current = get();
    const nextPanes = insertPaneSorted(current.openPanes, id);
    set({
      openPanes: nextPanes,
      maximizedPaneId: current.maximizedPaneId && current.maximizedPaneId !== id ? null : current.maximizedPaneId,
    });
    syncLegacyWorkbenchStore(nextPanes, current.inspectorOpen, id);
  },

  closePane: (rawId) => {
    const id = normalizePaneId(rawId);
    const current = get();
    const nextPanes = current.openPanes.filter((pane) => pane !== id);
    const nextMax = current.maximizedPaneId === id ? null : current.maximizedPaneId;
    set({
      openPanes: nextPanes,
      maximizedPaneId: nextMax,
      leftColumnCount: nextPanes.length < 3 ? null : current.leftColumnCount,
    });
    syncLegacyWorkbenchStore(nextPanes, current.inspectorOpen);
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
    const panes = [...current.openPanes];
    const srcIdx = panes.indexOf(source);
    const dstIdx = panes.indexOf(target);
    if (srcIdx < 0 || dstIdx < 0) return;

    if (panes.length === 2 && (zone === "left" || zone === "right" || zone === "top" || zone === "bottom")) {
      const nextDirection: WorkbenchSplitDirection = zone === "top" || zone === "bottom" ? "vertical" : "horizontal";
      const ordered = zone === "left" || zone === "top" ? [source, target] : [target, source];
      set({ openPanes: ordered, twoPaneDirection: nextDirection });
      return;
    }

    const updated = [...panes];
    updated[srcIdx] = target;
    updated[dstIdx] = source;
    set({ openPanes: updated });
  },

  setTwoPaneDirection: (direction) => set({ twoPaneDirection: direction, splitDirection: direction }),
  setColRatio: (ratio) => set({ colRatio: clampSplitRatio(ratio) }),
  setLeftRowRatio: (ratio) => set({ leftRowRatio: clampSplitRatio(ratio) }),
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

  toggleSplit: (primaryTab, workbenchWidth, maximized) => set((state) => {
    if (state.splitOpen && state.openPanes.length >= 2) {
      const keep = state.openPanes[0] ?? normalizePaneId(primaryTab);
      return { splitOpen: false, openPanes: [keep] };
    }
    const direction: WorkbenchSplitDirection = maximized || workbenchWidth >= 660 ? "horizontal" : "vertical";
    const sec = normalizePaneId(pickSecondaryTab(primaryTab));
    const base = state.openPanes.length > 0 ? state.openPanes : [normalizePaneId(primaryTab)];
    const nextPanes = base.includes(sec) ? base : insertPaneSorted(base, sec);
    return {
      splitOpen: true,
      splitDirection: direction,
      twoPaneDirection: direction,
      secondaryTab: sec,
      openPanes: nextPanes,
    };
  }),

  setSplitDirection: (direction) => set({ splitDirection: direction, twoPaneDirection: direction }),
  setSecondaryTab: (tab) => set({ secondaryTab: tab }),
  setSplitRatio: (ratio) => set({ splitRatio: clampSplitRatio(ratio), colRatio: clampSplitRatio(ratio) }),
  closeSplit: () => set((state) => ({ splitOpen: false, openPanes: state.openPanes.slice(0, 1) })),

  upsertDraftComment: (cwd, input) => set((state) => {
    const key = cwd ? normalizeLocalPath(cwd) : "";
    const trimmedBody = input.body.trim();
    if (!key || !trimmedBody) return state;
    const current = state.draftCommentsByCwd[key] ?? [];
    if (input.id) {
      const exists = current.some((item) => item.id === input.id);
      if (exists) {
        return {
          draftCommentsByCwd: {
            ...state.draftCommentsByCwd,
            [key]: current.map((item) => (item.id === input.id ? { ...item, body: trimmedBody } : item)),
          },
        };
      }
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
    if (!key) return state;
    const current = state.draftCommentsByCwd[key];
    if (!current || current.length === 0) return state;
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
    if (layout.openPanes.length > 0 || layout.inspectorOpen || layout.maximizedPaneId !== null) {
      useWorkbenchLayoutStore.setState({ openPanes: [], inspectorOpen: false, maximizedPaneId: null, splitOpen: false });
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
  const nextPanes = insertPaneSorted(layout.openPanes, targetPane);
  useWorkbenchLayoutStore.setState({
    openPanes: nextPanes,
    maximizedPaneId: state.rightMaximized ? targetPane : null,
  });
});
