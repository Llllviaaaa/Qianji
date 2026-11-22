import { useEffect, type ReactElement } from "react";
import type { SlotComponentProps } from "@qianji/client-slots";
import { BotChatColumn, BotSideChatDrawer } from "./BotChatView";
import { BotCompanionPanel } from "./BotCompanionPanel";
import { BotFeedView, BotGoalsView, BotIdeasView } from "./BotDiscoveryViews";
import { BotLibraryView, BotSpacesCanvas } from "./BotLibraryAndSpaces";
import { BotModals } from "./BotModals";
import { openBotModal, useBotController, useBotUiState } from "./botStore";

export function BotStage(
  props: SlotComponentProps<{ readonly active?: boolean; readonly cwd?: string }, "root">,
): ReactElement {
  const { ctx, cwd = "" } = props;
  const ui = useBotUiState();
  useBotController(ctx);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onOpenSettings = (event: Event) => {
      event.preventDefault();
      openBotModal("settings", "general");
    };
    window.addEventListener("qianji:bot-open-settings", onOpenSettings);
    return () => window.removeEventListener("qianji:bot-open-settings", onOpenSettings);
  }, []);

  const showDrawer = ui.chatDrawerOpen && (ui.activeView === "chat" || ui.activeView === "spaces");
  const showRight =
    ui.rightPanelOpen &&
    (ui.activeView === "chat" ||
      ui.activeView === "feed" ||
      ui.activeView === "ideas" ||
      ui.activeView === "goals");

  return (
    <section
      id="pane-bot"
      className="qj-bot-stage"
      data-right-closed={showRight ? "false" : "true"}
      data-bot-view={ui.activeView}
      data-testid="bot-stage"
    >
      <div id="bot-drawer-wrap" className={`qj-bot-drawer-wrap${showDrawer ? " open" : ""}`}>
        <BotSideChatDrawer ctx={ctx} />
      </div>

      <div id="bot-center-wrap" className="qj-bot-center-wrap">
        {ui.activeView === "chat" && <BotChatColumn ctx={ctx} cwd={cwd} isSplitSpace={false} />}
        {ui.activeView === "feed" && <BotFeedView ctx={ctx} />}
        {ui.activeView === "ideas" && <BotIdeasView ctx={ctx} />}
        {ui.activeView === "goals" && <BotGoalsView ctx={ctx} />}
        {ui.activeView === "library" && <BotLibraryView ctx={ctx} />}
        {ui.activeView === "spaces" && (
          <div className="qj-animate-page-in" style={{ flex: "1 1 auto", minWidth: 0, display: "flex" }}>
            <BotChatColumn ctx={ctx} cwd={cwd} isSplitSpace />
            <BotSpacesCanvas ctx={ctx} inSplit />
          </div>
        )}
      </div>

      <div id="bot-right-wrap" className={`qj-bot-right-wrap${showRight ? "" : " closed"}`}>
        <BotCompanionPanel ctx={ctx} />
      </div>

      <BotModals ctx={ctx} />
    </section>
  );
}
