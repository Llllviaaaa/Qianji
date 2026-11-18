import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserPreviewTab } from "../src/components/workbench/BrowserPreviewTab";
import { partitionAiCommentsForFile } from "../src/components/workbench/DiffInlineComments";
import { ReviewDiffTab } from "../src/components/workbench/ReviewDiffTab";
import { RightWorkbench } from "../src/components/workbench/RightWorkbench";
import { TaskSummaryTab } from "../src/components/workbench/TaskSummaryTab";
import type { CodeReviewComment } from "../src/lib/codeReview";
import { useAppStore } from "../src/store";
import { useBuiltinPluginGatesStore } from "../src/stores/builtinPluginGatesStore";
import {
  clampSplitRatio,
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
  min: 300,
  max: 900,
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

describe("Claude Desktop Right Workbench (Code + Cowork Hybrid)", () => {
  it("defaults right workbench activeTab to 'summary' and manages split-pane, ratio clamping, and file drawer", () => {
    expect(useWorkbenchStore.getState().activeTab).toBe("summary");

    const layout = useWorkbenchLayoutStore.getState();
    expect(layout.fileDrawerOpen).toBe(false);
    layout.toggleFileDrawer();
    expect(useWorkbenchLayoutStore.getState().fileDrawerOpen).toBe(true);
    layout.setFileDrawerOpen(false);
    expect(useWorkbenchLayoutStore.getState().fileDrawerOpen).toBe(false);

    // Narrow width -> vertical split, smart secondary selection from summary -> review.
    layout.toggleSplit("summary", 420, false);
    let next = useWorkbenchLayoutStore.getState();
    expect(next.splitOpen).toBe(true);
    expect(next.splitDirection).toBe("vertical");
    expect(next.secondaryTab).toBe("review");

    // Toggle off and reopen at wide / maximized width from editor -> horizontal split, secondary preview.
    next.toggleSplit("summary", 420, false);
    expect(useWorkbenchLayoutStore.getState().splitOpen).toBe(false);
    useWorkbenchLayoutStore.getState().setSecondaryTab("editor");
    useWorkbenchLayoutStore.getState().toggleSplit("editor", 800, true);
    next = useWorkbenchLayoutStore.getState();
    expect(next.splitOpen).toBe(true);
    expect(next.splitDirection).toBe("horizontal");
    expect(next.secondaryTab).toBe("preview");

    // Ratio clamping.
    expect(clampSplitRatio(Number.NaN)).toBe(0.5);
    next.setSplitRatio(0.05);
    expect(useWorkbenchLayoutStore.getState().splitRatio).toBe(0.25);
    next.setSplitRatio(0.95);
    expect(useWorkbenchLayoutStore.getState().splitRatio).toBe(0.75);
  });

  it("isolates draft diff comments per workspace and formats structured batch prompt", () => {
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

    // Update existing comment by id.
    store.upsertDraftComment(repoA, {
      id: "c1",
      file: "src/App.tsx",
      line: 42,
      side: "new",
      lineText: "const x = foo();",
      body: "请补充空值判断并返回默认值",
    });

    const commentsA = selectDraftCommentsForCwd(useWorkbenchLayoutStore.getState(), repoA);
    const commentsB = selectDraftCommentsForCwd(useWorkbenchLayoutStore.getState(), repoB);
    expect(commentsA).toHaveLength(1);
    expect(commentsA[0]?.body).toBe("请补充空值判断并返回默认值");
    expect(commentsB).toHaveLength(1);

    const prompt = formatDraftDiffCommentsPrompt(commentsA);
    expect(prompt).toContain("src/App.tsx:42");
    expect(prompt).toContain("const x = foo();");
    expect(prompt).toContain("请补充空值判断并返回默认值");

    store.removeDraftComment(repoA, "c1");
    expect(selectDraftCommentsForCwd(useWorkbenchLayoutStore.getState(), repoA)).toHaveLength(0);
    store.clearDraftComments(repoB);
    expect(selectDraftCommentsForCwd(useWorkbenchLayoutStore.getState(), repoB)).toHaveLength(0);
  });

  it("matches ::code-comment paths (relative and full paths) and partitions line vs file comments", () => {
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
      {
        id: "r3",
        title: "[P3] Other file",
        body: "Ignore me.",
        file: "src/Other.tsx",
        start: 5,
        end: 5,
        priority: 3,
        messageId: "m1",
      },
    ];

    const partitioned = partitionAiCommentsForFile(aiComments, "src/App.tsx");
    expect(partitioned.byLine.get(18)?.map((c) => c.id)).toEqual(["r1"]);
    expect(partitioned.fileLevel.map((c) => c.id)).toEqual(["r2"]);
  });

  it("renders RightWorkbench capsule header in single and split modes", () => {
    useWorkbenchStore.setState({ rightOpen: true, activeTab: "summary" });
    const singleHtml = renderWithQuery(
      createElement(RightWorkbench, {
        cwd: "D:\\Work\\RepoA",
        sessionFile: null,
        width: 480,
        git: null,
        onRefreshGit: async () => undefined,
        onRestoreFiles: async () => undefined,
        onRequestReview: () => undefined,
        resize: noopResize,
      }),
    );
    expect(singleHtml).toContain('aria-label="右侧工作台"');
    expect(singleHtml).toContain('data-wb-tab="summary"');
    expect(singleHtml).toContain('data-wb-tab="files"');
    expect(singleHtml).toContain("概览");
    expect(singleHtml).toContain("代码");
    expect(singleHtml).toContain("审查");
    expect(singleHtml).toContain("预览");
    expect(singleHtml).toContain("侧问");
    expect(singleHtml).not.toContain("pid-wb-dual-grid");

    useWorkbenchLayoutStore.getState().toggleSplit("summary", 760, false);
    const splitHtml = renderWithQuery(
      createElement(RightWorkbench, {
        cwd: "D:\\Work\\RepoA",
        sessionFile: null,
        width: 760,
        git: null,
        onRefreshGit: async () => undefined,
        onRestoreFiles: async () => undefined,
        onRequestReview: () => undefined,
        resize: noopResize,
      }),
    );
    expect(splitHtml).toContain("pid-wb-dual-grid");
    expect(splitHtml).toContain('data-split-dir="horizontal"');
    expect(splitHtml).toContain('aria-label="分屏副面板"');
  });

  it("renders Cowork 3-card overview inspector with collapsed diagnostics by default", () => {
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
            { id: "t1", name: "write_file", args: { path: "src/demo.ts" }, running: false },
          ],
        },
      ],
    });

    const html = renderWithQuery(
      createElement(TaskSummaryTab, { cwd: "D:\\Work\\RepoA", sessionFile: null }),
    );
    expect(html).toContain("任务进度");
    expect(html).toContain("工作目录与产出");
    expect(html).toContain("上下文探针");
    expect(html).toContain("src/demo.ts");
    expect(html).toContain("15%");
    expect(html).toContain("data-diagnostics-section");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("导出诊断包</span></div>");
  });

  it("renders ReviewDiffTab with inline AI findings, draft comments, and BrowserPreviewTab presets", () => {
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
    expect(reviewHtml).toContain("让 Agent 修复");
    expect(reviewHtml).toContain("这里请改成 let");
    expect(reviewHtml).toContain("发送给 Agent 修改");
    expect(reviewHtml).toContain("填入输入框");

    const previewHtml = renderWithQuery(createElement(BrowserPreviewTab, { cwd }));
    expect(previewHtml).toContain("自适应");
    expect(previewHtml).toContain("移动");
    expect(previewHtml).toContain("桌面");
    expect(previewHtml).toContain("反馈");
  });
});
