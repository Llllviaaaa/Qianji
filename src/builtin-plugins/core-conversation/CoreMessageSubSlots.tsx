/**
 * Built-in default slot components for `conversation.thinking`,
 * `conversation.toolCall`, `conversation.markdown.codeBlock`, and legacy
 * `conversation.message.actions` bridge (ADR 0023 `core-conversation`).
 */
import { useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  LoaderCircle,
  Sparkles,
  Wrench,
} from "lucide-react";
import {
  useClientContributions,
  useFrontendService,
  type ClientCodeBlockRendererContribution,
  type ClientMessageActionContribution,
  type ClientToolRendererContribution,
  type CodeBlockRendererSlotContext,
  type MessageActionSlotContext,
  type ToolRendererSlotContext,
} from "@qianji/client";
import { Markdown } from "@qianji/client-primitives";
import {
  SlotKernelErrorBoundary,
  type ConversationCodeBlockSlotProps,
  type ConversationMessageActionSlotProps,
  type ConversationThinkingSlotProps,
  type ConversationToolCallSlotProps,
  type SlotComponentProps,
} from "@qianji/client-slots";
import {
  extractToolFilePath,
  fileBaseName,
  singleLineExcerpt,
  summarizeToolArgs,
} from "./conversationHelpers";

/* ── Fault-isolated bridge helper for legacy ctx.contributions render callbacks ── */

function LegacyContribRunner<TContext>({
  renderFn,
  context,
}: {
  readonly renderFn: (ctx: TContext) => ReactNode;
  readonly context: TContext;
}): ReactNode {
  return renderFn(context);
}

function LegacyContribBox<TContext>({
  id,
  pluginId,
  slotKey,
  renderFn,
  context,
  className,
  compact = false,
}: {
  readonly id: string;
  readonly pluginId?: string;
  readonly slotKey: string;
  readonly renderFn: (ctx: TContext) => ReactNode;
  readonly context: TContext;
  readonly className?: string;
  readonly compact?: boolean;
}): ReactNode {
  const ownerPlugin = pluginId ?? "builtin";
  return (
    <div
      className={className}
      data-qj-plugin={ownerPlugin}
      data-qj-slot={slotKey}
      data-qj-entry={id}
      style={className === undefined ? { display: "contents" } : undefined}
    >
      <SlotKernelErrorBoundary pluginId={ownerPlugin} entryId={id} slotKey={slotKey} compact={compact}>
        <LegacyContribRunner renderFn={renderFn} context={context} />
      </SlotKernelErrorBoundary>
    </div>
  );
}

function matchLegacyToolRenderer(
  renderers: readonly ClientToolRendererContribution[],
  toolName: string,
): ClientToolRendererContribution | undefined {
  const normalized = toolName.trim();
  for (const item of renderers) {
    for (const pattern of item.toolNames) {
      const clean = pattern.trim();
      if (clean === "" ) continue;
      if (clean === "*" || clean === normalized) return item;
      if (clean.endsWith("*") && normalized.startsWith(clean.slice(0, -1))) return item;
    }
  }
  return undefined;
}

function matchLegacyCodeBlockRenderer(
  renderers: readonly ClientCodeBlockRendererContribution[],
  language: string,
): ClientCodeBlockRendererContribution | undefined {
  const normalized = language.trim().toLowerCase();
  for (const item of renderers) {
    for (const lang of item.languages) {
      const clean = lang.trim().toLowerCase();
      if (clean === "*" || clean === normalized) return item;
    }
  }
  return undefined;
}

/* ── conversation.thinking ── */

export function CoreThinkingBlock({
  thinking,
  isStreaming = false,
  cwd,
}: SlotComponentProps<ConversationThinkingSlotProps, "session">): ReactNode {
  const [expanded, setExpanded] = useState(isStreaming);
  const trimmed = thinking.trim();
  if (trimmed === "") return null;

  const summary = singleLineExcerpt(trimmed.replace(/\*\*/g, ""), 72);

  return (
    <div
      className="dshc-reasoning"
      data-variant="think"
      data-state={isStreaming ? "running" : "ok"}
      data-expanded={expanded || undefined}
    >
      <button
        type="button"
        className="dshc-reasoning-row"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <Sparkles size={13} strokeWidth={1.75} aria-hidden="true" />
        <span className="dshc-reasoning-title">思考</span>
        {!expanded && (
          <span className="dshc-reasoning-summary">
            <span className="dshc-reasoning-summary-text">{summary}</span>
          </span>
        )}
        {expanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
      </button>
      {expanded && (
        <div className="dshc-think-body" role="log" aria-label="思考过程">
          <div className="dshc-md dshc-md-compact" data-markdown-variant="compact">
            <Markdown content={trimmed} cwd={cwd} />
          </div>
        </div>
      )}
    </div>
  );
}

/* ── conversation.toolCall ── */

export function CoreToolCallCard({
  call,
  state,
  cwd,
  sessionFile,
}: SlotComponentProps<ConversationToolCallSlotProps, "session">): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const contributions = useClientContributions();
  const workbenchService = useFrontendService("workbenchService");

  const legacyRenderer = matchLegacyToolRenderer(contributions.toolRenderers, call.name);
  if (legacyRenderer !== undefined) {
    const legacyCtx: ToolRendererSlotContext = {
      cwd: cwd ?? "",
      sessionFile: sessionFile ?? null,
      call,
      state,
    };
    return (
      <LegacyContribBox
        id={legacyRenderer.id}
        pluginId={legacyRenderer.pluginId}
        slotKey="conversation.toolCall"
        renderFn={legacyRenderer.render}
        context={legacyCtx}
        className="dshc-tool dshc-plugin-tool-card"
      />
    );
  }

  const filePath = extractToolFilePath(call.args);
  const summary = filePath !== null ? fileBaseName(filePath) : summarizeToolArgs(call.args);
  const hasDetail = (call.result !== undefined && call.result !== "") || Object.keys(call.args).length > 0;

  return (
    <div
      className="dshc-tool"
      data-tool={call.name}
      data-state={state}
    >
      <div className="dshc-tool-row">
        <button
          type="button"
          className="dshc-disclosure-trigger"
          aria-expanded={hasDetail ? expanded : undefined}
          onClick={() => hasDetail && setExpanded((value) => !value)}
        >
          {state === "running" ? (
            <LoaderCircle className="spin" size={12} aria-hidden="true" />
          ) : (
            <Wrench size={12} aria-hidden="true" />
          )}
          <span className="dshc-tool-title">{call.name}</span>
          {summary !== "" && <span className="dshc-tool-summary">{summary}</span>}
          {hasDetail && (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
        </button>
        {filePath !== null && (
          <button
            type="button"
            className="dshc-file-link"
            title={filePath}
            onClick={() => {
              void workbenchService?.openFile(filePath, cwd !== undefined && cwd !== "" ? { cwd } : undefined);
            }}
          >
            打开
          </button>
        )}
      </div>
      {expanded && hasDetail && (
        <div className="dshc-tool-body">
          <div className="dshc-io-card">
            {Object.keys(call.args).length > 0 && (
              <div className="dshc-io-section">
                <span className="dshc-io-label">输入</span>
                <pre className="dshc-io-text">{JSON.stringify(call.args, null, 2)}</pre>
              </div>
            )}
            {call.result !== undefined && call.result !== "" && (
              <div className="dshc-io-section">
                <span className="dshc-io-label">输出</span>
                <pre className="dshc-io-text" data-error={state === "error" || undefined}>
                  {call.result}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── conversation.markdown.codeBlock ── */

export function CoreCodeBlock({
  language,
  code,
  cwd,
  sessionFile,
}: SlotComponentProps<ConversationCodeBlockSlotProps, "session">): ReactNode {
  const [copied, setCopied] = useState(false);
  const contributions = useClientContributions();

  const legacyRenderer = matchLegacyCodeBlockRenderer(contributions.codeBlockRenderers, language);
  if (legacyRenderer !== undefined) {
    const legacyCtx: CodeBlockRendererSlotContext = {
      cwd: cwd ?? "",
      sessionFile: sessionFile ?? null,
      language,
      code,
    };
    return (
      <LegacyContribBox
        id={legacyRenderer.id}
        pluginId={legacyRenderer.pluginId}
        slotKey="conversation.markdown.codeBlock"
        renderFn={legacyRenderer.render}
        context={legacyCtx}
        className="markdown-plugin-block dshc-code-block-plugin"
      />
    );
  }

  const handleCopy = () => {
    if (typeof navigator === "undefined" || navigator.clipboard === undefined) return;
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        if (typeof window !== "undefined") {
          window.setTimeout(() => setCopied(false), 1200);
        }
      })
      .catch(() => undefined);
  };

  return (
    <div className="dshc-code-card" data-code-language={language}>
      <div className="dshc-code-card-header">
        <span className="dshc-code-card-title">{language}</span>
        <button
          type="button"
          className="dshc-action"
          aria-label={copied ? "已复制代码" : "复制代码"}
          title={copied ? "已复制" : "复制代码"}
          onClick={handleCopy}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      <div className="dshc-code-card-body">
        <pre className="dshc-code-pre">
          <code className={`language-${language}`}>{code}</code>
        </pre>
      </div>
    </div>
  );
}

/* ── conversation.message.actions (legacy ctx.contributions.messageActions bridge) ── */

export function CoreLegacyMessageActions({
  cwd,
  sessionFile,
  message,
  contentText,
}: SlotComponentProps<ConversationMessageActionSlotProps, "session">): ReactNode {
  const contributions = useClientContributions();
  const matched: ClientMessageActionContribution[] = contributions.messageActions.filter((item) => {
    if (item.role === undefined || item.role === "both") return true;
    return item.role === message.role;
  });
  if (matched.length === 0) return null;

  const legacyCtx: MessageActionSlotContext = {
    cwd,
    sessionFile,
    message,
    contentText,
  };

  return (
    <>
      {matched.map((item) => (
        <LegacyContribBox
          key={item.id}
          id={item.id}
          pluginId={item.pluginId}
          slotKey="conversation.message.actions"
          renderFn={item.render}
          context={legacyCtx}
          compact
        />
      ))}
    </>
  );
}
