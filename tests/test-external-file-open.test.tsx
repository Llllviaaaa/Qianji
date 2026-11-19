import assert from "node:assert/strict";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, test } from "vitest";
import { CodeEditorTab } from "../src/components/workbench/CodeEditorTab";
import { useAppStore } from "../src/store";
import { useWorkbenchStore } from "../src/stores/workbenchStore";

const CWD = "D:\\work\\demo";

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

function renderWorkbenchNode(node: ReactNode): string {
  const restores = [
    syncStoreInitial(useWorkbenchStore),
    syncStoreInitial(useAppStore),
  ];
  try {
    return renderToStaticMarkup(node);
  } finally {
    for (const restore of restores) restore();
  }
}

afterEach(() => {
  useWorkbenchStore.getState().resetForTest();
});

describe("CodeEditorTab external file opening across non-docx and binary file types", () => {
  test("renders default-app open and explorer reveal buttons for binary xlsx, docx, pdf, markdown, html, and error files", () => {
    // 1. Non-docx binary file (xlsx) shows one-click default-app open and reveal actions
    useWorkbenchStore.setState({
      openFiles: [{
        cwd: CWD,
        path: "reports/budget.xlsx",
        content: "",
        savedContent: "",
        size: 24_576,
        truncated: false,
        isBinary: true,
        loading: false,
      }],
      activeFilePath: "reports/budget.xlsx",
      activeFileCwd: CWD,
    });
    const xlsxMarkup = renderWorkbenchNode(createElement(CodeEditorTab, { cwd: CWD }));
    assert.match(xlsxMarkup, /使用系统默认应用打开/);
    assert.match(xlsxMarkup, /在文件资源管理器中显示/);

    // 2. PDF binary file renders inline iframe preview AND external default-app open button
    useWorkbenchStore.setState({
      openFiles: [{
        cwd: CWD,
        path: "docs/spec.pdf",
        content: "",
        savedContent: "",
        size: 12_288,
        truncated: false,
        isBinary: true,
        mimeType: "application/pdf",
        data: "JVBERi0xLjQ=",
        loading: false,
      }],
      activeFilePath: "docs/spec.pdf",
      activeFileCwd: CWD,
    });
    const pdfMarkup = renderWorkbenchNode(createElement(CodeEditorTab, { cwd: CWD }));
    assert.match(pdfMarkup, /data-workbench-preview="pdf"/);
    assert.match(pdfMarkup, /aria-label="使用系统默认应用打开"/);
    assert.match(pdfMarkup, /aria-label="在文件资源管理器中显示"/);

    // 3. Markdown file renders external default-app open and reveal controls in subbar
    useWorkbenchStore.setState({
      openFiles: [{
        cwd: CWD,
        path: "README.md",
        content: "# Title",
        savedContent: "# Title",
        size: 7,
        truncated: false,
        isBinary: false,
        loading: false,
        viewMode: "preview",
      }],
      activeFilePath: "README.md",
      activeFileCwd: CWD,
    });
    const mdMarkup = renderWorkbenchNode(createElement(CodeEditorTab, { cwd: CWD }));
    assert.match(mdMarkup, /aria-label="使用系统默认应用打开"/);
    assert.match(mdMarkup, /aria-label="在文件资源管理器中显示"/);

    // 4. HTML file falls back to enabled default-app open (not disabled) before previewHttpUrl resolves
    useWorkbenchStore.setState({
      openFiles: [{
        cwd: CWD,
        path: "dist/report.html",
        content: "<h1>Report</h1>",
        savedContent: "<h1>Report</h1>",
        size: 15,
        truncated: false,
        isBinary: false,
        loading: false,
        viewMode: "preview",
      }],
      activeFilePath: "dist/report.html",
      activeFileCwd: CWD,
    });
    const htmlMarkup = renderWorkbenchNode(createElement(CodeEditorTab, { cwd: CWD }));
    assert.match(htmlMarkup, /aria-label="使用系统默认应用打开"/);
    assert.doesNotMatch(htmlMarkup, /disabled=""[^>]*aria-label="使用系统默认应用打开"/);
    assert.match(htmlMarkup, /aria-label="在文件资源管理器中显示"/);

    // 5. Error state (e.g. file outside workspace) still offers external open and explorer reveal
    useWorkbenchStore.setState({
      openFiles: [{
        cwd: CWD,
        path: "C:\\Users\\demo\\Desktop\\notes.txt",
        content: "",
        savedContent: "",
        size: 0,
        truncated: false,
        isBinary: false,
        loading: false,
        error: "path is outside the workspace",
      }],
      activeFilePath: "C:\\Users\\demo\\Desktop\\notes.txt",
      activeFileCwd: CWD,
    });
    const errorMarkup = renderWorkbenchNode(createElement(CodeEditorTab, { cwd: CWD }));
    assert.match(errorMarkup, /path is outside the workspace/);
    assert.match(errorMarkup, /使用系统默认应用打开/);
    assert.match(errorMarkup, /在文件资源管理器中显示/);
  });
});
