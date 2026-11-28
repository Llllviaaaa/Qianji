/**
 * 1:1+ Meta Muse Slide-Out Conversation Drawer (`BotSideChatDrawer.tsx`).
 *
 * Purely focused on Conversations: resizable width (`240px..400px`, default `256px`),
 * clearable pill search (`搜索对话`), Muse `旁聊选项` menu (`保持显示聊天面板`, `显示已归档的聊天`),
 * `主要聊天` live anchor, automatic `置顶` group, and collapsible `旁聊` threads with
 * hover date, inline rename, and context menu (`置顶 / 重命名 / 归档 / 在工作台中打开 / 两步删除`).
 */
import { useEffect, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { ChevronDown, ChevronRight, Pin, Plus } from "lucide-react";
import {
  BotDrawerThreadRow,
  BotDrawerTopBar,
  type ExtendedSideThread,
} from "./BotSideDrawerMenus";
import {
  patchBotUi,
  useBotController,
  useBotSnapshot,
  useBotUiState,
} from "./botStore";

const MIN_DRAWER_WIDTH = 240;
const MAX_DRAWER_WIDTH = 400;

export function BotSideChatDrawer(props: {
  readonly ctx?: Context;
  readonly isMainStreaming?: boolean;
}): ReactElement | null {
  const { ctx, isMainStreaming = false } = props;
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);

  const [filterText, setFilterText] = useState("");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [activeMenuThreadId, setActiveMenuThreadId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [sideChatsExpanded, setSideChatsExpanded] = useState(true);

  useEffect(() => {
    if ((!optionsOpen && activeMenuThreadId === null) || typeof document === "undefined") {
      return undefined;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target === null) return;
      if (!target.closest(".qj-drawer-options-anchor")) setOptionsOpen(false);
      if (!target.closest(".qj-drawer-thread-row")) setActiveMenuThreadId(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [optionsOpen, activeMenuThreadId]);

  if (!ui.chatDrawerOpen && !ui.chatDrawerPinned) return null;

  const isMainActive = ui.activeSessionId === null || ui.activeSessionId === snapshot.mainSessionId;
  const query = filterText.trim().toLowerCase();

  const allThreads = snapshot.sideThreads as readonly ExtendedSideThread[];
  const archivedCount = allThreads.filter((th) => th.archived === true).length;
  const visiblePool = ui.chatDrawerShowArchived ? allThreads : allThreads.filter((th) => th.archived !== true);
  const filteredThreads =
    query === ""
      ? visiblePool
      : visiblePool.filter(
          (th) => th.title.toLowerCase().includes(query) || (th.snippet ?? "").toLowerCase().includes(query),
        );

  const pinnedThreads = filteredThreads.filter((th) => th.pinned === true);
  const regularThreads = filteredThreads.filter((th) => th.pinned !== true);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = ui.chatDrawerWidth;
    const onMove = (moveEvent: PointerEvent) => {
      const next = Math.max(MIN_DRAWER_WIDTH, Math.min(MAX_DRAWER_WIDTH, Math.round(startWidth + (moveEvent.clientX - startX))));
      patchBotUi({ chatDrawerWidth: next });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const renderThreadRow = (th: ExtendedSideThread) => (
    <BotDrawerThreadRow
      key={th.id}
      thread={th}
      active={ui.activeSessionId === th.sessionId}
      menuOpen={activeMenuThreadId === th.id}
      isRenaming={renamingId === th.id}
      renameDraft={renameDraft}
      onSelect={() => patchBotUi({ activeSessionId: th.sessionId, activeView: "chat", modal: null })}
      onToggleMenu={() => setActiveMenuThreadId((cur) => (cur === th.id ? null : th.id))}
      onCloseMenu={() => setActiveMenuThreadId(null)}
      onStartRename={() => {
        setRenamingId(th.id);
        setRenameDraft(th.title);
        setActiveMenuThreadId(null);
      }}
      onRenameDraftChange={setRenameDraft}
      onCommitRename={() => {
        const trimmed = renameDraft.trim();
        setRenamingId(null);
        if (trimmed !== "" && trimmed !== th.title) void ctrl.updateSideChat(th.id, { title: trimmed });
      }}
      onCancelRename={() => setRenamingId(null)}
      onTogglePin={() => void ctrl.updateSideChat(th.id, { pinned: !th.pinned })}
      onToggleArchive={() => void ctrl.updateSideChat(th.id, { archived: !th.archived })}
      onHandoff={() =>
        ctrl.triggerHandoff({
          id: `side-${th.id}`,
          title: th.title,
          kindLabel: "旁聊任务接力",
          summary: th.snippet || th.title,
          targetCwd: snapshot.botCwd,
          targetSessionFile: th.sessionFile || `harness:${th.sessionId}`,
        })
      }
      onDelete={() => void ctrl.deleteSideChat(th.id)}
    />
  );

  return (
    <aside
      className={`qj-muse-side-drawer${ui.chatDrawerPinned ? " is-pinned" : ""}`}
      aria-label="聊天与旁聊列表"
      data-testid="bot-side-drawer"
      style={{ width: ui.chatDrawerWidth, flexBasis: ui.chatDrawerWidth }}
    >
      <BotDrawerTopBar
        filterText={filterText}
        optionsOpen={optionsOpen}
        pinned={ui.chatDrawerPinned}
        showArchived={ui.chatDrawerShowArchived}
        archivedCount={archivedCount}
        onFilterChange={setFilterText}
        onToggleOptions={() => setOptionsOpen((prev) => !prev)}
        onTogglePinned={() => patchBotUi({ chatDrawerPinned: !ui.chatDrawerPinned, chatDrawerOpen: true })}
        onToggleShowArchived={() => patchBotUi({ chatDrawerShowArchived: !ui.chatDrawerShowArchived })}
        onCollapse={() => patchBotUi({ chatDrawerOpen: false, chatDrawerPinned: false })}
      />

      <div className="qj-muse-drawer-scroll">
        <button
          type="button"
          className={`qj-muse-drawer-item qj-drawer-main-chat${isMainActive ? " active" : ""}`}
          onClick={() => patchBotUi({ activeSessionId: null, activeView: "chat", modal: null })}
        >
          <span className={`qj-drawer-main-dot${isMainStreaming ? " streaming" : ""}`} aria-hidden="true" />
          <span className="qj-drawer-main-texts">
            <span className="qj-muse-drawer-item-label">主要聊天</span>
            {isMainStreaming && <span className="qj-drawer-main-sub">正在思考与回复…</span>}
          </span>
        </button>

        {pinnedThreads.length > 0 && (
          <section className="qj-drawer-section" aria-label="置顶对话">
            <div className="qj-drawer-group-caption">
              <Pin size={11.5} strokeWidth={1.9} aria-hidden="true" />
              <span>置顶</span>
            </div>
            <div className="qj-muse-drawer-list">{pinnedThreads.map(renderThreadRow)}</div>
          </section>
        )}

        <section className="qj-drawer-section" aria-label="旁聊列表">
          <div className="qj-muse-drawer-head">
            <button
              type="button"
              className="qj-drawer-section-toggle"
              aria-expanded={sideChatsExpanded}
              onClick={() => setSideChatsExpanded((prev) => !prev)}
            >
              {sideChatsExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <span>旁聊</span>
              {regularThreads.length > 0 && <span className="qj-drawer-count-pill">{regularThreads.length}</span>}
            </button>
            <button
              type="button"
              className="qj-muse-drawer-add-btn"
              title="新建旁聊"
              aria-label="新建旁聊"
              data-testid="bot-drawer-new-sidechat"
              onClick={() => void ctrl.createSideChat()}
            >
              <Plus size={15} strokeWidth={1.9} />
            </button>
          </div>

          {sideChatsExpanded && (
            <div className="qj-muse-drawer-list">
              {regularThreads.length > 0 ? (
                regularThreads.map(renderThreadRow)
              ) : pinnedThreads.length === 0 ? (
                <div className="qj-drawer-empty-hint">
                  {query !== "" ? "未找到匹配的旁聊" : "点击 + 开启独立旁聊，支线调研不刷乱主聊天"}
                </div>
              ) : null}
            </div>
          )}
        </section>
      </div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整面板大小"
        aria-valuenow={ui.chatDrawerWidth}
        aria-valuemin={MIN_DRAWER_WIDTH}
        aria-valuemax={MAX_DRAWER_WIDTH}
        tabIndex={0}
        className="qj-drawer-resize-handle"
        onPointerDown={startResize}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            patchBotUi({ chatDrawerWidth: Math.max(MIN_DRAWER_WIDTH, ui.chatDrawerWidth - 12) });
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            patchBotUi({ chatDrawerWidth: Math.min(MAX_DRAWER_WIDTH, ui.chatDrawerWidth + 12) });
          }
        }}
      />
    </aside>
  );
}
