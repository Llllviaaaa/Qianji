import { useEffect, useMemo, useState } from "react";
import { useSyncOnChange } from "../../hooks/useSyncOnChange";
import { Markdown } from "../Markdown";
import type { OpenWorkbenchFile, WorkbenchPreviewKind } from "../../stores/workbenchStore";

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function injectBaseTag(rawHtml: string, baseUrl: string | null): string {
  if (!baseUrl || /<base\b/i.test(rawHtml)) return rawHtml;
  const baseTag = `<base href="${escapeHtmlAttr(baseUrl)}" />`;
  if (/<head(\s[^>]*)?>/i.test(rawHtml)) {
    return rawHtml.replace(/<head(\s[^>]*)?>/i, (match) => `${match}\n${baseTag}`);
  }
  if (/<html(\s[^>]*)?>/i.test(rawHtml)) {
    return rawHtml.replace(/<html(\s[^>]*)?>/i, (match) => `${match}\n<head>${baseTag}</head>`);
  }
  return `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8" />\n${baseTag}\n</head>\n<body>\n${rawHtml}\n</body>\n</html>`;
}

function buildSvgStageHtml(svgContent: string, baseUrl: string | null): string {
  const baseTag = baseUrl ? `<base href="${escapeHtmlAttr(baseUrl)}" />` : "";
  return `<!DOCTYPE html><html><head><meta charset="utf-8" />${baseTag}<style>
  html, body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box; background: transparent; }
  svg { max-width: 100%; height: auto; }
</style></head><body>${svgContent}</body></html>`;
}

function appendCacheVersion(url: string, token: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}_v=${encodeURIComponent(token)}`;
}

export interface DynamicDocumentPreviewProps {
  file: OpenWorkbenchFile;
  kind: Exclude<WorkbenchPreviewKind, null>;
  previewHttpUrl: string | null;
  reloadNonce: number;
}

export function DynamicDocumentPreview({
  file,
  kind,
  previewHttpUrl,
  reloadNonce,
}: DynamicDocumentPreviewProps) {
  const isDirty = file.content !== file.savedContent;
  const [debouncedContent, setDebouncedContent] = useState(file.content);

  useSyncOnChange([file.cwd, file.path], () => {
    setDebouncedContent(file.content);
  });

  useEffect(() => {
    if (!isDirty) return;
    const timer = window.setTimeout(() => {
      setDebouncedContent(file.content);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [file.content, file.cwd, file.path, isDirty]);

  const renderedContent = isDirty ? debouncedContent : file.content;

  const liveDataUrl = useMemo(() => {
    if (kind === "markdown") return "";
    const htmlDoc = kind === "svg"
      ? buildSvgStageHtml(renderedContent, previewHttpUrl)
      : injectBaseTag(renderedContent, previewHttpUrl);
    return `data:text/html;charset=utf-8,${encodeURIComponent(htmlDoc)}`;
  }, [kind, previewHttpUrl, renderedContent]);

  if (kind === "markdown") {
    return (
      <div className="pid-wb-md-preview dshc-md" data-workbench-preview="markdown">
        <Markdown content={file.content} />
      </div>
    );
  }

  if (kind === "svg" && file.isBinary && file.data) {
    return (
      <div className="pid-wb-image-preview" data-workbench-preview="svg-binary">
        <img src={`data:image/svg+xml;base64,${file.data}`} alt={file.path} />
      </div>
    );
  }

  const useLoopbackServer = !isDirty
    && previewHttpUrl !== null
    && (kind === "html" || (kind === "svg" && file.content.trim() === ""));

  const frameSrc = useLoopbackServer
    ? appendCacheVersion(previewHttpUrl, `${reloadNonce}-${file.savedContent.length}`)
    : liveDataUrl;

  const sandboxFlags = useLoopbackServer
    ? "allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
    : "allow-scripts allow-forms allow-popups allow-modals";

  return (
    <div className="pid-wb-preview-stage" data-workbench-preview={kind}>
      <iframe
        key={`${file.cwd ?? ""}::${file.path}:${useLoopbackServer ? "http" : "data"}:${reloadNonce}`}
        className="pid-wb-iframe"
        src={frameSrc}
        title={`动态预览 ${file.path}`}
        sandbox={sandboxFlags}
      />
    </div>
  );
}
