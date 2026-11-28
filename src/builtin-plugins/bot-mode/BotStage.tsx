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
import { BotComputerStudioPane } from "./computer-studio/BotComputerStudioPane";
import {
  clampStudioWidth,
  closeComputerStudio,
  MAX_STUDIO_WIDTH,
  MIN_STUDIO_WIDTH,
  patchComputerStudioUi,
  useComputerStudioUi,
} from "./computer-studio/computerStudioStore";
import { useComputerStudioRuntimeSync } from "./computer-studio/useComputerStudio";

export function BotStage(
  props: SlotComponentProps<{ readonly active?: boolean; readonly cwd?: string }, "root">,
): ReactElement {
  const { ctx, cwd = "", renderFactory } = props;
  const ui = useBotUiState();
  const studioUi = useComputerStudioUi();
  const navState = useNavigationState(ctx);
  useBotController(ctx);
  useComputerStudioRuntimeSync(ctx);
  const [draggingSplit, setDraggingSplit] = useState(false);
  const [draggingStudio, setDraggingStudio] = useState(false);
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

  const handleStudioResizerPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = studioUi.studioWidth;
    setDraggingStudio(true);

    const onMove = (moveEvent: PointerEvent) => {
      const next = clampStudioWidth(startWidth - (moveEvent.clientX - startX));
      patchComputerStudioUi({ studioWidth: next });
    };
    const onEnd = () => {
      setDraggingStudio(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  const handleStudioResizerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      patchComputerStudioUi({ studioWidth: clampStudioWidth(studioUi.studioWidth + 20) });
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      patchComputerStudioUi({ studioWidth: clampStudioWidth(studioUi.studioWidth - 20) });
    }
  };

  // Strict 3-Column Layout: when `studioOpen` is true, `#bot-right-wrap`
  // renders `BotComputerStudioPane` IN PLACE OF `BotCompanionPanel` (never 4 columns!).
  const showStudioInRight = studioUi.studioOpen;
  const showCompanionInRight = !showStudioInRight && ui.rightPanelOpen && ui.activeView === "chat";
  const showRight = showStudioInRight || showCompanionInRight;
  const isDiscoveryView =
    ui.activeView === "feed" || ui.activeView === "ideas" || ui.activeView === "goals";
  const showSplitChat = isDiscoveryView && ui.splitChatOpen === true;

  return (
    <section
      id="pane-bot"
      className="qj-bot-stage"
      data-right-closed={showRight ? "false" : "true"}
      data-studio-open={showStudioInRight ? "true" : "false"}
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

        <div
          id="bot-right-wrap"
          className={[
            "qj-bot-right-wrap",
            showRight ? "" : "closed",
            showStudioInRight ? "is-computer-studio" : "",
          ].filter(Boolean).join(" ")}
          style={
            showStudioInRight
              ? { width: `${studioUi.studioWidth}px`, flexBasis: `${studioUi.studioWidth}px` }
              : undefined
          }
        >
          {showStudioInRight ? (
            <>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="调整电脑面板宽度"
                aria-valuemin={MIN_STUDIO_WIDTH}
                aria-valuemax={MAX_STUDIO_WIDTH}
                aria-valuenow={studioUi.studioWidth}
                tabIndex={0}
                data-testid="bot-computer-studio-resizer"
                className={`qj-cs-left-resizer${draggingStudio ? " is-dragging" : ""}`}
                onPointerDown={handleStudioResizerPointerDown}
                onKeyDown={handleStudioResizerKeyDown}
              />
              <BotComputerStudioPane
                ctx={ctx}
                onClose={() => {
                  closeComputerStudio();
                  patchBotUi({ rightPanelOpen: true });
                }}
              />
            </>
          ) : (
            <BotCompanionPanel ctx={ctx} />
          )}
        </div>
      </div>

      <BotModals ctx={ctx} renderFactory={renderFactory} />
    </section>
  );
}
