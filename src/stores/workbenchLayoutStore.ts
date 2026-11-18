import { create } from "zustand";
import { normalizeLocalPath } from "../lib/pathIdentity";
import { useAppStore } from "../store";
import { useBuiltinPluginGatesStore } from "./builtinPluginGatesStore";

export type WorkbenchSplitDirection = "horizontal" | "vertical";

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

export interface WorkbenchLayoutState {
  fileDrawerOpen: boolean;
  splitOpen: boolean;
  splitDirection: WorkbenchSplitDirection;
  secondaryTab: string;
  splitRatio: number;
  draftCommentsByCwd: Record<string, DraftDiffComment[]>;

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

const MIN_SPLIT_RATIO = 0.25;
const MAX_SPLIT_RATIO = 0.75;
const EMPTY_DRAFT_COMMENTS: DraftDiffComment[] = [];

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
  if (primaryTab === "review") return "editor";
  if (primaryTab === "summary") {
    return gates.codeReviewEnabled ? "review" : "files";
  }
  return "summary";
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

const initialLayoutState = {
  fileDrawerOpen: false,
  splitOpen: false,
  splitDirection: "horizontal" as WorkbenchSplitDirection,
  secondaryTab: "preview",
  splitRatio: 0.5,
  draftCommentsByCwd: {} as Record<string, DraftDiffComment[]>,
};

export const useWorkbenchLayoutStore = create<WorkbenchLayoutState>((set) => ({
  ...initialLayoutState,

  setFileDrawerOpen: (open) => set({ fileDrawerOpen: open }),

  toggleFileDrawer: () => set((state) => ({ fileDrawerOpen: !state.fileDrawerOpen })),

  toggleSplit: (primaryTab, workbenchWidth, maximized) => set((state) => {
    if (state.splitOpen) {
      return { splitOpen: false };
    }
    const direction: WorkbenchSplitDirection = maximized || workbenchWidth >= 660
      ? "horizontal"
      : "vertical";
    return {
      splitOpen: true,
      splitDirection: direction,
      secondaryTab: pickSecondaryTab(primaryTab),
    };
  }),

  setSplitDirection: (direction) => set({ splitDirection: direction }),

  setSecondaryTab: (tab) => set({ secondaryTab: tab }),

  setSplitRatio: (ratio) => set({ splitRatio: clampSplitRatio(ratio) }),

  closeSplit: () => set({ splitOpen: false }),

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
            [key]: current.map((item) => (
              item.id === input.id ? { ...item, body: trimmedBody } : item
            )),
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
    return {
      draftCommentsByCwd: {
        ...state.draftCommentsByCwd,
        [key]: [...current, created],
      },
    };
  }),

  removeDraftComment: (cwd, id) => set((state) => {
    const key = cwd ? normalizeLocalPath(cwd) : "";
    if (!key) return state;
    const current = state.draftCommentsByCwd[key];
    if (!current || current.length === 0) return state;
    const next = current.filter((item) => item.id !== id);
    return {
      draftCommentsByCwd: {
        ...state.draftCommentsByCwd,
        [key]: next,
      },
    };
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
