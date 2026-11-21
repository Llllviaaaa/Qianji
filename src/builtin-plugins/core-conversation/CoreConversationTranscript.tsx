/**
 * Built-in `conversation.turn` and `conversation.transcript` slot components
 * (ADR 0023 `core-conversation`).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  isLastUserTurn = isLastTurn,
  sessionId,
  renderSlot,
  renderSlotChain,
}: SlotComponentProps<ConversationTurnSlotProps, "session">): ReactNode {
  const sessionService = useFrontendService("sessionService");
  const composerService = useFrontendService("composerService");
  const navigationService = useFrontendService("navigationService");
  const { handle } = useSessionHandle(sessionId);
  const canRewind = composerService?.hasRewindHandler() === true;

  const handleRewind = useCallback(
    (message: UiMessage) => {
      if (isStreaming) {
        navigationService?.showToast("请等待当前回复完成后再回退消息", "warning");
        return;
      }
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
    [composerService, handle, isStreaming, navigationService, sessionService],
  );

  const handleEditAndResend = useCallback(
    (entryId: string, text: string) => {
      if (isStreaming) {
        navigationService?.showToast("请等待当前回复完成后再编辑消息", "warning");
        return;
      }
      if (handle !== null) {
        void handle.editAndResend(entryId, text);
      } else {
        void sessionService?.editAndResend(entryId, text);
      }
    },
    [handle, isStreaming, navigationService, sessionService],
  );

  let lastAssistantIdx = -1;
  for (let i = assistantMessages.length - 1; i >= 0; i -= 1) {
    if (assistantMessages[i]?.role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  const lastAssistant = lastAssistantIdx >= 0 ? assistantMessages[lastAssistantIdx] : undefined;
  const footerMessage = lastAssistant ?? userMessage;
  const turnFooterNode =
    isLastTurn && !isStreaming && footerMessage !== undefined
      ? renderSlot("conversation.turnFooter", {
          cwd,
          sessionFile,
          message: footerMessage,
          ...(footerMessage.durationMs === undefined ? {} : { durationMs: footerMessage.durationMs }),
        })
      : undefined;

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
          isLastUserTurn,
          ...(canRewind ? { onRewind: handleRewind } : {}),
          onEditAndResend: handleEditAndResend,
        })}

      {assistantMessages.map((msg, idx) => (
        <div key={msg.id} style={{ display: "contents" }}>
          {renderSlotChain("conversation.message", {
            cwd,
            sessionFile,
            message: msg,
            isStreaming: isStreaming && isLastTurn && idx === lastAssistantIdx,
            isLast: isLastTurn && idx === lastAssistantIdx,
            ...(userMessage === undefined ? {} : { turnStartedAt: userMessage.timestamp }),
            ...(idx === lastAssistantIdx && turnFooterNode !== undefined ? { footer: turnFooterNode } : {}),
          })}
        </div>
      ))}

      {lastAssistantIdx < 0 && turnFooterNode !== undefined && (
        <div className="dshc-turn-footer">{turnFooterNode}</div>
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
  const rootRef = useRef<HTMLDivElement>(null);
  const landedTimerRef = useRef<number | null>(null);

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
  const lastUserTurnId = userTurns[userTurns.length - 1]?.userMessage?.id ?? null;
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [turnNavOpen, setTurnNavOpen] = useState(false);

  // Track which user turn is currently in view for the turn rail.
  useEffect(() => {
    if (compact || typeof window === "undefined" || typeof document === "undefined") return;
    const scroller = rootRef.current?.closest?.(".conversation-scroll");
    if (scroller == null || userTurns.length === 0) return;

    let rafId: number | null = null;
    const updateCurrentTurn = () => {
      rafId = null;
      if (typeof scroller.getBoundingClientRect !== "function") return;
      const scrollerRect = scroller.getBoundingClientRect();
      const threshold = scrollerRect.top + scrollerRect.height * 0.35;
      let current = userTurns[0]?.userMessage?.id ?? null;
      for (const turn of userTurns) {
        const userId = turn.userMessage?.id;
        if (userId === undefined) continue;
        const el = document.getElementById(`message-${userId}`);
        if (el === null || typeof el.getBoundingClientRect !== "function") continue;
        const rect = el.getBoundingClientRect();
        if (rect.top <= threshold) current = userId;
        else break;
      }
      setActiveTurnId((prev) => (prev === current ? prev : current));
    };
    const scheduleUpdate = () => {
      if (rafId !== null || typeof window.requestAnimationFrame !== "function") return;
      rafId = window.requestAnimationFrame(updateCurrentTurn);
    };
    scheduleUpdate();
    scroller.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      if (rafId !== null && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(rafId);
      }
      scroller.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [compact, userTurns]);

  const jumpToTurn = useCallback((turnId: string) => {
    if (typeof document === "undefined") return;
    const el = document.getElementById(`message-${turnId}`);
    if (el === null) return;
    if (typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    setActiveTurnId(turnId);
    setTurnNavOpen(false);
    if (typeof document.querySelectorAll === "function") {
      document.querySelectorAll("[data-dsh-claude-turn-nav-landed]").forEach((node) => {
        node.removeAttribute("data-dsh-claude-turn-nav-landed");
      });
    }
    el.setAttribute("data-dsh-claude-turn-nav-landed", "");
    if (typeof window !== "undefined") {
      if (landedTimerRef.current !== null) window.clearTimeout(landedTimerRef.current);
      landedTimerRef.current = window.setTimeout(() => {
        el.removeAttribute("data-dsh-claude-turn-nav-landed");
        landedTimerRef.current = null;
      }, 1450);
    }
  }, []);

  useEffect(
    () => () => {
      if (landedTimerRef.current !== null && typeof window !== "undefined") {
        window.clearTimeout(landedTimerRef.current);
      }
    },
    [],
  );

  // Alt+Up / Alt+Down turn navigation
  useEffect(() => {
    if (compact || typeof window === "undefined" || typeof document === "undefined" || userTurns.length < 2) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const activeEl = document.activeElement;
      if (activeEl instanceof HTMLTextAreaElement || activeEl instanceof HTMLInputElement) {
        if (activeEl.value.trim().length > 0) return;
      }
      event.preventDefault();
      const currentIndex = userTurns.findIndex((turn) => turn.userMessage?.id === activeTurnId);
      const baseIndex = currentIndex >= 0 ? currentIndex : userTurns.length - 1;
      const nextIndex =
        event.key === "ArrowUp"
          ? Math.max(0, baseIndex - 1)
          : Math.min(userTurns.length - 1, baseIndex + 1);
      const targetId = userTurns[nextIndex]?.userMessage?.id;
      if (targetId !== undefined) jumpToTurn(targetId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTurnId, compact, jumpToTurn, userTurns]);

  const revealEarlier = () => {
    const scroller = rootRef.current?.closest?.(".conversation-scroll") ?? null;
    const previousHeight = scroller?.scrollHeight ?? 0;
    setVisibleCount((count) => count + INITIAL_VISIBLE_TURNS);
    if (scroller !== null && typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => {
        scroller.scrollTop += scroller.scrollHeight - previousHeight;
      });
    }
  };

  return (
    <div
      ref={rootRef}
      className={`conversation-transcript${compact ? " is-compact" : ""}`}
      data-slot="conversation.transcript"
      data-session-id={sessionId}
      data-density={density}
    >
      {firstVisibleTurnIndex > 0 && (
        <button
          type="button"
          className="load-earlier-messages"
          onClick={revealEarlier}
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
            isLastUserTurn:
              turn.userMessage !== undefined && turn.userMessage.id === lastUserTurnId,
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
              const isCurrent = (activeTurnId ?? lastUserTurnId) === userMsg.id;
              return (
                <button
                  key={userMsg.id}
                  type="button"
                  className="dsh-claude-turn-rail-mark"
                  data-current={isCurrent || undefined}
                  title={`第 ${index + 1} 轮：${singleLineExcerpt(userMsg.content, 60)}`}
                  aria-label={`跳到第 ${index + 1} 轮`}
                  onClick={() => jumpToTurn(userMsg.id)}
                />
              );
            })}
          </div>
          {turnNavOpen && (
            <div className="dsh-claude-turn-nav dsh-claude-popover-card" data-open="true" role="menu">
              <div className="dsh-claude-turn-nav-list">
                {userTurns.map((turn) => {
                  const userMsg = turn.userMessage;
                  if (userMsg === undefined) return null;
                  const isCurrent = (activeTurnId ?? lastUserTurnId) === userMsg.id;
                  return (
                    <button
                      key={userMsg.id}
                      type="button"
                      role="menuitem"
                      className="dsh-claude-turn-nav-row"
                      data-current={isCurrent || undefined}
                      onClick={() => jumpToTurn(userMsg.id)}
                    >
                      <span className="dsh-claude-turn-nav-text">
                        {singleLineExcerpt(userMsg.content)}
                      </span>
                      <span className="dsh-claude-turn-nav-dash" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </nav>
      )}
    </div>
  );
}
