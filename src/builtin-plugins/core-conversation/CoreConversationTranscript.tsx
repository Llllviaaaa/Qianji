/**
 * Built-in `conversation.turn` and `conversation.transcript` slot components
 * (ADR 0023 `core-conversation`).
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ChevronUp } from "lucide-react";
import {
  useFrontendService,
  useSessionHandle,
  useSessionState,
  useThemeState,
  useWorkspaceState,
  type UiMessage,
} from "@qianji/client";
import type {
  ConversationTranscriptSlotProps,
  ConversationTurnSlotProps,
  SlotComponentProps,
} from "@qianji/client-slots";
import { groupMessagesIntoTurns, singleLineExcerpt } from "./conversationHelpers";

const EMPTY_MESSAGES: readonly UiMessage[] = [];
const INITIAL_VISIBLE_TURNS = 80;

export function CoreConversationTurn({
  cwd,
  sessionFile,
  turnIndex,
  userMessage,
  assistantMessages,
  isStreaming,
  isLastTurn,
  sessionId,
  renderSlot,
  renderSlotChain,
}: SlotComponentProps<ConversationTurnSlotProps, "session">): ReactNode {
  const sessionService = useFrontendService("sessionService");
  const composerService = useFrontendService("composerService");
  const { handle } = useSessionHandle(sessionId);

  const handleRewind = useCallback(
    (message: UiMessage) => {
      if (composerService !== undefined && composerService.hasRewindHandler()) {
        void composerService.tryHandleRewind(message);
        return;
      }
      if (message.entryId === undefined) return;
      if (handle !== null) {
        void handle.rewind(message.entryId);
      } else {
        void sessionService?.rewind(message.entryId);
      }
    },
    [composerService, handle, sessionService],
  );

  const handleEditAndResend = useCallback(
    (entryId: string, text: string) => {
      if (handle !== null) {
        void handle.editAndResend(entryId, text);
      } else {
        void sessionService?.editAndResend(entryId, text);
      }
    },
    [handle, sessionService],
  );

  const lastAssistant = assistantMessages[assistantMessages.length - 1];
  const footerMessage = lastAssistant ?? userMessage;

  return (
    <div
      className="conversation-turn"
      data-slot="conversation.turn"
      data-turn-index={turnIndex}
      data-session-id={sessionId}
    >
      {userMessage !== undefined &&
        renderSlotChain("conversation.message", {
          cwd,
          sessionFile,
          message: userMessage,
          isStreaming: false,
          isLast: isLastTurn && assistantMessages.length === 0,
          onRewind: handleRewind,
          onEditAndResend: handleEditAndResend,
        })}

      {assistantMessages.map((msg, idx) => (
        <div key={msg.id} style={{ display: "contents" }}>
          {renderSlotChain("conversation.message", {
            cwd,
            sessionFile,
            message: msg,
            isStreaming: isStreaming && isLastTurn && idx === assistantMessages.length - 1,
            isLast: isLastTurn && idx === assistantMessages.length - 1,
          })}
        </div>
      ))}

      {isLastTurn && !isStreaming && footerMessage !== undefined && (
        <div className="dshc-turn-footer">
          {renderSlot("conversation.turnFooter", {
            cwd,
            sessionFile,
            message: footerMessage,
            ...(footerMessage.durationMs === undefined ? {} : { durationMs: footerMessage.durationMs }),
          })}
        </div>
      )}
    </div>
  );
}

export function CoreConversationTranscript({
  cwd: ownerCwd,
  sessionFile: ownerSessionFile,
  messages: ownerMessages,
  isStreaming: ownerStreaming,
  isCompacting: ownerCompacting,
  retryStatus: ownerRetryStatus,
  compact = false,
  sessionId,
  renderSlotChain,
}: SlotComponentProps<ConversationTranscriptSlotProps, "session">): ReactNode {
  const sessionState = useSessionState();
  const workspaceState = useWorkspaceState();
  const themeState = useThemeState();
  const { snapshot: handleSnap } = useSessionHandle(sessionId);

  const matchesActiveMain =
    sessionState !== undefined &&
    (sessionId === "active" ||
      sessionId === sessionState.sessionId ||
      sessionId === sessionState.sessionFile);

  const messages =
    ownerMessages ??
    (handleSnap !== null
      ? handleSnap.messages
      : matchesActiveMain
        ? sessionState.messages
        : EMPTY_MESSAGES);
  const isStreaming =
    ownerStreaming ??
    (handleSnap !== null
      ? handleSnap.isStreaming
      : matchesActiveMain
        ? sessionState.isStreaming
        : false);
  const isCompacting =
    ownerCompacting ??
    (handleSnap !== null
      ? handleSnap.isCompacting
      : matchesActiveMain
        ? sessionState.isCompacting
        : false);
  const retryStatus =
    ownerRetryStatus !== undefined
      ? ownerRetryStatus
      : handleSnap !== null
        ? handleSnap.retryStatus
        : matchesActiveMain
          ? sessionState.retryStatus
          : null;

  const resolvedCwd = ownerCwd ?? handleSnap?.cwd ?? sessionState?.cwd ?? workspaceState?.cwd ?? "";
  const resolvedSessionFile =
    ownerSessionFile !== undefined
      ? ownerSessionFile
      : handleSnap !== null
        ? handleSnap.sessionFile
        : matchesActiveMain
          ? sessionState.sessionFile
          : null;
  const density = themeState?.transcriptDensity ?? "normal";

  const turns = useMemo(() => groupMessagesIntoTurns(messages), [messages]);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_TURNS);
  const [pagedSessionId, setPagedSessionId] = useState(sessionId);
  if (pagedSessionId !== sessionId) {
    setPagedSessionId(sessionId);
    setVisibleCount(INITIAL_VISIBLE_TURNS);
  }

  const firstVisibleTurnIndex = Math.max(0, turns.length - visibleCount);
  const visibleTurns = useMemo(() => turns.slice(firstVisibleTurnIndex), [turns, firstVisibleTurnIndex]);
  const userTurns = useMemo(
    () => visibleTurns.filter((turn) => turn.userMessage !== undefined),
    [visibleTurns],
  );
  const [turnNavOpen, setTurnNavOpen] = useState(false);

  return (
    <div
      className={`conversation-transcript${compact ? " is-compact" : ""}`}
      data-slot="conversation.transcript"
      data-session-id={sessionId}
      data-density={density}
    >
      {firstVisibleTurnIndex > 0 && (
        <button
          type="button"
          className="load-earlier-messages"
          onClick={() => setVisibleCount((count) => count + INITIAL_VISIBLE_TURNS)}
        >
          <ChevronUp size={14} strokeWidth={1.8} />
          更早的 {Math.min(INITIAL_VISIBLE_TURNS, firstVisibleTurnIndex)} 轮对话
        </button>
      )}

      {visibleTurns.map((turn) => (
        <div key={turn.key} style={{ display: "contents" }}>
          {renderSlotChain("conversation.turn", {
            cwd: resolvedCwd,
            sessionFile: resolvedSessionFile,
            turnIndex: turn.turnIndex,
            ...(turn.userMessage === undefined ? {} : { userMessage: turn.userMessage }),
            assistantMessages: turn.assistantMessages,
            isStreaming,
            isLastTurn: turn.isLastTurn,
          })}
        </div>
      ))}

      {isCompacting && (
        <div className="dshc-flow compaction-divider is-compaction" role="status">
          <span>正在压缩上下文…</span>
        </div>
      )}

      {retryStatus !== null && retryStatus !== "" && (
        <div className="dshc-flow message-row notice-message" role="status">
          <span>{retryStatus}</span>
        </div>
      )}

      {!compact && userTurns.length > 1 && (
        <nav
          className="dsh-claude-turn-rail"
          aria-label="对话轮次导航"
          data-open={turnNavOpen || undefined}
          onMouseEnter={() => setTurnNavOpen(true)}
          onMouseLeave={() => setTurnNavOpen(false)}
        >
          <div className="dsh-claude-turn-rail-track" aria-hidden={turnNavOpen}>
            {userTurns.map((turn, index) => {
              const userMsg = turn.userMessage;
              if (userMsg === undefined) return null;
              return (
                <button
                  key={userMsg.id}
                  type="button"
                  className="dsh-claude-turn-rail-mark"
                  title={`第 ${index + 1} 轮：${singleLineExcerpt(userMsg.content, 60)}`}
                  aria-label={`跳到第 ${index + 1} 轮`}
                  onClick={() => {
                    if (typeof document !== "undefined") {
                      document.getElementById(`message-${userMsg.id}`)?.scrollIntoView({ behavior: "smooth" });
                    }
                  }}
                />
              );
            })}
          </div>
        </nav>
      )}
    </div>
  );
}
