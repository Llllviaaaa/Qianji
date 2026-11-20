/**
 * Core conversation stage (`shell.stage`) and reusable multi-session
 * `<SessionConversationSurface>` component (ADR 0023 `core-conversation`).
 */
import { useCallback, useEffect, useMemo, useRef, type ReactNode, type UIEvent } from "react";
import {
  useFrontendService,
  useNavigationState,
  useSessionHandle,
  useSessionState,
  useThemeState,
  useWorkspaceState,
} from "@qianji/client";
import {
  SessionArea,
  SlotHost,
  useSlotScope,
  type CoreShellStageProps,
  type SlotComponentProps,
} from "@qianji/client-slots";

function useConversationAutoFollow(
  scrollRef: { readonly current: HTMLDivElement | null },
  sessionKey: string,
  messages: readonly unknown[],
  isStreaming: boolean,
): (event: UIEvent<HTMLDivElement>) => void {
  const autoFollowRef = useRef(true);
  const lastAutoScrollAtRef = useRef(0);
  const trackedSessionRef = useRef(sessionKey);

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const scroller = event.currentTarget;
    autoFollowRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  }, []);

  useEffect(() => {
    if (trackedSessionRef.current !== sessionKey) {
      trackedSessionRef.current = sessionKey;
      autoFollowRef.current = true;
    }
    if (!autoFollowRef.current) return;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (isStreaming && now - lastAutoScrollAtRef.current < 80) return;
    lastAutoScrollAtRef.current = now;
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") return;
    const frame = window.requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      if (scroller !== null) {
        scroller.scrollTop = scroller.scrollHeight;
      }
    });
    return () => {
      if (typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [isStreaming, messages, scrollRef, sessionKey]);

  return handleScroll;
}

export function CoreConversationStage({
  cwd: ownerCwd,
  sessionFile: ownerSessionFile,
  sessionId,
  renderSlot,
  renderSlotChain,
}: SlotComponentProps<CoreShellStageProps, "session-maybe">): ReactNode {
  const sessionState = useSessionState();
  const workspaceState = useWorkspaceState();
  const navigationState = useNavigationState();
  const navigationService = useFrontendService("navigationService");
  const themeState = useThemeState();
  const scrollRef = useRef<HTMLDivElement>(null);

  const resolvedCwd = ownerCwd ?? sessionState?.cwd ?? workspaceState?.cwd ?? "";
  const resolvedSessionFile =
    ownerSessionFile !== undefined ? ownerSessionFile : (sessionState?.sessionFile ?? null);
  const activeSessionId =
    (sessionId !== null && sessionId !== "" ? sessionId : null) ??
    (sessionState?.sessionId !== null && sessionState?.sessionId !== "" ? sessionState?.sessionId : null) ??
    (resolvedSessionFile !== null && resolvedSessionFile !== "" ? resolvedSessionFile : null) ??
    "active";
  const density = themeState?.transcriptDensity ?? "normal";
  const extensionWidgets = navigationState?.extensionWidgets ?? {};
  const extensionRequest = navigationState?.extensionRequest ?? null;
  const messages = sessionState?.messages ?? [];
  const isStreaming = sessionState?.isStreaming ?? false;

  const handleScroll = useConversationAutoFollow(
    scrollRef,
    `${activeSessionId}:${resolvedSessionFile ?? "new"}`,
    messages,
    isStreaming,
  );

  const handleAnswerExtension = useCallback(
    (_requestId: string, response: unknown) => {
      if (navigationService === undefined) return;
      const payload =
        typeof response === "object" && response !== null
          ? (response as { value?: string; confirmed?: boolean; cancelled?: true })
          : { value: String(response ?? "") };
      void navigationService.answerExtension(payload);
    },
    [navigationService],
  );

  return (
    <SessionArea sessionId={activeSessionId}>
      <div
        className="core-conversation-stage"
        data-slot="shell.stage"
        data-session-id={activeSessionId}
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          position: "relative",
        }}
      >
        {renderSlot("conversation.header", {
          cwd: resolvedCwd,
          sessionFile: resolvedSessionFile,
        })}

        <div ref={scrollRef} className="conversation-scroll" onScroll={handleScroll}>
          <div className={`conversation density-${density}`}>
            {renderSlot("conversation.transcript", {
              cwd: resolvedCwd,
              sessionFile: resolvedSessionFile,
            })}

            {Object.entries(extensionWidgets)
              .filter(([key]) => key !== "qianji-plan" && key !== "pidesktop-plan")
              .map(([key, lines]) => (
                <div className="extension-widget" key={key}>
                  {lines.map((line, idx) => (
                    <div key={idx}>{line}</div>
                  ))}
                </div>
              ))}

            {extensionRequest !== null &&
              renderSlotChain("conversation.approvalDialog", {
                cwd: resolvedCwd,
                sessionFile: resolvedSessionFile,
                request: extensionRequest,
                onAnswer: handleAnswerExtension,
              })}
          </div>
        </div>

        {renderSlot("conversation.composerDock", {
          cwd: resolvedCwd,
          sessionFile: resolvedSessionFile,
          variant: "follow-up",
        })}
      </div>
    </SessionArea>
  );
}

export interface SessionConversationSurfaceProps {
  readonly sessionId?: string | null;
  readonly cwd?: string;
  readonly sessionFile?: string | null;
  readonly compact?: boolean;
  readonly isolated?: boolean;
  readonly variant?: "task-start" | "follow-up";
  readonly showHeader?: boolean;
  readonly showComposerDock?: boolean;
  readonly className?: string;
}

export function SessionConversationSurface({
  sessionId,
  cwd,
  sessionFile = null,
  compact = false,
  isolated = true,
  variant = "follow-up",
  showHeader = false,
  showComposerDock = true,
  className,
}: SessionConversationSurfaceProps): ReactNode {
  const inheritedScope = useSlotScope();
  const sessionState = useSessionState();
  const themeState = useThemeState();
  const scrollRef = useRef<HTMLDivElement>(null);
  const density = themeState?.transcriptDensity ?? "normal";
  const resolvedSessionId =
    sessionId !== undefined && sessionId !== null && sessionId !== ""
      ? sessionId
      : inheritedScope.sessionId;
  const isolatedHandleOptions = useMemo(
    () => (isolated ? { isolated: true, ...(cwd === undefined ? {} : { cwd }) } : undefined),
    [isolated, cwd],
  );
  const { snapshot: isolatedSnap } = useSessionHandle(
    isolated ? resolvedSessionId : null,
    isolatedHandleOptions,
  );
  const surfaceMessages = isolated
    ? (isolatedSnap?.messages ?? [])
    : (sessionState?.messages ?? []);
  const surfaceStreaming = isolated
    ? (isolatedSnap?.isStreaming ?? false)
    : (sessionState?.isStreaming ?? false);
  const handleScroll = useConversationAutoFollow(
    scrollRef,
    `${resolvedSessionId ?? "surface"}:${sessionFile ?? "new"}`,
    surfaceMessages,
    surfaceStreaming,
  );

  return (
    <SessionArea sessionId={resolvedSessionId}>
      <div
        className={`session-conversation-surface${className !== undefined && className !== "" ? ` ${className}` : ""}`}
        data-session-surface={resolvedSessionId ?? undefined}
      >
        {showHeader && (
          <SlotHost
            slotKey="conversation.header"
            kind="list"
            scope="session"
            props={{ cwd, sessionFile }}
          />
        )}
        <div ref={scrollRef} className="conversation-scroll" onScroll={handleScroll}>
          <div className={`conversation density-${density}`}>
            <SlotHost
              slotKey="conversation.transcript"
              kind="single"
              scope="session"
              props={{
                cwd,
                sessionFile,
                compact,
                ...(isolated && isolatedSnap !== null
                  ? {
                      messages: isolatedSnap.messages,
                      isStreaming: isolatedSnap.isStreaming,
                      isCompacting: isolatedSnap.isCompacting,
                      retryStatus: isolatedSnap.retryStatus,
                    }
                  : {}),
              }}
            />
          </div>
        </div>
        {showComposerDock && (
          <SlotHost
            slotKey="conversation.composerDock"
            kind="single"
            scope="session-maybe"
            props={{ cwd, sessionFile, variant, isolated }}
          />
        )}
      </div>
    </SessionArea>
  );
}
