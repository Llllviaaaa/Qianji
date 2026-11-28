/**
 * V2 `动态` Modals, Split-Chat Toggle, Image Lightbox & Sandboxed HTML Widget
 * (`src/builtin-plugins/bot-mode/BotFeedModals.tsx`).
 */
import type { ReactElement } from "react";
import { ChevronLeft, ChevronRight, Maximize2, PanelLeft, X } from "lucide-react";
import { useAppearanceTheme } from "@qianji/client";
import type { BotFeedItem } from "@qianji/protocol";
import { patchBotUi } from "./botStore";

export interface BotLightboxState {
  readonly images: ReadonlyArray<{ readonly url: string; readonly alt: string }>;
  readonly index: number;
}

export function BotDiscoverySplitToggle(props: { readonly splitChatOpen: boolean }): ReactElement {
  const { splitChatOpen } = props;
  if (splitChatOpen) {
    return (
      <button
        type="button"
        className="qj-muse-open-split-btn"
        title="最大化"
        aria-label="最大化"
        data-testid="bot-maximize-discovery"
        onClick={() => patchBotUi({ splitChatOpen: false })}
      >
        <Maximize2 size={16} strokeWidth={1.8} />
      </button>
    );
  }
  return (
    <button
      type="button"
      className="qj-muse-open-split-btn"
      title="打开并排聊天"
      aria-label="打开并排聊天"
      data-testid="bot-open-split-chat"
      onClick={() => patchBotUi({ splitChatOpen: true })}
    >
      <PanelLeft size={17} strokeWidth={1.8} />
    </button>
  );
}

function stripUnsafeScripts(rawHtml: string): string {
  return rawHtml.replace(/<script\b[\s\S]*?<\/script>/gi, "");
}

export function buildFeedWidgetSrcDoc(widgetHtml: string, scheme: "light" | "dark"): string {
  const isDark = scheme === "dark";
  const vars = isDark
    ? [
        "--hatch-widget-text: #fcfcfc;",
        "--hatch-widget-muted: #989b9e;",
        "--hatch-widget-border: rgba(255, 255, 255, 0.08);",
        "--hatch-widget-surface: #222428;",
        "--hatch-widget-surface-muted: #26282d;",
        "--hatch-widget-accent: #4b93ff;",
      ].join("")
    : [
        "--hatch-widget-text: #111214;",
        "--hatch-widget-muted: #686b70;",
        "--hatch-widget-border: rgba(15, 23, 42, 0.08);",
        "--hatch-widget-surface: #ffffff;",
        "--hatch-widget-surface-muted: #f4f5f7;",
        "--hatch-widget-accent: #006ee4;",
      ].join("");

  const safeBody = stripUnsafeScripts(widgetHtml);
  return [
    "<!doctype html>",
    `<html data-theme="${scheme}"><head><meta charset="utf-8" />`,
    `<style>:root{color-scheme:${scheme};${vars}}`,
    "*{box-sizing:border-box;}",
    "html,body{margin:0;padding:0;background:transparent;color:var(--hatch-widget-text);",
    'font-family:"Noto Sans SC","PingFang SC","Microsoft YaHei UI",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
    "font-size:13.5px;line-height:1.5;font-variant-numeric:tabular-nums;}",
    "</style></head>",
    `<body>${safeBody}</body></html>`,
  ].join("");
}

export function BotFeedHtmlWidget(props: {
  readonly title: string;
  readonly widgetHtml: string;
}): ReactElement {
  const { title, widgetHtml } = props;
  const { resolvedScheme } = useAppearanceTheme();
  const srcDoc = buildFeedWidgetSrcDoc(widgetHtml, resolvedScheme);

  return (
    <div className="qj-muse-feed-widget-wrap">
      <iframe
        sandbox=""
        title={title}
        srcDoc={srcDoc}
        className="qj-muse-feed-widget-frame"
        data-testid="feed-html-widget"
      />
    </div>
  );
}

export function BotFeedWhyDialog(props: {
  readonly item: BotFeedItem | null;
  readonly onClose: () => void;
}): ReactElement | null {
  const { item, onClose } = props;
  if (item === null) return null;

  return (
    <div
      className="qj-bot-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="qj-bot-dialog qj-muse-why-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="为何我创建这篇帖子"
        data-testid="feed-why-dialog"
      >
        <div className="qj-muse-dialog-top">
          <h2 className="qj-muse-dialog-heading">为何我创建这篇帖子</h2>
          <button
            type="button"
            className="qj-muse-dialog-close"
            aria-label="关闭"
            data-testid="feed-why-close-btn"
            onClick={onClose}
          >
            <X size={16} strokeWidth={1.9} />
          </button>
        </div>

        <p className="qj-muse-why-body">
          {item.reason || "结合你近期的对话关注点、长期记忆与动态指示为你挑选。"}
        </p>
      </div>
    </div>
  );
}

export function BotFeedImageLightbox(props: {
  readonly state: BotLightboxState | null;
  readonly onClose: () => void;
  readonly onChangeIndex: (nextIndex: number) => void;
}): ReactElement | null {
  const { state, onClose, onChangeIndex } = props;
  if (state === null || state.images.length === 0) return null;
  const clampedIdx = Math.max(0, Math.min(state.images.length - 1, state.index));
  const current = state.images[clampedIdx];
  if (current === undefined) return null;
  const hasMultiple = state.images.length > 1;

  return (
    <div
      className="qj-bot-modal-backdrop qj-muse-lightbox-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="qj-muse-lightbox-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="全屏查看图片"
        data-testid="feed-image-lightbox"
      >
        <button
          type="button"
          className="qj-muse-lightbox-close"
          aria-label="关闭"
          data-testid="feed-lightbox-close-btn"
          onClick={onClose}
        >
          <X size={18} strokeWidth={2} />
        </button>

        {hasMultiple && (
          <button
            type="button"
            className="qj-muse-lightbox-nav is-prev"
            aria-label="上一张图片"
            onClick={() =>
              onChangeIndex((clampedIdx - 1 + state.images.length) % state.images.length)
            }
          >
            <ChevronLeft size={20} strokeWidth={2} />
          </button>
        )}

        <img src={current.url} alt={current.alt} className="qj-muse-lightbox-img" />

        {hasMultiple && (
          <button
            type="button"
            className="qj-muse-lightbox-nav is-next"
            aria-label="下一张图片"
            onClick={() => onChangeIndex((clampedIdx + 1) % state.images.length)}
          >
            <ChevronRight size={20} strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  );
}

export function BotFeedInstructionsDialog(props: {
  readonly open: boolean;
  readonly draft: string;
  readonly unchanged: boolean;
  readonly saving: boolean;
  readonly onChangeDraft: (next: string) => void;
  readonly onClose: () => void;
  readonly onSave: (refreshNow: boolean) => void;
}): ReactElement | null {
  const { open, draft, unchanged, saving, onChangeDraft, onClose, onSave } = props;
  if (!open) return null;

  return (
    <div
      className="qj-bot-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="qj-bot-dialog qj-muse-instructions-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="动态版块说明"
        data-testid="feed-instructions-dialog"
      >
        <div className="qj-muse-dialog-top">
          <h2 className="qj-muse-dialog-heading">动态版块说明</h2>
          <button
            type="button"
            className="qj-muse-dialog-close"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={16} strokeWidth={1.9} />
          </button>
        </div>

        <p className="qj-muse-dialog-desc">
          你的动态版块由以下指示提供支持。你对此提示做出的任何编辑都将应用于今后的动态版块帖子。
        </p>

        <label className="qj-muse-dialog-label" htmlFor="qj-feed-instructions-input">
          你的动态版块应该包含什么内容？
        </label>
        <textarea
          id="qj-feed-instructions-input"
          className="qj-muse-instructions-textarea"
          rows={5}
          value={draft}
          onChange={(e) => onChangeDraft(e.target.value)}
          placeholder="描述你希望千机关注的领域、信息密度与呈现风格…"
        />

        <div className="qj-muse-instructions-foot">
          <button type="button" className="qj-muse-pill-secondary" onClick={onClose}>
            取消
          </button>
          <div className="qj-muse-instructions-foot-right">
            <button
              type="button"
              className="qj-muse-pill-secondary"
              data-testid="feed-instructions-save-refresh"
              disabled={saving || draft.trim() === ""}
              onClick={() => onSave(true)}
            >
              保存并刷新
            </button>
            <button
              type="button"
              className="qj-muse-pill-primary"
              data-testid="feed-instructions-save"
              disabled={saving || unchanged || draft.trim() === ""}
              onClick={() => onSave(false)}
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
