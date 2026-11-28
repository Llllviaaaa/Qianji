/**
 * Modal wrapper for `modal === "live-view"` (`查看实时画面`) backed by `BotComputerStudioPane`,
 * preserving 100% `data-testid="bot-liveview-modal"` and `liveViewTargetUrl` compatibility.
 */
import { useEffect, useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { patchBotUi, useBotUiState } from "./botStore";
import { BotComputerStudioPane } from "./computer-studio/BotComputerStudioPane";
import { useComputerStudio } from "./computer-studio/useComputerStudio";

export function BotLiveViewModal({
  ctx,
  onClose,
}: {
  readonly ctx?: Context;
  readonly onClose: () => void;
}): ReactElement {
  const ui = useBotUiState();
  const { selectStudio, navigateUrl } = useComputerStudio(ctx);
  const [initialTargetUrl] = useState<string | null>(() => ui.liveViewTargetUrl);

  useEffect(() => {
    if (!initialTargetUrl) return;
    patchBotUi({ liveViewTargetUrl: null });
    void selectStudio({ tab: "browser" });
    void navigateUrl(initialTargetUrl);
  }, [initialTargetUrl, navigateUrl, selectStudio]);

  return (
    <div
      className="qj-bot-modal-backdrop"
      onClick={onClose}
      data-testid="bot-liveview-modal"
    >
      <div
        className="qj-bot-dialog qj-cs-modal-shell"
        onClick={(e) => e.stopPropagation()}
      >
        <BotComputerStudioPane ctx={ctx} onClose={onClose} inModal />
      </div>
    </div>
  );
}
