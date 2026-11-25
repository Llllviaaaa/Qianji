import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, RotateCcw, Settings } from "lucide-react";
import {
  describeLlmErrorHint,
  describeLlmErrorTitle,
  formatErrorCopyText,
  inferLlmErrorFromMessage,
  shouldSuggestModelSettings,
} from "../../lib/llmError";
import { requestOpenSettings } from "../../lib/shellBridge";
import { useAppStore } from "../../store";
import type { UiMessage } from "../../types";

export const DEFAULT_TURN_RETRY_PROMPT = "请重试并继续完成上一轮未完成的回复。";
export const DEFAULT_TURN_CONTINUE_PROMPT = "请从上次截断处直接继续输出剩余内容。";

export function TurnErrorCard({
  message,
  fallbackContent,
  isLast,
  onRetry,
}: {
  message: UiMessage;
  fallbackContent?: string;
  isLast?: boolean;
  onRetry?: () => void;
}) {
  const [rawOpen, setRawOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const isStreaming = useAppStore((state) => state.isStreaming);

  const error = inferLlmErrorFromMessage({
    content: fallbackContent ?? message.content,
    isError: message.isError,
    error: message.error,
  });
  if (error === null) return null;

  const title = describeLlmErrorTitle(error);
  const hint = describeLlmErrorHint(error);
  const suggestSettings = shouldSuggestModelSettings(error);
  const showRetry = error.retryable !== false && (onRetry !== undefined || (isLast === true && !isStreaming));
  const sourceLabel = [error.provider, message.model].filter(Boolean).join(" / ");
  const codeBadge = error.code ?? error.errorType;
  const secondaryType = error.code && error.errorType && error.errorType !== error.code ? error.errorType : undefined;
  const hasRaw = Boolean(error.rawBody && error.rawBody.trim() !== "" && error.rawBody.trim() !== error.message.trim());

  const handleRetry = () => {
    if (onRetry !== undefined) {
      onRetry();
      return;
    }
    const store = useAppStore.getState();
    if (store.isStreaming) return;
    void store.sendMessage(DEFAULT_TURN_RETRY_PROMPT);
  };

  const handleCopy = () => {
    const text = formatErrorCopyText(error, message.model);
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    }).catch(() => undefined);
  };

  return (
    <div className="dshc-turn-error" role="status" data-error-kind={error.kind ?? "unknown"}>
      <div className="dshc-turn-error-header">
        <div className="dshc-turn-error-heading">
          <span className="dshc-state-dot" data-state="error" aria-hidden="true" />
          <span className="dshc-turn-error-title">{title}</span>
          {error.status !== undefined && (
            <span className="dshc-turn-error-badge is-status">HTTP {error.status}</span>
          )}
          {codeBadge && (
            <span className="dshc-turn-error-badge is-code">{codeBadge}</span>
          )}
          {secondaryType && (
            <span className="dshc-turn-error-badge">{secondaryType}</span>
          )}
          {sourceLabel && (
            <span className="dshc-turn-error-source" title={sourceLabel}>{sourceLabel}</span>
          )}
        </div>
        <div className="dshc-turn-error-tools">
          {showRetry && (
            <button
              type="button"
              className="dshc-turn-error-btn"
              onClick={handleRetry}
              title="重试本轮请求"
            >
              <RotateCcw size={12} strokeWidth={1.75} />
              <span>重试</span>
            </button>
          )}
          {suggestSettings && (
            <button
              type="button"
              className="dshc-turn-error-btn"
              onClick={() => requestOpenSettings("models")}
              title="打开模型设置检查 API Key 或端点"
            >
              <Settings size={12} strokeWidth={1.75} />
              <span>模型设置</span>
            </button>
          )}
          <button
            type="button"
            className="dshc-turn-error-btn"
            onClick={handleCopy}
            title="复制完整错误详情"
            aria-label="复制错误详情"
          >
            {copied ? <Check size={12} strokeWidth={2} /> : <Copy size={12} strokeWidth={1.75} />}
            <span>{copied ? "已复制" : "复制"}</span>
          </button>
        </div>
      </div>

      <div className="dshc-turn-error-copy">
        <div className="dshc-turn-error-message">{error.message}</div>
        {hint && <div className="dshc-turn-error-hint">{hint}</div>}
      </div>

      {(error.requestId || hasRaw) && (
        <div className="dshc-turn-error-footer">
          {hasRaw && (
            <button
              type="button"
              className="dshc-turn-error-raw-toggle"
              aria-expanded={rawOpen}
              onClick={() => setRawOpen((open) => !open)}
            >
              {rawOpen ? <ChevronDown size={13} strokeWidth={1.8} /> : <ChevronRight size={13} strokeWidth={1.8} />}
              <span>{rawOpen ? "收起原始返回" : "查看提供商原始返回"}</span>
            </button>
          )}
          {error.requestId && (
            <span className="dshc-turn-error-reqid" title={`Request ID: ${error.requestId}`}>
              Request ID: <code>{error.requestId}</code>
            </span>
          )}
        </div>
      )}

      {hasRaw && rawOpen && (
        <pre className="dshc-turn-error-raw"><code>{error.rawBody}</code></pre>
      )}
    </div>
  );
}

export function TurnIncompleteBanner({
  isLast,
  onContinue,
}: {
  isLast?: boolean;
  onContinue?: () => void;
}) {
  const isStreaming = useAppStore((state) => state.isStreaming);
  const showContinue = onContinue !== undefined || (isLast === true && !isStreaming);

  const handleContinue = () => {
    if (onContinue !== undefined) {
      onContinue();
      return;
    }
    const store = useAppStore.getState();
    if (store.isStreaming) return;
    void store.sendMessage(DEFAULT_TURN_CONTINUE_PROMPT);
  };

  return (
    <div className="dshc-turn-incomplete" role="status">
      <div className="dshc-turn-incomplete-copy">
        <span className="dshc-state-dot" data-state="warn" aria-hidden="true" />
        <span>回答因达到输出长度上限而未完成</span>
      </div>
      {showContinue && (
        <button
          type="button"
          className="dshc-turn-incomplete-btn"
          onClick={handleContinue}
          title="让模型从上次截断处继续输出"
        >
          <RotateCcw size={12} strokeWidth={1.75} />
          <span>继续生成</span>
        </button>
      )}
    </div>
  );
}
