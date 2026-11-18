import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserPreviewTab, sanitizePreviewUrl } from "../src/components/workbench/BrowserPreviewTab";
import { CodeWorkspacePane } from "../src/components/workbench/CodeWorkspacePane";
import { partitionAiCommentsForFile } from "../src/components/workbench/DiffInlineComments";
import { ReviewDiffTab } from "../src/components/workbench/ReviewDiffTab";
import { RightWorkbench, WorkbenchTopbarControls } from "../src/components/workbench/RightWorkbench";
import { TaskSummaryTab } from "../src/components/workbench/TaskSummaryTab";
import type { CodeReviewComment } from "../src/lib/codeReview";
import { useAppStore } from "../src/store";
import { useBuiltinPluginGatesStore } from "../src/stores/builtinPluginGatesStore";
import {
  clampSplitRatio,
  computeGridColumns,
  computeTileLayout,
  detectPaneDropZone,
  formatDraftDiffCommentsPrompt,
  selectDraftCommentsForCwd,
  useWorkbenchLayoutStore,
} from "../src/stores/workbenchLayoutStore";
import { useWorkbenchStore } from "../src/stores/workbenchStore";
import type { GitSnapshot, UiMessage } from "../src/types";

function syncStoreInitial<T extends object>(store: { getState: () => T; getInitialState: () => T }): () => void {
  const init = store.getInitialState();
  const backup = { ...init };
  Object.assign(init, store.getState());
  return () => {
    for (const key of Object.keys(init) as Array<keyof T>) {
      if (!(key in backup)) delete init[key];
    }
    Object.assign(init, backup);
  };
}

function renderWithQuery(node: ReactNode): string {
  const restores = [
    syncStoreInitial(useWorkbenchStore),
    syncStoreInitial(useWorkbenchLayoutStore),
    syncStoreInitial(useAppStore),
    syncStoreInitial(useBuiltinPluginGatesStore),
  ];
  try {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return renderToStaticMarkup(createElement(QueryClientProvider, { client }, node));
  } finally {
    for (const restore of restores) restore();
  }
}

const noopResize = {
  onPointerDown: () => undefined,
  onKeyDown: () => undefined,
  min: 260,
  max: 1260,
};

afterEach(() => {
  useWorkbenchStore.getState().resetForTest();
  useWorkbenchLayoutStore.getState().resetLayoutForTest();
  useBuiltinPluginGatesStore.setState({
    codeReviewEnabled: true,
    webPreviewEnabled: true,
    sideChatEnabled: true,
  });
  useAppStore.setState({
    messages: [],
    stats: null,
    model: null,
    git: null,
    hostLog: [],
    isStreaming: false,
    connection: "disconnected",
    composerPrefill: null,
  });
});

describe("Claude Desktop 2D Multi-Pane Right Workbench & Hairline Inspector", () => {
  it("prioritizes top-and-bottom stacking for 2 panes, expands to 2x2, and supports arbitrary pointer dock/swap", () => {
    const layout = useWorkbenchLayoutStore.getState();
    expect(layout.openPanes).toEqual([]);
    expect(layout.inspectorOpen).toBe(false);
    expect(layout.fileDrawerOpen).toBe(true);
    expect(layout.twoPaneDirection).toBe("vertical");

    // 1 -> 2 panes defaults to top-and-bottom stack (first on top, second on bottom).
    layout.togglePane("review");
    layout.togglePane("preview");
    const twoState = useWorkbenchLayoutStore.getState();
    expect(twoState.openPanes).toEqual(["review", "preview"]);
    expect(twoState.twoPaneDirection).toBe("vertical");
    expect(useWorkbenchStore.getState().rightOpen).toBe(true);

    const twoLayout = computeTileLayout(twoState.layoutTree);
    expect(twoLayout.hasHorizontalSplit).toBe(false);
    expect(twoLayout.panes.review).toEqual({ left: 0, top: 0, width: 1, height: 0.5 });
    expect(twoLayout.panes.preview).toEqual({ left: 0, top: 0.5, width: 1, height: 0.5 });
    expect(computeGridColumns(["review", "preview"], "vertical", null)).toEqual({
      col1: ["review", "preview"],
      col2: [],
      hasCol2: false,
    });

    // Opening 3rd & 4th panes expands to 2x2 balanced binary split tree.
    layout.togglePane("files");
    layout.togglePane("terminal");
    const fourState = useWorkbenchLayoutStore.getState();
    expect(fourState.openPanes).toEqual(["review", "preview", "files", "terminal"]);
    const fourLayout = computeTileLayout(fourState.layoutTree);
    expect(fourLayout.hasHorizontalSplit).toBe(true);
    expect(fourLayout.panes.review?.left).toBe(0);
    expect(fourLayout.panes.review?.top).toBe(0);
    expect(fourLayout.panes.preview?.left).toBe(0);
    expect(fourLayout.panes.preview?.top).toBe(0.5);
    expect(fourLayout.panes.files?.left).toBeGreaterThan(0);
    expect(fourLayout.panes.files?.top).toBe(0);
    expect(fourLayout.panes.terminal?.left).toBeGreaterThan(0);
    expect(fourLayout.panes.terminal?.top).toBe(0.5);

    // Dragging a pane works even when 4 panes are open (e.g. dock terminal onto left of review).
    layout.swapOrDockPanes("terminal", "review", "left");
    const lShape = computeTileLayout(useWorkbenchLayoutStore.getState().layoutTree);
    expect(lShape.panes.terminal?.top).toBe(0);
    expect(lShape.panes.terminal?.left).toBe(0);
    expect(lShape.panes.review?.top).toBe(0);
    expect(lShape.panes.review?.left ?? 0).toBeGreaterThan(0);

    // Closing to 2 panes lets user drag between vertical <-> horizontal <-> swap cleanly.
    layout.closePane("terminal");
    layout.closePane("review");
    expect(useWorkbenchLayoutStore.getState().openPanes).toEqual(["preview", "files"]);

    layout.swapOrDockPanes("files", "preview", "right");
    const horiz = computeTileLayout(useWorkbenchLayoutStore.getState().layoutTree);
    expect(horiz.hasHorizontalSplit).toBe(true);
    expect(horiz.panes.preview).toEqual({ left: 0, top: 0, width: 0.5, height: 1 });
    expect(horiz.panes.files).toEqual({ left: 0.5, top: 0, width: 0.5, height: 1 });

    layout.swapOrDockPanes("files", "preview", "top");
    const vert = computeTileLayout(useWorkbenchLayoutStore.getState().layoutTree);
    expect(vert.hasHorizontalSplit).toBe(false);
    expect(vert.panes.files).toEqual({ left: 0, top: 0, width: 1, height: 0.5 });
    expect(vert.panes.preview).toEqual({ left: 0, top: 0.5, width: 1, height: 0.5 });

    // Closing all panes closes rightOpen if Inspector is also closed.
    layout.closePane("files");
    layout.closePane("preview");
    expect(useWorkbenchLayoutStore.getState().openPanes).toEqual([]);
    expect(useWorkbenchStore.getState().rightOpen).toBe(false);

    // Edge zone hit-testing & ratio clamping.
    expect(detectPaneDropZone(0.5, 0.5)).toBe("swap");
    expect(detectPaneDropZone(0.1, 0.5)).toBe("left");
    expect(detectPaneDropZone(0.9, 0.5)).toBe("right");
    expect(detectPaneDropZone(0.5, 0.1)).toBe("top");
    expect(detectPaneDropZone(0.5, 0.9)).toBe("bottom");

    expect(clampSplitRatio(Number.NaN)).toBe(0.5);
    layout.setColRatio(0.05);
    expect(useWorkbenchLayoutStore.getState().colRatio).toBe(0.22);
    layout.setColRatio(0.95);
    expect(useWorkbenchLayoutStore.getState().colRatio).toBe(0.78);
  });

  it("renders sole, docked, and floating Inspector modes alongside the 2D pane grid and top-right controls", () => {
    const controlsClosedHtml = renderWithQuery(createElement(WorkbenchTopbarControls));
    expect(controlsClosedHtml).toContain('data-wb-tab="review"');
    expect(controlsClosedHtml).toContain('data-wb-tab="preview"');
    expect(controlsClosedHtml).toContain('data-wb-tab="files"');
    expect(controlsClosedHtml).toContain('data-wb-tab="terminal"');
    expect(controlsClosedHtml).toContain('data-wb-tab="summary"');
    expect(controlsClosedHtml).toContain("切换右侧工作台 (Ctrl+Alt+B)");

    // Mode 1: Sole Inspector (matches Claude Desktop screenshot 6).
    useWorkbenchLayoutStore.getState().toggleInspector();
    const soleHtml = renderWithQuery(
      createElement(RightWorkbench, {
        cwd: "D:\\Work\\RepoA",
        sessionFile: null,
        width: 740,
        git: null,
        onRefreshGit: async () => undefined,
        onRestoreFiles: async () => undefined,
        onRequestReview: () => undefined,
        resize: noopResize,
      }),
    );
    expect(soleHtml).toContain('aria-label="右侧工作台"');
    expect(soleHtml).toContain("is-mode-sole");
    expect(soleHtml).toContain("pid-wb-inspector-sole");
    expect(soleHtml).not.toContain("pid-wb-inspector-popover");

    // Mode 2: Docked Inspector + Files (matches Claude Desktop screenshot 5).
    useWorkbenchLayoutStore.getState().openPane("files");
    const dockedHtml = renderWithQuery(
      createElement(RightWorkbench, {
        cwd: "D:\\Work\\RepoA",
        sessionFile: null,
        width: 740,
        git: null,
        onRefreshGit: async () => undefined,
        onRestoreFiles: async () => undefined,
        onRequestReview: () => undefined,
        resize: noopResize,
      }),
    );
    expect(dockedHtml).toContain("is-mode-docked");
    expect(dockedHtml).toContain("pid-wb-inspector-docked");
    expect(dockedHtml).toContain('data-pane-id="files"');

    // Mode 3: Floating Popover Inspector over 2x2 Multi-Pane Grid (matches Claude Desktop screenshot 1).
    useWorkbenchLayoutStore.getState().openPane("review");
    useWorkbenchLayoutStore.getState().openPane("preview");
    useWorkbenchLayoutStore.getState().openPane("terminal");
    const gridFloatingHtml = renderWithQuery(
      createElement(RightWorkbench, {
        cwd: "D:\\Work\\RepoA",
        sessionFile: null,
        width: 960,
        git: null,
        onRefreshGit: async () => undefined,
        onRestoreFiles: async () => undefined,
        onRequestReview: () => undefined,
        resize: noopResize,
      }),
    );
    expect(gridFloatingHtml).toContain("is-mode-floating");
    expect(gridFloatingHtml).toContain("pid-wb-inspector-popover");
    expect(gridFloatingHtml).toContain('data-pane-count="4"');
    expect(gridFloatingHtml).toContain('data-pane-id="review"');
    expect(gridFloatingHtml).toContain('data-pane-id="preview"');
    expect(gridFloatingHtml).toContain('data-pane-id="files"');
    expect(gridFloatingHtml).toContain('data-pane-id="terminal"');
    expect(gridFloatingHtml).toContain("需要 Git 仓库");
    expect(gridFloatingHtml).toContain("与 Agent 协同浏览");
  });

  it("renders Files pane with empty editor stage on the left and file tree rail on the right", () => {
    const filesHtml = renderWithQuery(createElement(CodeWorkspacePane, { cwd: "D:\\Work\\RepoA" }));
    const mainPos = filesHtml.indexOf("pid-wb-code-main");
    const treePos = filesHtml.indexOf("pid-wb-file-tree-rail");
    expect(mainPos).toBeGreaterThan(-1);
    expect(treePos).toBeGreaterThan(mainPos);
    expect(filesHtml).toContain("打开的文件将显示在此处");
    expect(filesHtml).toContain("筛选文件，或输入 / 搜索…");
  });

  it("renders headerless hairline Inspector sections in Environment -> Context -> Connectors -> Outputs order with collapsed diagnostics", () => {
    useAppStore.setState({
      stats: {
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 1,
        toolResults: 1,
        totalMessages: 2,
        tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500 },
        cost: 0.0123,
        contextUsage: { tokens: 1500, contextWindow: 10000, percent: 15 },
      },
      messages: [
        {
          id: "a1",
          role: "assistant",
          content: "done",
          timestamp: 1,
          toolCalls: [
            { id: "t1", name: "write_file", args: { path: "src/pelican-ride.html" }, running: false },
          ],
        },
      ],
    });

    const html = renderWithQuery(
      createElement(TaskSummaryTab, { cwd: "D:\\Work\\RepoA", sessionFile: null }),
    );
    const envPos = html.indexOf("运行环境");
    const ctxPos = html.indexOf("上下文");
    const connPos = html.indexOf("连接器");
    const outPos = html.indexOf("产出文件");
    const diagPos = html.indexOf("data-diagnostics-section");
    expect(envPos).toBeGreaterThan(-1);
    expect(ctxPos).toBeGreaterThan(envPos);
    expect(connPos).toBeGreaterThan(ctxPos);
    expect(outPos).toBeGreaterThan(connPos);
    expect(diagPos).toBeGreaterThan(outPos);
    expect(html).toContain("本机环境");
    expect(html).toContain("RepoA");
    expect(html).toContain("pelican-ride.html");
    expect(html).toContain("15%");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("$0.0123");
  });

  it("isolates draft diff comments per workspace and matches ::code-comment AI findings", () => {
    const repoA = "D:\\Work\\RepoA";
    const repoB = "D:\\Work\\RepoB";
    const store = useWorkbenchLayoutStore.getState();

    store.upsertDraftComment(repoA, {
      id: "c1",
      file: "src/App.tsx",
      line: 42,
      side: "new",
      lineText: "const x = foo();",
      body: "请补充空值判断",
    });
    store.upsertDraftComment(repoB, {
      id: "c2",
      file: "src/main.ts",
      line: 10,
      side: "old",
      lineText: "return bar;",
      body: "保留旧返回值",
    });

    const commentsA = selectDraftCommentsForCwd(useWorkbenchLayoutStore.getState(), repoA);
    expect(commentsA).toHaveLength(1);
    expect(formatDraftDiffCommentsPrompt(commentsA)).toContain("src/App.tsx:42");

    const aiComments: CodeReviewComment[] = [
      {
        id: "r1",
        title: "[P1] Stale closure",
        body: "Use functional update.",
        file: "D:\\Work\\RepoA\\src\\App.tsx",
        start: 18,
        end: 20,
        priority: 1,
        messageId: "m1",
      },
      {
        id: "r2",
        title: "[P2] Missing docstring",
        body: "Add brief header doc.",
        file: "./src/App.tsx",
        start: null,
        end: null,
        priority: 2,
        messageId: "m1",
      },
    ];
    const partitioned = partitionAiCommentsForFile(aiComments, "src/App.tsx");
    expect(partitioned.byLine.get(18)?.map((c) => c.id)).toEqual(["r1"]);
    expect(partitioned.fileLevel.map((c) => c.id)).toEqual(["r2"]);

    store.removeDraftComment(repoA, "c1");
    store.clearDraftComments(repoB);
  });

  it("renders ReviewDiffTab inline findings/comments and BrowserPreviewTab single-header controls with URL sanitization", () => {
    const cwd = "D:\\Work\\RepoA";
    const diff = [
      "diff --git a/src/App.tsx b/src/App.tsx",
      "--- a/src/App.tsx",
      "+++ b/src/App.tsx",
      "@@ -1,2 +1,3 @@",
      " const a = 1;",
      "+const b = 2;",
      " export default a;",
    ].join("\n");
    const git: GitSnapshot = {
      isRepository: true,
      branch: "feat/workbench",
      files: [{ path: "src/App.tsx", status: "M", unstaged: true }],
      diff,
    };
    const messages: UiMessage[] = [
      { id: "u1", role: "user", content: "审查当前未提交的代码更改", timestamp: 1 },
      {
        id: "a1",
        role: "assistant",
        content: '::code-comment{title="[P1] Unused variable" body="Remove b." file="src/App.tsx" start=2 end=2 priority=1}',
        timestamp: 2,
      },
    ];
    useAppStore.setState({ messages, git });
    useWorkbenchLayoutStore.getState().upsertDraftComment(cwd, {
      file: "src/App.tsx",
      line: 2,
      side: "new",
      lineText: "const b = 2;",
      body: "这里请改成 let",
    });

    const reviewHtml = renderWithQuery(
      createElement(ReviewDiffTab, {
        cwd,
        git,
        onRefreshGit: async () => undefined,
        onRestoreFiles: async () => undefined,
        onRequestReview: () => undefined,
      }),
    );
    expect(reviewHtml).toContain("AI 发现 1 处问题");
    expect(reviewHtml).toContain("[P1] Unused variable");
    expect(reviewHtml).toContain("这里请改成 let");
    expect(reviewHtml).toContain("发送给 Agent 修改");

    const previewHtml = renderWithQuery(createElement(BrowserPreviewTab, { cwd }));
    expect(previewHtml).toContain("与 Agent 协同浏览");
    expect(previewHtml).toContain("检测开发服务器");
    expect(previewHtml).toContain("自适应");
    expect(previewHtml).toContain("移动 (390px)");
    expect(previewHtml).toContain("桌面 (1280px)");
    expect(sanitizePreviewUrl("http://localhost:5173")).toBe("http://localhost:5173");
    expect(sanitizePreviewUrl("tauri://localhost")).toBeNull();
    expect(sanitizePreviewUrl("http://tauri.localhost/app")).toBeNull();
  });
});
