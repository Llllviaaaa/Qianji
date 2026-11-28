import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { useNavigationState } from "@qianji/client";
import type { SlotComponentProps } from "@qianji/client-slots";
import { applyStageGazeMove } from "./BotCharacterRig";
import { BotChatColumn } from "./BotChatView";
import { BotCompanionPanel } from "./BotCompanionPanel";
import { BotCreateSpaceView } from "./BotCreateSpaceView";
import { BotFeedView, BotGoalsView, BotIdeasView } from "./BotDiscoveryViews";
import { BotLibraryView } from "./BotLibraryAndSpaces";
import { BotModals } from "./BotModals";
import {
  botUiStore,
  clampSplitChatWidth,
  MAX_SPLIT_CHAT_WIDTH,
  MIN_SPLIT_CHAT_WIDTH,
  openBotModal,
  patchBotUi,
  useBotController,
  useBotUiState,
} from "./botStore";

export function BotStage(
  props: SlotComponentProps<{ readonly active?: boolean; readonly cwd?: string }, "root">,
): ReactElement {
  const { ctx, cwd = "", renderFactory } = props;
  const ui = useBotUiState();
  const navState = useNavigationState(ctx);
  useBotController(ctx);
  const [draggingSplit, setDraggingSplit] = useState(false);
  const prevHostSettingsOpenRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onOpenSettings = (event: Event) => {
      event.preventDefault();
      const cur = botUiStore.get();
      openBotModal("settings", cur.settingsTab || "general");
    };
    window.addEventListener("qianji:bot-open-settings", onOpenSettings);
    return () => window.removeEventListener("qianji:bot-open-settings", onOpenSettings);
  }, []);

  useEffect(() => {
    const isOpen = navState?.settingsOpen === true;
    if (prevHostSettingsOpenRef.current && !isOpen && botUiStore.get().suspendedForHostSettings) {
      patchBotUi({ modal: "settings", suspendedForHostSettings: false });
    }
    prevHostSettingsOpenRef.current = isOpen;
  }, [navState?.settingsOpen]);

  const handleResizerPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = ui.splitChatWidth;
    setDraggingSplit(true);

    const onMove = (moveEvent: PointerEvent) => {
      const next = clampSplitChatWidth(startWidth + (moveEvent.clientX - startX));
      patchBotUi({ splitChatWidth: next });
    };
    const onEnd = () => {
      setDraggingSplit(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  const handleResizerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      patchBotUi({ splitChatWidth: clampSplitChatWidth(ui.splitChatWidth - 16) });
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      patchBotUi({ splitChatWidth: clampSplitChatWidth(ui.splitChatWidth + 16) });
    }
  };

  const showRight = ui.rightPanelOpen && ui.activeView === "chat";
  const isDiscoveryView =
    ui.activeView === "feed" || ui.activeView === "ideas" || ui.activeView === "goals";
  const showSplitChat = isDiscoveryView && ui.splitChatOpen === true;

  return (
    <section
      id="pane-bot"
      className="qj-bot-stage"
      data-right-closed={showRight ? "false" : "true"}
      data-bot-view={ui.activeView}
      data-testid="bot-stage"
      onPointerMove={(event) => applyStageGazeMove(event.clientX, event.clientY, event.currentTarget)}
    >
      <div className="qj-bot-workspace-frame">
        <div id="bot-center-wrap" className="qj-bot-center-wrap">
          {showSplitChat && (
            <>
              <div
                className="qj-bot-split-chat-pane"
                style={{ width: `${ui.splitChatWidth}px`, flexBasis: `${ui.splitChatWidth}px` }}
                data-testid="bot-split-chat-pane"
              >
                <BotChatColumn ctx={ctx} cwd={cwd} compactSplit />
              </div>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="调整面板大小"
                aria-valuemin={MIN_SPLIT_CHAT_WIDTH}
                aria-valuemax={MAX_SPLIT_CHAT_WIDTH}
                aria-valuenow={ui.splitChatWidth}
                tabIndex={0}
                data-testid="bot-split-resizer"
                className={`qj-bot-split-resizer${draggingSplit ? " is-dragging" : ""}`}
                onPointerDown={handleResizerPointerDown}
                onKeyDown={handleResizerKeyDown}
              />
            </>
          )}
          {ui.activeView === "chat" && <BotChatColumn ctx={ctx} cwd={cwd} />}
          {ui.activeView === "feed" && <BotFeedView ctx={ctx} />}
          {ui.activeView === "ideas" && <BotIdeasView ctx={ctx} />}
          {ui.activeView === "goals" && <BotGoalsView ctx={ctx} />}
          {ui.activeView === "library" && <BotLibraryView ctx={ctx} />}
          {ui.activeView === "spaces" && <BotCreateSpaceView ctx={ctx} cwd={cwd} />}
        </div>

        <div id="bot-right-wrap" className={`qj-bot-right-wrap${showRight ? "" : " closed"}`}>
          <BotCompanionPanel ctx={ctx} />
        </div>
      </div>

      <BotModals ctx={ctx} renderFactory={renderFactory} />
    </section>
  );
}
