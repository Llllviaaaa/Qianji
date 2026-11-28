/**
 * 1:1+ Meta Muse V2 `点子` (Ideas) View (`src/builtin-plugins/bot-mode/BotIdeasView.tsx`).
 *
 * Clicking any Idea row opens `<BotIdeaDetailModal>` (`包含哪些内容` + `如何运作` + `立即开始`),
 * keeping sibling buttons (zero nested `<button>`s) and a floating Undo bar on dismiss.
 */
import { useEffect, useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  CheckCircle2,
  CircleDollarSign,
  FileText,
  GitBranch,
  LayoutGrid,
  Moon,
  MoreHorizontal,
  RotateCw,
  Sparkles,
  Sun,
  ThumbsDown,
  ThumbsUp,
  Undo2,
  WandSparkles,
  X,
} from "lucide-react";
import type { BotIdeaItem } from "@qianji/protocol";
import { BotDiscoverySplitToggle } from "./BotFeedModals";
import { BotIdeaDetailModal } from "./BotIdeaDetailModal";
import {
  formatIdeaCapabilitiesBadge,
  patchBotUi,
  useBotController,
  useBotSnapshot,
  useBotUiState,
} from "./botStore";

function renderIdeaGlyph(item: BotIdeaItem): ReactElement {
  const key = item.icon?.trim().toLowerCase() ?? "";
  if (item.id === "idea-health-check" || key === "check") {
    return <CheckCircle2 size={17} strokeWidth={1.8} />;
  }
  if (item.id === "idea-space-board" || key === "space" || key === "layout") {
    return <LayoutGrid size={17} strokeWidth={1.8} />;
  }
  if (item.id === "idea-cost-plan" || key === "dollar" || key === "finance") {
    return <CircleDollarSign size={17} strokeWidth={1.8} />;
  }
  if (item.id === "idea-pre-pr" || key === "git") {
    return <GitBranch size={17} strokeWidth={1.8} />;
  }
  if (item.id === "idea-morning-brief" || key === "sun") {
    return <Sun size={17} strokeWidth={1.8} />;
  }
  if (item.id === "idea-overnight-research" || key === "moon") {
    return <Moon size={17} strokeWidth={1.8} />;
  }
  if (key === "doc" || key === "file") {
    return <FileText size={17} strokeWidth={1.8} />;
  }
  return <Sparkles size={17} strokeWidth={1.8} />;
}

export function BotIdeasView(props: {
  readonly ctx?: Context;
  readonly initialOpenMenuId?: string | null;
}): ReactElement {
  const { ctx, initialOpenMenuId = null } = props;
  const snapshot = useBotSnapshot();
  const ui = useBotUiState();
  const ctrl = useBotController(ctx);

  const [openMenuId, setOpenMenuId] = useState<string | null>(initialOpenMenuId);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (openMenuId === null) return undefined;
    if (typeof document === "undefined" || typeof window === "undefined") return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target !== null && !target.closest(".qj-muse-idea-menu-anchor")) {
        setOpenMenuId(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenuId(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenuId]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await ctrl.refreshIdeas();
    } finally {
      setRefreshing(false);
    }
  };

  const visibleSections = snapshot.ideaSections.filter((sec) => sec.items.length > 0);
  const dismissed = ui.lastDismissedIdea;

  return (
    <main className="qj-animate-page-in qj-sanctuary-view" data-testid="bot-ideas-view">
      <BotDiscoverySplitToggle splitChatOpen={ui.splitChatOpen} />

      <div className="qj-sanctuary-scroll">
        <div className="qj-muse-doc-col">
          <header className="qj-muse-doc-intro">
            <div className="qj-muse-doc-head">
              <h1 className="qj-muse-doc-title">点子</h1>
              <button
                type="button"
                className="qj-muse-subtle-pill-btn"
                data-testid="ideas-refresh-btn"
                disabled={refreshing}
                onClick={() => void handleRefresh()}
              >
                <RotateCw
                  size={14}
                  strokeWidth={1.85}
                  className={refreshing ? "qj-muse-spin" : undefined}
                />
                <span>刷新点子</span>
              </button>
            </div>
            <p className="qj-muse-doc-sub">
              我一直在思考各种新奇的方式来帮你。我会把我觉得超棒的点子放在这里。
            </p>
          </header>

          <div className="qj-muse-ideas-sections">
            {visibleSections.map((sec, idx) => (
              <section key={sec.category ?? `top-${idx}`} className="qj-muse-idea-group">
                {sec.category !== null && sec.category !== "" && (
                  <h2 className="qj-muse-group-heading">{sec.category}</h2>
                )}

                <div className="qj-muse-idea-rows">
                  {sec.items.map((it) => {
                    const isMenuOpen = openMenuId === it.id;
                    const capBadge = formatIdeaCapabilitiesBadge(it.capabilities);
                    return (
                      <div
                        key={it.id}
                        className={`qj-muse-idea-row-wrap${isMenuOpen ? " is-menu-open" : ""}`}
                        data-testid={`idea-wrap-${it.id}`}
                      >
                        <button
                          type="button"
                          className="qj-muse-idea-row"
                          data-testid={`idea-row-${it.id}`}
                          onClick={() => patchBotUi({ activeIdeaId: it.id })}
                        >
                          <span className="qj-muse-idea-icon" aria-hidden="true">
                            {renderIdeaGlyph(it)}
                          </span>
                          <span className="qj-muse-idea-copy">
                            <span className="qj-muse-idea-title-line">
                              <span className="qj-muse-idea-title">{it.title}</span>
                              {it.source === "ai" && (
                                <span className="qj-muse-idea-ai-pill">
                                  {it.sourceLabel || "结合近期对话"}
                                </span>
                              )}
                              {capBadge !== null && (
                                <span className="qj-muse-idea-cap-pill">{capBadge}</span>
                              )}
                              {it.buildStatus === "installed" && (
                                <span className="qj-muse-idea-installed-pill">已启用</span>
                              )}
                            </span>
                            <span className="qj-muse-idea-desc">{it.description}</span>
                          </span>
                        </button>

                        <div className="qj-muse-idea-menu-anchor">
                          <button
                            type="button"
                            className={`qj-muse-row-more-btn${isMenuOpen ? " active" : ""}`}
                            aria-label={`${it.title}的更多选项`}
                            aria-haspopup="menu"
                            aria-expanded={isMenuOpen}
                            data-testid={`idea-more-${it.id}`}
                            onClick={() => setOpenMenuId((cur) => (cur === it.id ? null : it.id))}
                          >
                            <MoreHorizontal size={16} strokeWidth={1.85} />
                          </button>

                          {isMenuOpen && (
                            <div
                              className="qj-muse-floating-menu"
                              role="menu"
                              aria-label={`${it.title}选项`}
                            >
                              <button
                                type="button"
                                role="menuitem"
                                data-testid={`idea-start-${it.id}`}
                                onClick={() => {
                                  setOpenMenuId(null);
                                  void ctrl.launchIdea(it.id, it.seedPrompt);
                                }}
                              >
                                <WandSparkles size={15} strokeWidth={1.8} />
                                <span>立即开始</span>
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                data-testid={`idea-more-like-${it.id}`}
                                onClick={() => {
                                  setOpenMenuId(null);
                                  void ctrl.feedbackIdea(it.id, "more_like_this");
                                }}
                              >
                                <ThumbsUp size={15} strokeWidth={1.8} />
                                <span>更多类似内容</span>
                              </button>
                              <div className="qj-muse-menu-divider" role="separator" />
                              <button
                                type="button"
                                role="menuitem"
                                className="is-danger"
                                data-testid={`idea-dismiss-${it.id}`}
                                onClick={() => {
                                  setOpenMenuId(null);
                                  void ctrl.feedbackIdea(it.id, "not_interested");
                                }}
                              >
                                <ThumbsDown size={15} strokeWidth={1.8} />
                                <span>不感兴趣</span>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>

      {dismissed !== null && (
        <div className="qj-muse-undo-banner" role="status" data-testid="idea-undo-banner">
          <span className="qj-muse-undo-text">已隐藏该点子</span>
          <button
            type="button"
            className="qj-muse-undo-action-btn"
            data-testid="idea-undo-btn"
            onClick={() => void ctrl.restoreIdea(dismissed.id)}
          >
            <Undo2 size={13.5} strokeWidth={1.9} />
            <span>撤销</span>
          </button>
          <button
            type="button"
            className="qj-muse-undo-close-btn"
            aria-label="关闭提示"
            onClick={() => patchBotUi({ lastDismissedIdea: null })}
          >
            <X size={13.5} strokeWidth={1.9} />
          </button>
        </div>
      )}

      <BotIdeaDetailModal ctx={ctx} />
    </main>
  );
}
