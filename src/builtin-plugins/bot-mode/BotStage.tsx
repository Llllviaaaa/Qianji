import { useEffect, type ReactElement } from "react";
import type { SlotComponentProps } from "@qianji/client-slots";
import { BotChatView } from "./BotChatView";
import { BotCompanionPanel } from "./BotCompanionPanel";
import { BotFeedView, BotGoalsView, BotIdeasView } from "./BotDiscoveryViews";
import { BotLibraryView, BotSpaceBuilderView } from "./BotLibraryAndSpaces";
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
      openBotModal("settings", "profile");
    };
    window.addEventListener("qianji:bot-open-settings", onOpenSettings);
    return () => window.removeEventListener("qianji:bot-open-settings", onOpenSettings);
  }, []);

  return (
    <div
      className="qj-bot-stage"
      data-right-open={ui.rightPanelOpen ? "true" : "false"}
      data-bot-view={ui.activeView}
      data-testid="bot-stage"
    >
      {ui.activeView === "chat" && <BotChatView ctx={ctx} cwd={cwd} />}
      {ui.activeView === "feed" && <BotFeedView ctx={ctx} />}
      {ui.activeView === "ideas" && <BotIdeasView ctx={ctx} />}
      {ui.activeView === "goals" && <BotGoalsView ctx={ctx} />}
      {ui.activeView === "library" && <BotLibraryView ctx={ctx} />}
      {ui.activeView === "spaces" && <BotSpaceBuilderView ctx={ctx} />}

      <BotCompanionPanel ctx={ctx} />
      <BotModals ctx={ctx} />
    </div>
  );
}
