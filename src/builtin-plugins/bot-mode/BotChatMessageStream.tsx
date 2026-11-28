/**
 * Conversational message stream, embedded task handoff cards, and runtime error banner
 * extracted from `BotChatView` so every module stays well within the 420-line budget.
 */
import type { ReactElement } from "react";
import { ArrowUpRight } from "lucide-react";
import type { BotTaskHandoffPayload } from "@qianji/protocol";
import { CalendarTaskTileIcon } from "./BotAvatarArt";
import { BotChatHeroStage } from "./BotCharacterStage";
import {
  BotAssistantBubbleRow,
  BotHistoryHydratingState,
  BotLiveThinkingRow,
  stripBotThinking,
} from "./BotChatThreadWidgets";
import { BotUserBubbleRow, type BotAttachedImage } from "./BotUserBubble";
import { formatBotDividerTimestamp } from "./useBotChatScroll";

export interface BotChatVisibleMessage {
  readonly id: string;
  readonly role: string;
  readonly content: string;
  readonly model?: string;
  readonly images?: readonly BotAttachedImage[];
  readonly usedSkills?: readonly string[];
}

export function BotChatMessageStream(props: {
  readonly isMain: boolean;
  readonly topTitle: string;
  readonly isHydratingHistory: boolean;
  readonly isEmptyChat: boolean;
  readonly isStreaming: boolean;
  readonly showTrailingThinking: boolean;
  readonly visibleMessages: readonly BotChatVisibleMessage[];
  readonly knownSkills?: ReadonlySet<string>;
  readonly embeddedTasks: readonly BotTaskHandoffPayload[];
  readonly runtimeError: string | null;
  readonly reactedIds: Readonly<Record<string, boolean>>;
  readonly moreMsgId: string | null;
  readonly onToggleReaction: (msgId: string, curReacted: boolean) => void;
  readonly onQuote: (snippet: string) => void;
  readonly onToggleMore: (msgId: string) => void;
  readonly onCloseMore: () => void;
  readonly onCopy: (body: string) => void;
  readonly onBranchSideChat: (body: string) => void;
  readonly onOpenInWorkbench: (msgId: string, body: string) => void;
  readonly onSelectQuickOption: (option: string) => void;
  readonly onTriggerHandoff: (task: BotTaskHandoffPayload) => void;
  readonly onOpenModels: () => void;
}): ReactElement {
  const {
    isMain,
    topTitle,
    isHydratingHistory,
    isEmptyChat,
    isStreaming,
    showTrailingThinking,
    visibleMessages,
    knownSkills,
    embeddedTasks,
    runtimeError,
    reactedIds,
    moreMsgId,
    onToggleReaction,
    onQuote,
    onToggleMore,
    onCloseMore,
    onCopy,
    onBranchSideChat,
    onOpenInWorkbench,
    onSelectQuickOption,
    onTriggerHandoff,
    onOpenModels,
  } = props;

  return (
    <>
      {isHydratingHistory ? (
        <div className="qj-sanctuary-empty-stack">
          <BotHistoryHydratingState />
        </div>
      ) : isEmptyChat ? (
        <div className="qj-sanctuary-empty-stack">
          <BotChatHeroStage
            isMain={isMain}
            topTitle={isMain ? "主聊天" : topTitle}
            isStreaming={isStreaming}
          />
        </div>
      ) : (
        <>
          <div className="qj-muse-date-divider">{formatBotDividerTimestamp()}</div>

          {visibleMessages.map((msg) => {
            if (msg.role === "user") {
              return (
                <BotUserBubbleRow
                  key={msg.id}
                  content={msg.content}
                  images={msg.images}
                  knownSkills={knownSkills}
                  onCopy={onCopy}
                  onQuote={onQuote}
                />
              );
            }
            const cleanContent = stripBotThinking(msg.content);
            if (cleanContent.trim() === "") {
              return <BotLiveThinkingRow key={msg.id} />;
            }
            const reacted = reactedIds[msg.id] === true;
            const replyModel =
              typeof msg.model === "string" && msg.model !== "" && msg.model !== "bot-companion"
                ? msg.model
                : undefined;
            return (
              <BotAssistantBubbleRow
                key={msg.id}
                msgId={msg.id}
                cleanContent={cleanContent}
                replyModel={replyModel}
                usedSkills={msg.usedSkills}
                isStreaming={isStreaming}
                reacted={reacted}
                moreOpen={moreMsgId === msg.id}
                onToggleReaction={() => onToggleReaction(msg.id, reacted)}
                onQuote={onQuote}
                onToggleMore={() => onToggleMore(msg.id)}
                onCloseMore={onCloseMore}
                onCopy={onCopy}
                onBranchSideChat={onBranchSideChat}
                onOpenInWorkbench={(body) => onOpenInWorkbench(msg.id, body)}
                onSelectQuickOption={onSelectQuickOption}
              />
            );
          })}

          {showTrailingThinking && <BotLiveThinkingRow />}
        </>
      )}

      {isMain &&
        embeddedTasks.map((task) => (
          <div key={task.id} className="qj-msg-row qj-sanctuary-msg-bot-row" data-testid="bot-handoff-card">
            <div className="qj-sanctuary-handoff-card">
              <div className="qj-sanctuary-handoff-head">
                <CalendarTaskTileIcon />
                <div className="qj-sanctuary-handoff-titles">
                  <div className="qj-sanctuary-handoff-title">{task.title}</div>
                  <div className="qj-sanctuary-handoff-kind">{task.kindLabel}</div>
                </div>
              </div>
              <p className="qj-sanctuary-handoff-summary">{task.summary}</p>
              <button
                type="button"
                className="qj-sanctuary-handoff-btn"
                onClick={() => onTriggerHandoff(task)}
              >
                <span>在 Agent 工作台中打开</span>
                <ArrowUpRight size={14} />
              </button>
            </div>
          </div>
        ))}

      {runtimeError && (
        <div className="qj-sanctuary-error-card">
          <span>{runtimeError}</span>
          <button
            type="button"
            className="qj-primary-pill-btn qj-sanctuary-error-btn"
            onClick={onOpenModels}
          >
            配置模型服务
          </button>
        </div>
      )}
    </>
  );
}
