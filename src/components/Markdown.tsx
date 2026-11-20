import { Children, createContext, isValidElement, memo, useContext, useMemo, useState, type ComponentPropsWithoutRef, type MouseEvent, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import type { PluggableList } from "unified";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy, FileText } from "lucide-react";
import { useAppStore } from "../store";
import { showToast } from "../notifications";
import { agent } from "../lib/agent";
import { stripCodeReviewDirectives } from "../lib/codeReview";
import { matchCodeBlockRenderer, useClientContributions } from "../lib/clientContributions";
import { describeError } from "../lib/errors";
import { FILE_SCHEME, INLINE_FILE_RE, fileHref, linkifyFilePaths, normalizeMarkdownUrl, parseFileHref } from "../lib/markdownFileLinks";
import { isRichContentLanguage, parseRichContent } from "../lib/richContent";
import { splitStreamingMarkdownBlocks } from "../lib/streamingMarkdown";
import { resolveWorkspacePath } from "../lib/workspaceEditors";
import { INTELLIGENT_UI_FENCE_LANGUAGE, parseIntelligentUiFence } from "../lib/intelligentUi";
import { SlotHost } from "@qianji/client-slots";
import { useCodeBlockSlotStatus } from "../kernel/runtime/featureSlotQueries";
import { useIntelligentUiStore } from "../stores/intelligentUiStore";
import { SlotEntryHost } from "./common/ErrorBoundary";
import { DiagramBlock, diagramKindForLanguage } from "./DiagramBlock";
import { IntelligentUiCard } from "./IntelligentUiCard";
import { RichContent } from "./RichContent";
import { useFileActions } from "./WorkspaceOpeners";

/** When provided, file links open in the in-app document pane instead of the OS. */
export type OpenWorkspaceFile = (path: string, line?: number) => void;
export const WorkspaceFileOpenContext = createContext<OpenWorkspaceFile | null>(null);

function openFileRef(event: MouseEvent, href: string) {
  event.preventDefault();
  const { path } = parseFileHref(href);
  const cwd = useAppStore.getState().cwd;
  const absolute = resolveWorkspacePath(cwd, path);
  const fallback = (error?: unknown) => {
    void navigator.clipboard.writeText(absolute).catch(() => undefined);
    const reason = error !== undefined ? `（${describeError(error)}）` : "";
    showToast(`无法直接打开${reason}，已复制路径：${absolute}`, "info");
  };
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    fallback();
    return;
  }
  agent.openFileInDefaultApp(absolute).catch((error) => fallback(error));
}

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Bash",
  c: "C",
  cpp: "C++",
  cs: "C#",
  csharp: "C#",
  css: "CSS",
  dart: "Dart",
  diff: "Diff",
  go: "Go",
  html: "HTML",
  java: "Java",
  js: "JavaScript",
  json: "JSON",
  jsonc: "JSON",
  jsx: "JSX",
  kotlin: "Kotlin",
  md: "Markdown",
  markdown: "Markdown",
  mermaid: "Mermaid",
  mjs: "JavaScript",
  php: "PHP",
  plantuml: "PlantUML",
  puml: "PlantUML",
  "qianji-rich": "千机 Rich",
  "pidesktop-rich": "千机 Rich",
  "intelligent-ui": "Intelligent UI",
  ps1: "PowerShell",
  powershell: "PowerShell",
  py: "Python",
  python: "Python",
  rb: "Ruby",
  rs: "Rust",
  rust: "Rust",
  scss: "SCSS",
  sh: "Shell",
  sql: "SQL",
  svelte: "Svelte",
  swift: "Swift",
  toml: "TOML",
  ts: "TypeScript",
  tsx: "TSX",
  uml: "PlantUML",
  vue: "Vue",
  xml: "XML",
  yaml: "YAML",
  yml: "YAML",
  zsh: "Shell",
};

function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children);
  return "";
}

function codeFenceDetails(children: ReactNode): {
  codeEl: ReactElement<{ className?: string; children?: ReactNode }> | undefined;
  language: string;
  text: string;
} {
  const codeEl = Children.toArray(children).find((child) => {
    if (!isValidElement(child)) return false;
    if (child.type === "code") return true;
    const className = (child.props as { className?: string }).className || "";
    return className.includes("language-") || className.includes("hljs");
  }) as ReactElement<{ className?: string; children?: ReactNode }> | undefined;
  const language = /language-([^\s]+)/.exec(codeEl?.props.className || "")?.[1]?.toLowerCase() || "";
  const text = nodeText(codeEl?.props.children ?? children).replace(/\n$/, "");
  return { codeEl, language, text };
}

function CodeFence({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const { language, text } = codeFenceDetails(children);
  const label = language ? LANGUAGE_LABELS[language] || language : "";

  return (
    <div className="markdown-code">
      <div className="markdown-code-bar">
        <span>{label}</span>
        <button
          type="button"
          className="markdown-code-copy"
          title={copied ? "已复制" : "复制代码"}
          aria-label={copied ? "已复制" : "复制代码"}
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            }).catch(() => undefined);
          }}
        >
          {copied ? <Check size={13} strokeWidth={1.75} /> : <Copy size={13} strokeWidth={1.75} />}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

function MarkdownPre({
  children,
  allowRichContent = false,
  isStreaming = false,
}: {
  children?: ReactNode;
  allowRichContent?: boolean;
  isStreaming?: boolean;
}) {
  const { language, text } = codeFenceDetails(children);
  const intelligentUiEnabled = useIntelligentUiStore((state) => state.pluginEnabled);
  const { hasSlotEntry, allowPrebootDiagramFallback } = useCodeBlockSlotStatus(language);
  const { codeBlockRenderers } = useClientContributions();
  const cwd = useAppStore((state) => state.cwd);
  const sessionFile = useAppStore((state) => state.sessionFile);
  const richDocument = useMemo(
    () => allowRichContent && isRichContentLanguage(language) ? parseRichContent(text) : null,
    [allowRichContent, language, text],
  );
  const intelligentUiGroup = useMemo(() => {
    if (!intelligentUiEnabled || language !== INTELLIGENT_UI_FENCE_LANGUAGE) return null;
    const artifact = parseIntelligentUiFence(text);
    return artifact ? { id: artifact.id, versions: [artifact], latest: artifact } : null;
  }, [intelligentUiEnabled, language, text]);
  if (richDocument) return <RichContent document={richDocument} />;
  if (intelligentUiGroup) return <IntelligentUiCard group={intelligentUiGroup} mode="inline" />;
  const pluginRenderer = matchCodeBlockRenderer(codeBlockRenderers, language);
  if (pluginRenderer) {
    return (
      <SlotEntryHost
        entry={pluginRenderer}
        context={{ cwd, sessionFile, language, code: text }}
        slotName="markdown.codeBlock"
        className="markdown-plugin-block"
      />
    );
  }
  if (hasSlotEntry) {
    const normalizedLang = language.trim().toLowerCase() || "text";
    return (
      <SlotHost
        slotKey="conversation.markdown.codeBlock"
        kind="keyed"
        routeKey={normalizedLang}
        props={{ cwd, sessionFile, language: normalizedLang, code: text, isStreaming }}
        fallback={<CodeFence>{children}</CodeFence>}
      />
    );
  }
  const diagramKind = diagramKindForLanguage(language);
  if (allowPrebootDiagramFallback && diagramKind !== null) {
    return isStreaming ? <CodeFence>{children}</CodeFence> : <DiagramBlock kind={diagramKind} source={text} />;
  }
  return <CodeFence>{children}</CodeFence>;
}

function MarkdownTable({ children, ...props }: ComponentPropsWithoutRef<"table">) {
  return (
    <div className="markdown-table-scroll" role="region" aria-label="表格内容，可横向滚动" tabIndex={0}>
      <table {...props}>{children}</table>
    </div>
  );
}

function richContentFenceCount(markdown: string): number {
  const allRichOpeners = markdown
    .split(/\r?\n/)
    .filter((line) => /(`{3,}|~{3,})[ \t]*(?:qianji-rich|pidesktop-rich)/i.test(line))
    .length;
  let activeFence: { marker: "`" | "~"; length: number; rich: boolean } | null = null;
  let richStarts = 0;
  let richCompleted = 0;
  for (const line of markdown.split(/\r?\n/)) {
    if (!activeFence) {
      const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (!opening) continue;
      const rich = isRichContentLanguage(opening[2]);
      if (rich) richStarts += 1;
      activeFence = { marker: opening[1][0] as "`" | "~", length: opening[1].length, rich };
      continue;
    }
    const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (!closing || closing[1][0] !== activeFence.marker || closing[1].length < activeFence.length) continue;
    if (activeFence.rich) richCompleted += 1;
    activeFence = null;
  }
  return allRichOpeners === richStarts && richStarts === richCompleted ? richCompleted : -1;
}

function FileRef({ href, children }: { href: string; children?: ReactNode }) {
  const openInApp = useContext(WorkspaceFileOpenContext);
  const fileActions = useFileActions();
  const editor = fileActions?.preferredEditor;
  return (
    <a
      className="file-ref"
      href={href}
      title={editor ? `单击预览 · Ctrl+单击在 ${editor.name} 中打开 · 右键查看更多` : "单击预览 · 右键查看更多"}
      onContextMenu={(event) => {
        if (!fileActions) return;
        const { path, line } = parseFileHref(href);
        fileActions.showMenu(event, path, line);
      }}
      onClick={(event) => {
        if ((event.ctrlKey || event.metaKey) && fileActions) {
          event.preventDefault();
          const { path, line } = parseFileHref(href);
          fileActions.openInEditor(path, line);
          return;
        }
        if (!openInApp) {
          openFileRef(event, href);
          return;
        }
        event.preventDefault();
        const { path, line } = parseFileHref(href);
        openInApp(path, line);
      }}
    >
      <FileText size={13} strokeWidth={1.8} />
      <span>{children}</span>
    </a>
  );
}

const REMARK_PLUGINS: PluggableList = [remarkGfm];
const REHYPE_PLUGINS: PluggableList = [[rehypeHighlight, { detect: false, ignoreMissing: true }]];
const markdownUrlTransform = normalizeMarkdownUrl;

interface MarkdownProps {
  content: string;
  allowRichContent?: boolean;
  isStreaming?: boolean;
}

const MarkdownBlockChunk = memo(function MarkdownBlockChunk({
  content,
  allowRichContent,
  isStreaming,
}: {
  content: string;
  allowRichContent: boolean;
  isStreaming: boolean;
}) {
  const linkedMarkdown = useMemo(() => linkifyFilePaths(content), [content]);
  const components = useMemo<Components>(
    () => ({
      pre: ({ children }) => (
        <MarkdownPre allowRichContent={allowRichContent} isStreaming={isStreaming}>{children}</MarkdownPre>
      ),
      table: ({ children, node: _node, ...props }) => <MarkdownTable {...props}>{children}</MarkdownTable>,
      a: ({ href, children }) => {
        if (href?.startsWith(FILE_SCHEME)) return <FileRef href={href}>{children}</FileRef>;
        return (
          <a
            href={href}
            onClick={(event) => {
              if (!href) return;
              event.preventDefault();
              void openUrl(href).catch((error) => {
                showToast(`无法打开链接：${describeError(error)}`, "error");
              });
            }}
          >
            {children}
          </a>
        );
      },
      code: ({ className, children, ...rest }) => {
        const text = typeof children === "string"
          ? children
          : Array.isArray(children) && children.length === 1 && typeof children[0] === "string"
            ? children[0]
            : null;
        if (!className && text) {
          const match = INLINE_FILE_RE.exec(text.trim());
          // A path in inline code stays a code chip whose text is the file link (dsh-claude-style file mentions).
          if (match) return <code className="file-mention"><FileRef href={fileHref(match[1], match[2])}>{text.trim()}</FileRef></code>;
        }
        return <code className={className} {...rest}>{children}</code>;
      },
    }),
    [allowRichContent, isStreaming],
  );

  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      urlTransform={markdownUrlTransform}
      components={components}
    >
      {linkedMarkdown}
    </ReactMarkdown>
  );
});

export const Markdown = memo(function Markdown({
  content,
  allowRichContent = false,
  isStreaming = false,
}: MarkdownProps) {
  const visibleContent = useMemo(() => stripCodeReviewDirectives(content), [content]);
  const richContentEnabled = useMemo(
    () => allowRichContent && richContentFenceCount(visibleContent) === 1,
    [allowRichContent, visibleContent],
  );
  const blocks = useMemo(
    () => (isStreaming ? splitStreamingMarkdownBlocks(visibleContent) : [visibleContent]),
    [isStreaming, visibleContent],
  );

  return (
    <div className="markdown-body">
      {!isStreaming || blocks.length <= 1 ? (
        <MarkdownBlockChunk
          content={blocks[0] ?? visibleContent}
          allowRichContent={richContentEnabled}
          isStreaming={isStreaming}
        />
      ) : (
        <>
          {blocks.slice(0, -1).map((block, index) => (
            <MarkdownBlockChunk
              key={index}
              content={block}
              allowRichContent={richContentEnabled}
              isStreaming={false}
            />
          ))}
          <MarkdownBlockChunk
            key={blocks.length - 1}
            content={blocks[blocks.length - 1] ?? ""}
            allowRichContent={richContentEnabled}
            isStreaming
          />
        </>
      )}
    </div>
  );
});
