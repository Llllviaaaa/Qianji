/**
 * Message stream helpers, Muse Floating Topbar, and Quick-Option Bubble renderer
 * for `BotChatView` (`src/builtin-plugins/bot-mode/BotChatThreadWidgets.tsx`).
 */
import type { ReactElement } from "react";
import {
  ArrowUpRight,
  Cpu,
  GitBranch,
  Menu,
  MoreHorizontal,
  PanelRight,
  Phone,
  Reply,
  ShieldAlert,
  Smile,
} from "lucide-react";
import { Markdown } from "@qianji/client-primitives";

export function stripBotThinking(raw: string): string {
  if (!raw.includes("<think>")) return raw;
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trimStart();
}

export function extractBotQuickOptions(text: string): {
  readonly cleanBody: string;
  readonly options: readonly string[];
} {
  const closedMatch = /\[\[\s*options\s*:\s*([\s\S]*?)\]\]\s*$/i.exec(text);
  if (closedMatch !== null) {
    const rawList = closedMatch[1] ?? "";
    const options = rawList
      .split(/\||｜/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const cleanBody = text.slice(0, closedMatch.index).trimEnd();
    return { cleanBody, options };
  }
  const openIdx = text.search(/\[\[\s*options\s*:/i);
  if (openIdx >= 0) {
    return { cleanBody: text.slice(0, openIdx).trimEnd(), options: [] };
  }
  return { cleanBody: text, options: [] };
}

export function filterVisibleBotMessages<
  T extends { readonly role: string; readonly content: string },
>(messages: readonly T[], isStreaming: boolean): readonly T[] {
  const lastRawIdx = messages.length - 1;
  return messages.filter((msg, idx) => {
    if (msg.role === "user") return true;
    if (stripBotThinking(msg.content).trim() !== "") return true;
    return isStreaming && idx === lastRawIdx;
  });
}

export function BotLiveThinkingRow(): ReactElement {
  return (
    <div
      className="qj-msg-row qj-sanctuary-msg-bot-row is-thinking"
      data-testid="bot-live-thinking"
    >
      <div className="qj-muse-typing-pill" aria-label="正在回复">
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
      </div>
    </div>
  );
}

export function BotChatFloatingTopbar(props: {
  readonly topTitle: string;
  readonly isMain: boolean;
  readonly drawerVisible: boolean;
  readonly compactSplit: boolean;
  readonly rightPanelOpen: boolean;
  readonly voiceCallActive: boolean;
  readonly pendingApprovalsCount: number;
  readonly modelLabel?: string;
  readonly onOpenDrawer: () => void;
  readonly onOpenModels?: () => void;
  readonly onOpenApprovals: () => void;
  readonly onToggleVoice: () => void;
  readonly onOpenRightPanel: () => void;
}): ReactElement {
  const {
    topTitle,
    isMain,
    drawerVisible,
    compactSplit,
    rightPanelOpen,
    voiceCallActive,
    pendingApprovalsCount,
    modelLabel,
    onOpenDrawer,
    onOpenModels,
    onOpenApprovals,
    onToggleVoice,
    onOpenRightPanel,
  } = props;

  return (
    <header className="qj-muse-float-topbar" data-tauri-drag-region="">
      <div className="qj-bot-topbar-left">
        {!drawerVisible ? (
          <button
            id="btn-toggle-chat-drawer"
            type="button"
            className="qj-muse-pill-btn"
            aria-label="打开旁聊与历史列表"
            onClick={onOpenDrawer}
          >
            <Menu size={15} strokeWidth={1.85} aria-hidden="true" />
            <span>{topTitle}</span>
          </button>
        ) : (
          !isMain && <span className="qj-muse-pill-label">{topTitle}</span>
        )}
      </div>

      <div className="qj-bot-topbar-right">
        {!compactSplit && onOpenModels && (
          <button
            type="button"
            className="qj-muse-pill-btn"
            data-testid="bot-topbar-model-btn"
            title="在分身设置中切换模型或配置密钥"
            onClick={onOpenModels}
          >
            <Cpu size={13.5} strokeWidth={1.85} aria-hidden="true" />
            <span>{modelLabel || "配置模型"}</span>
          </button>
        )}

        {pendingApprovalsCount > 0 && (
          <button type="button" className="qj-muse-pill-btn alert" onClick={onOpenApprovals}>
            <ShieldAlert size={14} strokeWidth={1.85} aria-hidden="true" />
            <span>{pendingApprovalsCount}</span>
          </button>
        )}

        <button
          type="button"
          className={`qj-muse-pill-btn${voiceCallActive ? " active" : ""}`}
          onClick={onToggleVoice}
        >
          <Phone size={14} strokeWidth={1.85} aria-hidden="true" />
          <span>{voiceCallActive ? "通话中" : "通话"}</span>
        </button>

        {!compactSplit && !rightPanelOpen && (
          <button
            id="btn-toggle-right-panel"
            type="button"
            title="展开陪伴面板"
            aria-label="展开陪伴面板"
            className="qj-muse-pill-icon-btn"
            onClick={onOpenRightPanel}
          >
            <PanelRight size={16} strokeWidth={1.8} />
          </button>
        )}
      </div>
    </header>
  );
}

export function BotAssistantBubbleRow(props: {
  readonly msgId: string;
  readonly cleanContent: string;
  readonly isStreaming: boolean;
  readonly reacted: boolean;
  readonly moreOpen: boolean;
  readonly onToggleReaction: () => void;
  readonly onQuote: (snippet: string) => void;
  readonly onToggleMore: () => void;
  readonly onCloseMore: () => void;
  readonly onCopy: (body: string) => void;
  readonly onBranchSideChat: (body: string) => void;
  readonly onOpenInWorkbench: (body: string) => void;
  readonly onSelectQuickOption: (option: string) => void;
}): ReactElement {
  const {
    cleanContent,
    isStreaming,
    reacted,
    moreOpen,
    onToggleReaction,
    onQuote,
    onToggleMore,
    onCloseMore,
    onCopy,
    onBranchSideChat,
    onOpenInWorkbench,
    onSelectQuickOption,
  } = props;

  const { cleanBody, options } = extractBotQuickOptions(cleanContent);
  const copyTarget = cleanBody !== "" ? cleanBody : cleanContent;

  return (
    <div className="qj-msg-row qj-sanctuary-msg-bot-row">
      <div className="qj-sanctuary-bubble-bot">
        {cleanBody !== "" && <Markdown content={cleanBody} isStreaming={isStreaming} />}
        {options.length > 0 && (
          <div className="qj-muse-bubble-options" data-testid="bot-bubble-options-group">
            {options.map((opt) => (
              <button
                key={opt}
                type="button"
                className="qj-muse-bubble-option-btn"
                data-testid="bot-bubble-option"
                onClick={() => onSelectQuickOption(opt)}
              >
                {opt}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="qj-msg-actions">
        <button
          type="button"
          className={`qj-msg-action-btn${reacted ? " active" : ""}`}
          title="留下心情"
          onClick={onToggleReaction}
        >
          <Smile size={14.5} />
        </button>
        <button
          type="button"
          className="qj-msg-action-btn"
          title="引用回复"
          onClick={() => onQuote(copyTarget.slice(0, 100))}
        >
          <Reply size={14.5} />
        </button>
        <button
          type="button"
          className="qj-msg-action-btn"
          title="更多操作"
          onClick={onToggleMore}
        >
          <MoreHorizontal size={14.5} />
        </button>

        {moreOpen && (
          <div className="qj-bot-more-popover qj-msg-popover" onMouseLeave={onCloseMore}>
            <button type="button" onClick={() => onCopy(copyTarget)}>
              <span>复制文本</span>
            </button>
            <button
              type="button"
              data-testid="msg-branch-sidechat-btn"
              onClick={() => onBranchSideChat(copyTarget)}
            >
              <span>以此消息开启旁聊</span>
              <GitBranch size={13.5} />
            </button>
            <button type="button" onClick={() => onOpenInWorkbench(copyTarget)}>
              <span>在工作台中打开</span>
              <ArrowUpRight size={13.5} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
