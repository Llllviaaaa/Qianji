/**
 * 1:1+ Meta Muse Left Icon-Only Rail (`bot.rail` factory, `72px` fixed width).
 *
 * Renders the top circular avatar return button on non-chat views, 7 vertically
 * centered `42px` circular icon buttons (`聊天 / 搜索 / 动态 / 点子 / 目标 / 资源库 / 创建空间`),
 * global `Ctrl+B` (`Cmd+B`) drawer shortcut, and the bottom `=` menu trigger.
 */
import { useEffect, type ReactElement } from "react";
import {
  Equal,
  Lightbulb,
  MessageCircle,
  Newspaper,
  Search,
  Shapes,
  SquareCheck,
  SquarePlus,
} from "lucide-react";
import { useNavigationState } from "@qianji/client";
import type { SlotComponentProps } from "@qianji/client-slots";
import { BotCompanionAvatar } from "./BotAvatarArt";
import {
  botUiStore,
  openBotConnector,
  openBotModal,
  patchBotUi,
  useBotSnapshot,
  useBotUiState,
  type BotRailView,
} from "./botStore";

type RailNavId = BotRailView | "search";

interface RailNavItem {
  readonly id: RailNavId;
  readonly label: string;
  readonly Icon: typeof MessageCircle;
}

const RAIL_ITEMS: readonly RailNavItem[] = [
  { id: "chat", label: "聊天", Icon: MessageCircle },
  { id: "search", label: "搜索", Icon: Search },
  { id: "feed", label: "动态", Icon: Newspaper },
  { id: "ideas", label: "点子", Icon: Lightbulb },
  { id: "goals", label: "目标", Icon: SquareCheck },
  { id: "library", label: "资源库", Icon: Shapes },
  { id: "spaces", label: "创建空间", Icon: SquarePlus },
];

export function BotLeftRail(
  props: SlotComponentProps<{ readonly active?: boolean }, "root">,
): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const navState = useNavigationState(props.ctx);
  const isBotShellActive = props.active === true || navState?.shellMode === "bot";

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

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onShortcut = (event: KeyboardEvent) => {
      const domBotActive =
        typeof document !== "undefined" &&
        document.querySelector('.app-shell[data-shell-mode="bot"]') !== null;
      if (!isBotShellActive && !domBotActive) return;
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "b"
      ) {
        event.preventDefault();
        event.stopPropagation();
        const cur = botUiStore.get();
        const currentlyVisible = cur.chatDrawerOpen || cur.chatDrawerPinned;
        patchBotUi({
          activeView: "chat",
          chatDrawerOpen: !currentlyVisible,
          ...(currentlyVisible ? { chatDrawerPinned: false } : {}),
        });
      }
    };
    window.addEventListener("keydown", onShortcut, true);
    return () => window.removeEventListener("keydown", onShortcut, true);
  }, [isBotShellActive]);

  const pendingCount = snapshot.pendingApprovals.length;
  const showTopAvatar =
    ui.activeView === "feed" ||
    ui.activeView === "ideas" ||
    ui.activeView === "goals" ||
    ui.activeView === "library";

  return (
    <aside
      className="qj-bot-island-dock"
      aria-label="千机分身导航栏"
      data-testid="bot-left-rail"
    >
      <div className="qj-rail-top-slot">
        {showTopAvatar && (
          <button
            type="button"
            className="qj-rail-avatar-btn"
            title={`回到${snapshot.profile.displayName}聊天`}
            aria-label="打开完整聊天"
            onClick={() => patchBotUi({ activeView: "chat", modal: null, moreMenuOpen: false })}
          >
            <BotCompanionAvatar
              preset={snapshot.profile.avatarPreset}
              customDataUrl={snapshot.profile.customAvatarDataUrl}
              size={40}
              shape="circle"
            />
          </button>
        )}
      </div>

      <nav className="qj-island-group" aria-label="分身视图">
        {RAIL_ITEMS.map(({ id, label, Icon }) => {
          const isActive =
            id === "search" ? ui.modal === "search" : ui.activeView === id && ui.modal === null;
          return (
            <button
              key={id}
              type="button"
              data-bot-nav={id}
              title={id === "chat" ? `${label} (Ctrl+B 切换侧栏)` : label}
              aria-label={label}
              aria-current={isActive && id !== "search" ? "page" : undefined}
              className={`qj-island-slot${isActive ? " active" : ""}`}
              onClick={() => {
                if (id === "search") {
                  openBotModal("search");
                  return;
                }
                if (id === "chat" && ui.activeView === "chat" && ui.modal === null) {
                  const isOpen = ui.chatDrawerOpen || ui.chatDrawerPinned;
                  patchBotUi({
                    chatDrawerOpen: !isOpen,
                    ...(isOpen ? { chatDrawerPinned: false } : {}),
                    moreMenuOpen: false,
                  });
                  return;
                }
                patchBotUi({ activeView: id, modal: null, moreMenuOpen: false });
              }}
            >
              <Icon size={21} strokeWidth={1.75} aria-hidden="true" />
              {id === "feed" && pendingCount > 0 && (
                <span className="qj-island-badge" aria-hidden="true" />
              )}
            </button>
          );
        })}
      </nav>

      <div className="qj-island-bottom">
        <div className="qj-bot-rail-more-anchor">
          <button
            type="button"
            data-bot-nav="more"
            title="更多与设置"
            aria-label="更多与设置"
            className={`qj-island-slot${ui.moreMenuOpen ? " active" : ""}`}
            onClick={() => patchBotUi({ moreMenuOpen: !ui.moreMenuOpen })}
          >
            <Equal size={20} strokeWidth={1.85} aria-hidden="true" />
          </button>

          {ui.moreMenuOpen && (
            <div className="qj-bot-more-popover" role="menu" aria-label="Bot 更多菜单">
              <button type="button" role="menuitem" onClick={() => openBotConnector(null)}>
                <span>连接器与应用</span>
              </button>
              <button type="button" role="menuitem" onClick={() => openBotModal("shortcuts")}>
                <span>键盘快捷键</span>
                <span className="qj-bot-menu-shortcut">Ctrl+/</span>
              </button>
              <button type="button" role="menuitem" onClick={() => openBotModal("report-issue")}>
                <span>报告问题</span>
              </button>
              <div className="qj-bot-menu-sep" />
              <button
                type="button"
                role="menuitem"
                className="qj-bot-menu-strong"
                onClick={() => openBotModal("settings", "general")}
              >
                <span>设置</span>
                <span className="qj-bot-menu-shortcut">Ctrl+,</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
