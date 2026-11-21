/**
 * Left `68px` minimalist dock (`bot.rail` factory) for Qianji Bot Mode.
 */
import { useEffect, type ReactElement } from "react";
import {
  Compass,
  FolderKanban,
  Lightbulb,
  Menu,
  MessageCircle,
  PlusSquare,
  Search,
  Target,
} from "lucide-react";
import { useFrontendService } from "@qianji/client";
import type { SlotComponentProps } from "@qianji/client-slots";
import { BotBrandOrbIcon } from "./BotAvatarArt";
import {
  openBotModal,
  patchBotUi,
  useBotSnapshot,
  useBotUiState,
  type BotRailView,
} from "./botStore";

const NAV_ITEMS: ReadonlyArray<{
  readonly id: BotRailView | "search";
  readonly label: string;
  readonly shortcut?: string;
  readonly icon: typeof MessageCircle;
}> = [
  { id: "chat", label: "聊天", icon: MessageCircle },
  { id: "search", label: "全局搜索", shortcut: "Ctrl+K", icon: Search },
  { id: "feed", label: "动态", icon: Compass },
  { id: "ideas", label: "点子", icon: Lightbulb },
  { id: "goals", label: "目标", icon: Target },
  { id: "library", label: "资源库", icon: FolderKanban },
  { id: "spaces", label: "创建空间", icon: PlusSquare },
];

export function BotLeftRail(
  props: SlotComponentProps<{ readonly active?: boolean }, "root">,
): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const navigationService = useFrontendService("navigationService", props.ctx);

  useEffect(() => {
    if (!ui.moreMenuOpen || typeof document === "undefined" || typeof window === "undefined") {
      return undefined;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target !== null && !target.closest(".qj-bot-rail-bottom")) {
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
      <div className="qj-bot-rail-top">
        <button
          type="button"
          className="qj-bot-brand-orb"
          title={`${snapshot.profile.displayName} · 回到主聊天`}
          aria-label="回到主聊天"
          onClick={() => patchBotUi({ activeView: "chat", activeSessionId: null, modal: null })}
        >
          <BotBrandOrbIcon size={22} />
        </button>

        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isSearch = item.id === "search";
          const isActive = !isSearch && ui.activeView === item.id && ui.modal === null;
          return (
            <button
              key={item.id}
              type="button"
              data-bot-nav={item.id}
              className={`qj-bot-rail-btn${isActive ? " active" : ""}`}
              title={item.shortcut ? `${item.label} (${item.shortcut})` : item.label}
              aria-label={item.label}
              aria-current={isActive ? "page" : undefined}
              onClick={() => {
                if (isSearch) {
                  openBotModal("search");
                } else {
                  patchBotUi({ activeView: item.id, modal: null });
                }
              }}
            >
              <Icon size={19} strokeWidth={1.75} />
              {item.id === "feed" && pendingCount > 0 && (
                <span className="qj-bot-rail-badge" aria-hidden="true" />
              )}
            </button>
          );
        })}
      </div>

      <div className="qj-bot-rail-bottom">
        <button
          type="button"
          data-bot-nav="more"
          className={`qj-bot-rail-btn${ui.moreMenuOpen ? " active" : ""}`}
          title="更多与设置"
          aria-label="更多菜单"
          onClick={() => patchBotUi({ moreMenuOpen: !ui.moreMenuOpen })}
        >
          <Menu size={19} strokeWidth={1.75} />
        </button>

        {ui.moreMenuOpen && (
          <div className="qj-bot-more-popover" role="menu" aria-label="Bot 更多菜单">
            <button
              type="button"
              role="menuitem"
              onClick={() => openBotModal("shortcuts")}
            >
              <span>键盘快捷键</span>
              <kbd>?</kbd>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                patchBotUi({
                  moreMenuOpen: false,
                  activeView: "chat",
                  composerDraft: "我想反馈一个产品体验问题：",
                });
                navigationService?.showToast("已在主聊天准备好反馈草稿", "info");
              }}
            >
              <span>报告问题</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => openBotModal("settings", "profile")}
            >
              <span>Bot 与虚拟服务器设置</span>
              <kbd>Ctrl+,</kbd>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                patchBotUi({ moreMenuOpen: false });
                navigationService?.openSettings("general");
              }}
            >
              <span>千机全局设置</span>
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
