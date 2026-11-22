/**
 * Left `68px` minimalist dock (`bot.rail` factory) matching `qianji-dual-mode-hifi.html` 1:1.
 */
import { useEffect, type ReactElement } from "react";
import type { SlotComponentProps } from "@qianji/client-slots";
import { BotBrandOrbIcon, BotIcon, type BotIconName } from "./BotAvatarArt";
import {
  openBotModal,
  patchBotUi,
  useBotSnapshot,
  useBotUiState,
  type BotRailView,
} from "./botStore";

const DOCK_ITEMS: ReadonlyArray<{
  readonly id: BotRailView | "search";
  readonly title: string;
  readonly icon: BotIconName;
}> = [
  { id: "chat", title: "聊天 (Ctrl+J)", icon: "chat" },
  { id: "search", title: "搜索 (Ctrl+K)", icon: "search" },
  { id: "feed", title: "动态", icon: "feed" },
  { id: "ideas", title: "点子", icon: "ideas" },
  { id: "goals", title: "目标", icon: "goals" },
  { id: "library", title: "资源库", icon: "library" },
  { id: "spaces", title: "创建空间", icon: "spaces" },
];

export function BotLeftRail(
  _props: SlotComponentProps<{ readonly active?: boolean }, "root">,
): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();

  useEffect(() => {
    if (!ui.moreMenuOpen || typeof document === "undefined" || typeof window === "undefined") {
      return undefined;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target !== null && !target.closest(".qj-bot-rail-more-anchor")) {
        patchBotUi({ moreMenuOpen: false });
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        patchBotUi({ moreMenuOpen: false });
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [ui.moreMenuOpen]);

  const pendingCount = snapshot.pendingApprovals.length;

  return (
    <aside className="qj-bot-rail" aria-label="千机 Bot 导航栏" data-testid="bot-left-rail">
      <button
        type="button"
        className="qj-bot-brand-btn"
        title={snapshot.profile.displayName}
        aria-label="回到主聊天"
        onClick={() => patchBotUi({ activeView: "chat", activeSessionId: null, modal: null })}
      >
        <BotBrandOrbIcon size={20} />
      </button>

      <div className="qj-bot-dock-group">
        {DOCK_ITEMS.map((item) => {
          const isSearch = item.id === "search";
          const isActive = !isSearch && ui.activeView === item.id && ui.modal === null;
          return (
            <button
              key={item.id}
              type="button"
              data-bot-nav={item.id}
              className={`qj-bot-dock-slot${isActive ? " active" : ""}`}
              title={item.title}
              aria-label={item.title}
              aria-current={isActive ? "page" : undefined}
              onClick={() => {
                patchBotUi({ moreMenuOpen: false });
                if (isSearch) {
                  openBotModal("search");
                  return;
                }
                if (item.id === "spaces" && ui.composerDraft.trim() === "") {
                  patchBotUi({ activeView: "spaces", modal: null, composerDraft: "我想创建一个空间，关于 " });
                } else {
                  patchBotUi({ activeView: item.id, modal: null });
                }
              }}
            >
              <div className="qj-bot-dock-circle">
                <BotIcon name={item.icon} />
              </div>
              {item.id === "feed" && pendingCount > 0 && (
                <span className="qj-bot-dock-badge" aria-hidden="true" />
              )}
            </button>
          );
        })}
      </div>

      <div className="qj-bot-rail-more-anchor" style={{ position: "relative" }}>
        <button
          type="button"
          data-bot-nav="more"
          className={`qj-bot-dock-slot${ui.moreMenuOpen ? " active" : ""}`}
          title="设置与更多"
          aria-label="设置与更多"
          onClick={() => patchBotUi({ moreMenuOpen: !ui.moreMenuOpen })}
        >
          <div className="qj-bot-dock-circle">
            <BotIcon name="more" />
          </div>
        </button>

        {ui.moreMenuOpen && (
          <div className="qj-bot-more-popover" role="menu" aria-label="Bot 更多菜单">
            <button type="button" role="menuitem" onClick={() => openBotModal("shortcuts")}>
              <span>键盘快捷键</span>
              <span style={{ fontSize: 12, color: "var(--qj-text-muted)" }}>Ctrl+/</span>
            </button>
            <button type="button" role="menuitem" onClick={() => openBotModal("report-issue")}>
              <span>报告问题</span>
            </button>
            <div style={{ margin: "4px 0", borderTop: "1px solid var(--qj-border-default)" }} />
            <button
              type="button"
              role="menuitem"
              style={{ fontWeight: 500 }}
              onClick={() => openBotModal("settings", "general")}
            >
              <span>设置</span>
              <span style={{ fontSize: 12, fontWeight: 400, color: "var(--qj-text-muted)" }}>Ctrl+,</span>
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
