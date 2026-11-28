/**
 * Grok / Muse / `use-stick-to-bottom` grade scroll controller and authoritative
 * model resolver for `BotChatView` (`src/builtin-plugins/bot-mode/useBotChatScroll.ts`).
 *
 * Guarantees:
 * 1. Synchronous pre-paint bottom positioning (`useLayoutEffect`) when a Bot session
 *    hydrates persisted history or switches threads — zero top-of-history flash.
 * 2. Unconditional bottom snap whenever the user submits a message (`notifyUserSent`
 *    or `userMessageCount` increment), even if previously scrolled up.
 * 3. `ResizeObserver` content tracking during streaming, releasing stickiness
 *    immediately on upward wheel / touch / scrollbar drag and exposing a floating
 *    `回到底部` pill state (`showScrollToBottom`).
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { SessionServiceSnapshot } from "@qianji/client";
import type { BotModelConfig } from "@qianji/protocol";

export type BotCatalogModel = SessionServiceSnapshot["availableModels"][number];

const STICKY_BOTTOM_THRESHOLD_PX = 64;
const SHOW_JUMP_BUTTON_THRESHOLD_PX = 140;

export interface ResolvedBotModelChoice {
  readonly provider: string;
  readonly modelId: string;
  readonly label: string;
  readonly modelInfo: BotCatalogModel | null;
}

export function resolvePendingAutoSend(input: {
  readonly pendingPrompt: string | null;
  readonly canAttach: boolean;
  readonly hasHandle: boolean;
  readonly handlePhase: string;
  readonly isStreaming: boolean;
  readonly desiredProvider: string;
  readonly desiredModelId: string;
}): "noop" | "clear" | "send" | "fallback-draft" {
  const {
    pendingPrompt,
    canAttach,
    hasHandle,
    handlePhase,
    isStreaming,
    desiredProvider,
    desiredModelId,
  } = input;
  if (pendingPrompt === null) return "noop";
  if (pendingPrompt.trim() === "") return "clear";
  if (
    hasHandle &&
    handlePhase === "ready" &&
    !isStreaming &&
    desiredProvider !== "" &&
    desiredModelId !== ""
  ) {
    return "send";
  }
  if (
    !canAttach ||
    desiredProvider === "" ||
    desiredModelId === "" ||
    handlePhase === "error" ||
    (handlePhase === "ready" && !hasHandle)
  ) {
    return "fallback-draft";
  }
  return "noop";
}

export function formatBotDividerTimestamp(): string {
  const now = new Date();
  return `${now.getMonth() + 1}月${now.getDate()}日 ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

export function resolveEffectiveBotModel(params: {
  readonly modelConfig: BotModelConfig;
  readonly settingsProvider?: string;
  readonly settingsModel?: string;
  readonly sessionModel?: BotCatalogModel | null;
  readonly availableModels: readonly BotCatalogModel[];
}): ResolvedBotModelChoice {
  const {
    modelConfig,
    settingsProvider = "",
    settingsModel = "",
    sessionModel = null,
    availableModels,
  } = params;

  const findInCatalog = (provider: string, id: string): BotCatalogModel | undefined =>
    availableModels.find((m) => m.provider === provider && m.id === id);

  const primary = modelConfig.primary;
  if (primary !== undefined && primary.provider.trim() !== "" && primary.model.trim() !== "") {
    const matched = findInCatalog(primary.provider, primary.model);
    const info: BotCatalogModel = matched ?? {
      id: primary.model,
      name: primary.model,
      provider: primary.provider,
    };
    return {
      provider: primary.provider,
      modelId: primary.model,
      label: info.name || primary.model,
      modelInfo: info,
    };
  }

  const cleanSettingsProvider = settingsProvider.trim();
  const cleanSettingsModel = settingsModel.trim();
  if (cleanSettingsProvider !== "" && cleanSettingsModel !== "") {
    const matched = findInCatalog(cleanSettingsProvider, cleanSettingsModel);
    const info: BotCatalogModel = matched ?? {
      id: cleanSettingsModel,
      name: cleanSettingsModel,
      provider: cleanSettingsProvider,
    };
    return {
      provider: cleanSettingsProvider,
      modelId: cleanSettingsModel,
      label: info.name || cleanSettingsModel,
      modelInfo: info,
    };
  }

  const fallback = sessionModel ?? availableModels[0] ?? null;
  if (fallback !== null && fallback.provider !== "" && fallback.id !== "") {
    return {
      provider: fallback.provider,
      modelId: fallback.id,
      label: fallback.name || fallback.id,
      modelInfo: fallback,
    };
  }

  return {
    provider: "",
    modelId: "",
    label: "配置模型",
    modelInfo: null,
  };
}

function getDistanceFromBottom(el: HTMLElement): number {
  return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
}

export function useBotChatScroll(params: {
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly contentRef: RefObject<HTMLDivElement | null>;
  readonly sessionKey: string;
  readonly messageCount: number;
  readonly userMessageCount: number;
  readonly lastMessageSignature: string;
  readonly isStreaming: boolean;
}): {
  readonly showScrollToBottom: boolean;
  readonly scrollToBottom: (behavior?: ScrollBehavior) => void;
  readonly notifyUserSent: () => void;
} {
  const {
    scrollRef,
    contentRef,
    sessionKey,
    messageCount,
    userMessageCount,
    lastMessageSignature,
    isStreaming,
  } = params;

  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const stickToBottomRef = useRef(true);
  const hydratedSessionRef = useRef<string | null>(null);
  const trackedSessionRef = useRef(sessionKey);
  const prevUserCountRef = useRef(userMessageCount);
  const programmaticScrollUntilRef = useRef(0);

  const snapInstant = useCallback(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    programmaticScrollUntilRef.current = Date.now() + 80;
    scroller.scrollTop = scroller.scrollHeight;
  }, [scrollRef]);

  // 1. Pre-paint hydration positioning & unconditional snap on new user turn.
  useLayoutEffect(() => {
    const sessionChanged = trackedSessionRef.current !== sessionKey;
    if (sessionChanged) {
      trackedSessionRef.current = sessionKey;
      hydratedSessionRef.current = null;
      stickToBottomRef.current = true;
      prevUserCountRef.current = userMessageCount;
    }

    const needsInitialHydrationSnap =
      hydratedSessionRef.current !== sessionKey && messageCount > 0;
    const userAddedMessage = !sessionChanged && userMessageCount > prevUserCountRef.current;
    prevUserCountRef.current = userMessageCount;

    if (needsInitialHydrationSnap || userAddedMessage) {
      if (needsInitialHydrationSnap) {
        hydratedSessionRef.current = sessionKey;
      }
      stickToBottomRef.current = true;
      snapInstant();
      if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
        const raf = window.requestAnimationFrame(() => {
          if (stickToBottomRef.current) snapInstant();
          setShowScrollToBottom(false);
        });
        return () => window.cancelAnimationFrame(raf);
      }
    }
    return undefined;
  }, [messageCount, scrollRef, sessionKey, snapInstant, userMessageCount]);

  // 2. Follow streaming chunks when sticky.
  useEffect(() => {
    if (!stickToBottomRef.current || messageCount === 0) return undefined;
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      snapInstant();
      return undefined;
    }
    const raf = window.requestAnimationFrame(() => {
      if (stickToBottomRef.current) snapInstant();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [isStreaming, lastMessageSignature, messageCount, snapInstant]);

  // 3. ResizeObserver on stream content + user scroll-up intent detection.
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (scroller === null || typeof window === "undefined") return undefined;

    let lastScrollTop = scroller.scrollTop;

    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < -2) {
        stickToBottomRef.current = false;
      }
    };

    const handleTouchMove = () => {
      if (getDistanceFromBottom(scroller) > STICKY_BOTTOM_THRESHOLD_PX) {
        stickToBottomRef.current = false;
      }
    };

    const handleScroll = () => {
      const currentTop = scroller.scrollTop;
      const dist = getDistanceFromBottom(scroller);
      const isProgrammatic = Date.now() <= programmaticScrollUntilRef.current;

      if (!isProgrammatic && currentTop < lastScrollTop - 4 && dist > STICKY_BOTTOM_THRESHOLD_PX) {
        stickToBottomRef.current = false;
      } else if (dist <= STICKY_BOTTOM_THRESHOLD_PX) {
        stickToBottomRef.current = true;
      }
      lastScrollTop = currentTop;
      setShowScrollToBottom(dist > SHOW_JUMP_BUTTON_THRESHOLD_PX);
    };

    scroller.addEventListener("wheel", handleWheel, { passive: true });
    scroller.addEventListener("touchmove", handleTouchMove, { passive: true });
    scroller.addEventListener("scroll", handleScroll, { passive: true });

    let observer: ResizeObserver | null = null;
    if (content !== null && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        if (stickToBottomRef.current) {
          snapInstant();
        } else {
          setShowScrollToBottom(getDistanceFromBottom(scroller) > SHOW_JUMP_BUTTON_THRESHOLD_PX);
        }
      });
      observer.observe(content);
    }

    return () => {
      scroller.removeEventListener("wheel", handleWheel);
      scroller.removeEventListener("touchmove", handleTouchMove);
      scroller.removeEventListener("scroll", handleScroll);
      observer?.disconnect();
    };
  }, [contentRef, messageCount, scrollRef, sessionKey, snapInstant]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const scroller = scrollRef.current;
      stickToBottomRef.current = true;
      setShowScrollToBottom(false);
      if (scroller === null) return;
      programmaticScrollUntilRef.current = Date.now() + 360;
      if (behavior === "smooth" && typeof scroller.scrollTo === "function") {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
      } else {
        scroller.scrollTop = scroller.scrollHeight;
      }
    },
    [scrollRef],
  );

  const notifyUserSent = useCallback(() => {
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    snapInstant();
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => snapInstant());
    }
  }, [snapInstant]);

  return {
    showScrollToBottom,
    scrollToBottom,
    notifyUserSent,
  };
}
