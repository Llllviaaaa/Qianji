/**
 * Built-in default `conversation.message` slot component (ADR 0023 `core-conversation`).
 */
import type { ReactNode } from "react";
import { Info, LoaderCircle, Terminal } from "lucide-react";
import { useFrontendService } from "@qianji/client";
import { Markdown } from "@qianji/client-primitives";
import type {
  ConversationMessageSlotProps,
  SlotComponentProps,
} from "@qianji/client-slots";
import {
  extractInlineThinking,
  formatMessageClock,
  formatRunDuration,
  splitMarkdownCodeBlocks,
} from "./conversationHelpers";
import { CopyActionButton, CoreUserMessageRow } from "./CoreUserMessageRow";

export function CoreMessageItem({
  cwd: ownerCwd,
  sessionFile: ownerSessionFile,
  message,
  isStreaming = false,
  isLast = false,
  onRewind,
  onEditAndResend,
  sessionId,
  renderSlot,
  renderSlotChain,
}: SlotComponentProps<ConversationMessageSlotProps, "session">): ReactNode {
  const workbenchService = useFrontendService("workbenchService");
  const resolvedCwd = ownerCwd ?? "";
  const resolvedSessionFile = ownerSessionFile ?? null;
  const clockLabel = formatMessageClock(message.timestamp);

  const openFileFromMarkdown = (filePath: string, line?: number) => {
    void workbenchService?.openFile(filePath, {
      ...(resolvedCwd !== "" ? { cwd: resolvedCwd } : {}),
      ...(typeof line === "number" && line > 0 ? { line } : {}),
    });
  };

  if (message.role === "terminal") {
    return (
      <article
        className={`dshc-flow message-row terminal-message ${message.isError ? "error" : ""}`}
        id={`message-${message.id}`}
        data-session-id={sessionId}
        data-message-id={message.id}
      >
        <div className="notice-heading">
          <Terminal size={14} /> 终端
        </div>
        <pre>{message.content}</pre>
      </article>
    );
  }

  if (message.role === "notice") {
    if (message.noticeKind === "compaction" || message.noticeKind === "branch") {
      const label = message.noticeKind === "compaction" ? "上下文已压缩" : "会话已分叉";
      return (
        <div
          className={`dshc-flow compaction-divider is-${message.noticeKind}`}
          role="separator"
          id={`message-${message.id}`}
          data-session-id={sessionId}
          data-message-id={message.id}
        >
          <span>{label}</span>
        </div>
      );
    }
    return (
      <article
        className="dshc-flow message-row notice-message"
        id={`message-${message.id}`}
        data-session-id={sessionId}
        data-message-id={message.id}
      >
        <Info size={14} strokeWidth={1.75} aria-hidden="true" />
        <div className="notice-content">
          <Markdown content={message.content} cwd={resolvedCwd} onOpenFile={openFileFromMarkdown} />
        </div>
      </article>
    );
  }

  if (message.role === "user") {
    return (
      <CoreUserMessageRow
        message={message}
        cwd={resolvedCwd}
        sessionFile={resolvedSessionFile}
        sessionId={sessionId}
        clockLabel={clockLabel}
        onRewind={onRewind}
        onEditAndResend={onEditAndResend}
        renderSlot={renderSlot}
      />
    );
  }

  const working = message.isStreaming === true || (isLast && isStreaming);
  const extracted = extractInlineThinking(message.content, message.thinking);
  const assistantContent = extracted.content;
  const thinkingText = extracted.thinking;
  const toolCalls = message.toolCalls ?? [];
  const hasContent = assistantContent.trim() !== "";
  const segments = hasContent ? splitMarkdownCodeBlocks(assistantContent) : [];

  return (
    <article
      className={`dshc-flow dshc-turn${message.isError ? " is-error" : ""}`}
      data-chat-flow-kind="assistant"
      data-turn-open={working || undefined}
      data-actions-reveal={isLast ? "always" : "hover"}
      data-session-id={sessionId}
      data-message-id={message.id}
      id={`message-${message.id}`}
    >
      {!working && (message.durationMs !== undefined || message.isError || message.isAborted) && (
        <div className="dshc-turn-process">
          <span className="dshc-turn-process-label">
            {message.isError
              ? "处理失败"
              : message.isAborted
                ? "已停止"
                : message.durationMs !== undefined && message.durationMs > 0
                  ? `已完成，用时 ${formatRunDuration(message.durationMs)}`
                  : "已完成"}
          </span>
        </div>
      )}

      {thinkingText !== "" &&
        renderSlotChain("conversation.thinking", {
          cwd: resolvedCwd,
          sessionFile: resolvedSessionFile,
          message,
          thinking: thinkingText,
          isStreaming: working && !hasContent,
          ...(message.workSteps === undefined ? {} : { workSteps: message.workSteps }),
        })}

      {toolCalls.length > 0 && (
        <div className="dshc-tool-list">
          {toolCalls.map((call) => {
            const state: "running" | "error" | "ok" = call.running ? "running" : call.isError ? "error" : "ok";
            return (
              <div key={call.id} style={{ display: "contents" }}>
                {renderSlot(
                  "conversation.toolCall",
                  {
                    cwd: resolvedCwd,
                    sessionFile: resolvedSessionFile,
                    call,
                    state,
                    messageId: message.id,
                  },
                  { key: call.name },
                )}
              </div>
            );
          })}
        </div>
      )}

      {hasContent && (
        <div className="dshc-answer" data-streaming={working || undefined}>
          <div className="dshc-md dshc-md-prose">
            {segments.map((segment, index) =>
              segment.kind === "prose" ? (
                <Markdown
                  key={`prose-${index}`}
                  content={segment.text}
                  cwd={resolvedCwd}
                  onOpenFile={openFileFromMarkdown}
                  allowRichContent={!working}
                  isStreaming={working}
                />
              ) : (
                <div key={`code-${index}`} style={{ display: "contents" }}>
                  {renderSlot(
                    "conversation.markdown.codeBlock",
                    {
                      cwd: resolvedCwd,
                      sessionFile: resolvedSessionFile,
                      language: segment.language,
                      code: segment.code,
                      isStreaming: working,
                    },
                    {
                      key: segment.language,
                      fallback: (
                        <pre className="dshc-code-fallback" data-code-language={segment.language}>
                          <code>{segment.code}</code>
                        </pre>
                      ),
                    },
                  )}
                </div>
              ),
            )}
          </div>
        </div>
      )}

      {message.isError && message.error !== undefined && (
        <div className="dshc-turn-error" role="status">
          <div className="dshc-turn-error-message">{message.error.message}</div>
        </div>
      )}

      {working && (
        <div className="dshc-running" data-chat-running="">
          <LoaderCircle className="spin" size={14} aria-hidden="true" />
          <span className="dsh-claude-chat-wait-label">正在生成回复…</span>
        </div>
      )}

      {hasContent && !working && (
        <div className="dshc-actions dshc-turn-actions" data-clock="end">
          <CopyActionButton text={assistantContent} title="复制回复" />
          {renderSlot("conversation.message.actions", {
            cwd: resolvedCwd,
            sessionFile: resolvedSessionFile,
            message,
            contentText: assistantContent,
          })}
          {clockLabel !== "" && (
            <span className="dshc-end-info">
              <span className="dshc-time-end">{clockLabel}</span>
            </span>
          )}
        </div>
      )}
    </article>
  );
}
