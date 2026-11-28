/**
 * 1:1+ Meta Muse V2 `动态` (Feed) View (`src/builtin-plugins/bot-mode/BotFeedView.tsx`).
 *
 * Edition briefing stream (`早刊` / `午刊` / `晚刊`) with inline Markdown source links,
 * 4 attachment kinds (`hero_image` + Lightbox, `carousel`, zero-script `widgetHtml` iframe,
 * `none`), structured `metricsCard`, standalone `为何我创建这篇帖子` dialog, and Split Chat.
 */
import { useEffect, useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  Cpu,
  ExternalLink,
  FileText,
  Heart,
  Info,
  Laptop,
  MessageCircle,
  MoreHorizontal,
  Newspaper,
  RotateCw,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { Markdown } from "@qianji/client-primitives";
import type { BotFeedItem } from "@qianji/protocol";
import {
  BotDiscoverySplitToggle,
  BotFeedHtmlWidget,
  BotFeedImageLightbox,
  BotFeedInstructionsDialog,
  BotFeedWhyDialog,
  type BotLightboxState,
} from "./BotFeedModals";
import {
  DEFAULT_FEED_INSTRUCTIONS,
  formatFeedEditionLabel,
  formatFeedExactTimestamp,
  formatFeedRelativeTime,
  useBotController,
  useBotSnapshot,
  useBotUiState,
} from "./botStore";

function renderFeedBadgeIcon(icon?: string): ReactElement {
  const key = icon?.trim().toLowerCase() ?? "";
  if (key === "laptop" || key === "monitor") return <Laptop size={15} strokeWidth={1.8} />;
  if (key === "cpu" || key === "chip") return <Cpu size={15} strokeWidth={1.8} />;
  if (key === "doc" || key === "receipt" || key === "file") return <FileText size={15} strokeWidth={1.8} />;
  if (key === "news") return <Newspaper size={15} strokeWidth={1.8} />;
  return <Sparkles size={15} strokeWidth={1.8} />;
}

export function BotFeedView(props: {
  readonly ctx?: Context;
  readonly initialOpenMenuId?: string | null;
  readonly initialWhyItemId?: string | null;
  readonly initialInstructionsOpen?: boolean;
  readonly initialLightbox?: BotLightboxState | null;
}): ReactElement {
  const {
    ctx,
    initialOpenMenuId = null,
    initialWhyItemId = null,
    initialInstructionsOpen = false,
    initialLightbox = null,
  } = props;
  const snapshot = useBotSnapshot();
  const ui = useBotUiState();
  const ctrl = useBotController(ctx);

  const currentInstructions = snapshot.feedInstructions ?? DEFAULT_FEED_INSTRUCTIONS;
  const [openMenuId, setOpenMenuId] = useState<string | null>(initialOpenMenuId);
  const [whyItemId, setWhyItemId] = useState<string | null>(initialWhyItemId);
  const [lightbox, setLightbox] = useState<BotLightboxState | null>(initialLightbox);
  const [instructionsOpen, setInstructionsOpen] = useState(initialInstructionsOpen);
  const [instructionsDraft, setInstructionsDraft] = useState(
    initialInstructionsOpen ? currentInstructions : "",
  );
  const [savingInstructions, setSavingInstructions] = useState(false);

  const whyItem: BotFeedItem | null =
    whyItemId !== null ? (snapshot.feed.find((f) => f.id === whyItemId) ?? null) : null;

  useEffect(() => {
    const anyOverlay =
      openMenuId !== null || instructionsOpen || whyItemId !== null || lightbox !== null;
    if (!anyOverlay || typeof document === "undefined" || typeof window === "undefined") {
      return undefined;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (openMenuId !== null && target !== null && !target.closest(".qj-muse-feed-menu-anchor")) {
        setOpenMenuId(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenMenuId(null);
        setWhyItemId(null);
        setLightbox(null);
        setInstructionsOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenuId, instructionsOpen, whyItemId, lightbox]);

  const handleSaveInstructions = async (refreshNow: boolean) => {
    setSavingInstructions(true);
    try {
      await ctrl.saveFeedInstructions(instructionsDraft, refreshNow);
      setInstructionsOpen(false);
    } finally {
      setSavingInstructions(false);
    }
  };

  const handlePrimaryFeedAction = (item: BotFeedItem, isStart: boolean) => {
    if (isStart && item.ideaId) {
      void ctrl.launchIdea(item.ideaId, item.seedPrompt);
      return;
    }
    if (isStart) {
      ctrl.startInBotNow(item.seedPrompt);
      return;
    }
    ctrl.discussInBot(item.seedPrompt);
  };

  return (
    <main className="qj-animate-page-in qj-sanctuary-view" data-testid="bot-feed-view">
      <BotDiscoverySplitToggle splitChatOpen={ui.splitChatOpen} />

      <div className="qj-sanctuary-scroll">
        <div className="qj-muse-doc-col">
          <header className="qj-muse-doc-head">
            <h1 className="qj-muse-doc-title">动态</h1>
            <div className="qj-muse-head-actions">
              <button
                type="button"
                className="qj-muse-circle-action is-ghost"
                title="生成今日专属动态刊"
                aria-label="生成今日专属动态刊"
                data-testid="feed-patrol-btn"
                disabled={ui.serverBusy}
                onClick={() => void ctrl.generateFeedEdition()}
              >
                <RotateCw
                  size={15}
                  strokeWidth={1.85}
                  className={ui.serverBusy ? "qj-muse-spin" : undefined}
                />
              </button>
              <button
                type="button"
                className="qj-muse-circle-action"
                title="编辑动态版块指示"
                aria-label="编辑动态版块指示"
                data-testid="feed-instructions-btn"
                onClick={() => {
                  setInstructionsDraft(currentInstructions);
                  setInstructionsOpen(true);
                }}
              >
                <SlidersHorizontal size={16} strokeWidth={1.85} />
              </button>
            </div>
          </header>

          {snapshot.feed.length === 0 ? (
            <div className="qj-muse-empty-block" data-testid="feed-empty-state">
              <div className="qj-muse-empty-glyph" aria-hidden="true">
                <Newspaper size={22} strokeWidth={1.75} />
              </div>
              <p className="qj-muse-empty-headline">还没有主动动态简报</p>
              <p className="qj-muse-empty-caption">
                千机会结合你的近期对话关注点、长期记忆与连接器信号，主动主编简洁高密度的专属动态刊。
              </p>
              <button
                type="button"
                className="qj-muse-blue-pill-btn"
                data-testid="feed-empty-generate-btn"
                disabled={ui.serverBusy}
                onClick={() => void ctrl.generateFeedEdition()}
              >
                生成今日专属动态刊
              </button>
            </div>
          ) : (
            <div className="qj-muse-feed-list">
              {snapshot.feed.map((f) => {
                const isLiked = f.liked === true;
                const isMenuOpen = openMenuId === f.id;
                const isStart = f.origin === "idea" || f.actionKind === "start";
                const actionText = f.actionLabel?.trim() || (isStart ? "立即开始" : "讨论");
                const editionTag = formatFeedEditionLabel(f.editionKind, f.kicker);
                const att = f.attachment;

                return (
                  <article key={f.id} className="qj-muse-feed-card" data-testid={`feed-card-${f.id}`}>
                    <div className="qj-muse-feed-row-top">
                      <div className="qj-muse-feed-meta-left">
                        <span className="qj-muse-feed-badge" aria-hidden="true">
                          {renderFeedBadgeIcon(f.icon)}
                        </span>
                        <h2 className="qj-muse-feed-item-title">{f.title}</h2>
                        {editionTag !== null && (
                          <span
                            className="qj-muse-feed-edition-pill"
                            data-testid={`feed-edition-${f.id}`}
                          >
                            {editionTag}
                          </span>
                        )}
                      </div>

                      <div className="qj-muse-feed-meta-right">
                        <time className="qj-muse-feed-time">
                          {formatFeedRelativeTime(f.createdAt, f.timeLabel)}
                        </time>

                        <div className="qj-muse-feed-menu-anchor">
                          <button
                            type="button"
                            className={`qj-muse-row-more-btn${isMenuOpen ? " active" : ""}`}
                            aria-label="动态单元选项"
                            aria-haspopup="menu"
                            aria-expanded={isMenuOpen}
                            data-testid={`feed-more-${f.id}`}
                            onClick={() => setOpenMenuId((cur) => (cur === f.id ? null : f.id))}
                          >
                            <MoreHorizontal size={16} strokeWidth={1.85} />
                          </button>

                          {isMenuOpen && (
                            <div
                              className="qj-muse-floating-menu"
                              role="menu"
                              aria-label="动态单元选项菜单"
                            >
                              <div className="qj-muse-menu-timestamp">
                                {formatFeedExactTimestamp(f.createdAt, f.timeLabel)}
                              </div>
                              <button
                                type="button"
                                role="menuitem"
                                data-testid={`feed-why-${f.id}`}
                                onClick={() => {
                                  setOpenMenuId(null);
                                  setWhyItemId(f.id);
                                }}
                              >
                                <Info size={15} strokeWidth={1.8} />
                                <span>我为何创建此内容</span>
                              </button>
                              <div className="qj-muse-menu-divider" role="separator" />
                              <button
                                type="button"
                                role="menuitem"
                                className="is-danger"
                                data-testid={`feed-delete-${f.id}`}
                                onClick={() => {
                                  setOpenMenuId(null);
                                  void ctrl.deleteFeedItem(f.id);
                                }}
                              >
                                <Trash2 size={15} strokeWidth={1.8} />
                                <span>删除</span>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="qj-muse-feed-indent">
                      <div className="qj-muse-feed-body">
                        <Markdown content={f.body} />
                      </div>

                      {att?.kind === "hero_image" && (
                        <button
                          type="button"
                          className="qj-muse-feed-hero-btn"
                          aria-label="全屏查看图片"
                          data-testid={`feed-hero-${f.id}`}
                          style={
                            att.aspectRatio && att.aspectRatio > 0
                              ? { aspectRatio: String(att.aspectRatio) }
                              : undefined
                          }
                          onClick={() =>
                            setLightbox({
                              images: [{ url: att.heroImageUrl, alt: att.imageAlt || f.title }],
                              index: 0,
                            })
                          }
                        >
                          <img src={att.heroImageUrl} alt={att.imageAlt || f.title} />
                        </button>
                      )}

                      {att?.kind === "carousel" && att.imageUrls.length > 0 && (
                        <div className="qj-muse-feed-carousel" data-testid={`feed-carousel-${f.id}`}>
                          {att.imageUrls.map((url, idx) => (
                            <button
                              key={`${url}-${idx}`}
                              type="button"
                              className="qj-muse-feed-carousel-item"
                              aria-label={`全屏查看图片 ${idx + 1}`}
                              data-testid={`feed-carousel-img-${f.id}-${idx}`}
                              onClick={() =>
                                setLightbox({
                                  images: att.imageUrls.map((u, i) => ({
                                    url: u,
                                    alt: `${f.title} (${i + 1})`,
                                  })),
                                  index: idx,
                                })
                              }
                            >
                              <img src={url} alt={`${f.title} (${idx + 1})`} />
                            </button>
                          ))}
                        </div>
                      )}

                      {att?.kind === "widget" && (
                        <BotFeedHtmlWidget
                          title={att.widgetTitle || f.title}
                          widgetHtml={att.widgetHtml}
                        />
                      )}

                      {f.sourceLinks !== undefined && f.sourceLinks.length > 0 && (
                        <div className="qj-muse-feed-sources">
                          {f.sourceLinks.map((link) => (
                            <a
                              key={`${link.url}-${link.label}`}
                              href={link.url}
                              target="_blank"
                              rel="noreferrer"
                              className="qj-muse-source-pill"
                            >
                              <span>{link.label}</span>
                              <ExternalLink size={11.5} strokeWidth={1.85} />
                            </a>
                          ))}
                        </div>
                      )}

                      {f.metricsCard !== undefined && f.metricsCard.rows.length > 0 && (
                        <div className="qj-muse-metrics-card" data-testid="feed-metrics-card">
                          <div className="qj-muse-metrics-head">
                            <Tag size={12.5} strokeWidth={1.85} />
                            <span>{f.metricsCard.title}</span>
                          </div>
                          <div className="qj-muse-metrics-rows">
                            {f.metricsCard.rows.map((row, rIdx) => (
                              <div
                                key={`${row.label}-${rIdx}`}
                                className={`qj-muse-metrics-row${row.highlight ? " is-highlight" : ""}`}
                              >
                                <div className="qj-muse-metrics-left">
                                  <div className="qj-muse-metrics-label-line">
                                    <span className="qj-muse-metrics-label">{row.label}</span>
                                    {row.badge && (
                                      <span className="qj-muse-metrics-badge">{row.badge}</span>
                                    )}
                                  </div>
                                  {row.sublabel && (
                                    <span className="qj-muse-metrics-sublabel">{row.sublabel}</span>
                                  )}
                                </div>
                                <span className="qj-muse-metrics-value">{row.value}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="qj-muse-feed-footer">
                        <button
                          type="button"
                          className={`qj-muse-feed-like-btn${isLiked ? " active" : ""}`}
                          aria-label="收藏动态"
                          aria-pressed={isLiked}
                          data-testid={`feed-like-${f.id}`}
                          onClick={() => void ctrl.toggleFeedLike(f.id)}
                        >
                          <Heart
                            size={15.5}
                            strokeWidth={1.85}
                            fill={isLiked ? "currentColor" : "none"}
                          />
                        </button>

                        <button
                          type="button"
                          className={`qj-muse-feed-cta-btn${isStart ? " is-start" : ""}`}
                          data-testid={`feed-cta-${f.id}`}
                          onClick={() => handlePrimaryFeedAction(f, isStart)}
                        >
                          {isStart ? (
                            <WandSparkles size={14.5} strokeWidth={1.85} />
                          ) : (
                            <MessageCircle size={14.5} strokeWidth={1.85} />
                          )}
                          <span>{actionText}</span>
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <BotFeedWhyDialog item={whyItem} onClose={() => setWhyItemId(null)} />

      <BotFeedImageLightbox
        state={lightbox}
        onClose={() => setLightbox(null)}
        onChangeIndex={(nextIndex) =>
          setLightbox((prev) => (prev ? { ...prev, index: nextIndex } : null))
        }
      />

      <BotFeedInstructionsDialog
        open={instructionsOpen}
        draft={instructionsDraft}
        unchanged={instructionsDraft.trim() === currentInstructions.trim()}
        saving={savingInstructions}
        onChangeDraft={setInstructionsDraft}
        onClose={() => setInstructionsOpen(false)}
        onSave={(refreshNow) => void handleSaveInstructions(refreshNow)}
      />
    </main>
  );
}
