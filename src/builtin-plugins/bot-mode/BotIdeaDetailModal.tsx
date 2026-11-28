/**
 * 1:1 Meta Muse `点子` Blueprint Package Preview Modal (`BotIdeaDetailModal.tsx`).
 *
 * Displays `包含哪些内容` (`空间` / `定期任务` / `文档` / `工作台草案` with emerald ready checks),
 * `如何运作` execution contract, circular `⋯` feedback menu, and full-width `[立即开始]` CTA.
 */
import { useEffect, useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  Bell,
  CalendarClock,
  CheckCircle2,
  FileText,
  GitBranch,
  LayoutGrid,
  MoreHorizontal,
  Target,
  ThumbsDown,
  ThumbsUp,
  WandSparkles,
  X,
} from "lucide-react";
import type { BotIdeaCapabilityItem, BotIdeaCapabilityKind } from "@qianji/protocol";
import { patchBotUi, useBotController, useBotSnapshot, useBotUiState } from "./botStore";

function renderCapabilityIcon(kind: BotIdeaCapabilityKind): ReactElement {
  switch (kind) {
    case "space":
      return <LayoutGrid size={16} strokeWidth={1.8} />;
    case "schedule":
      return <CalendarClock size={16} strokeWidth={1.8} />;
    case "workbench":
      return <GitBranch size={16} strokeWidth={1.8} />;
    case "goal":
      return <Target size={16} strokeWidth={1.8} />;
    case "reminder":
      return <Bell size={16} strokeWidth={1.8} />;
    case "doc":
    default:
      return <FileText size={16} strokeWidth={1.8} />;
  }
}

export function BotIdeaDetailModal(props: {
  readonly ctx?: Context;
  readonly initialMoreOpen?: boolean;
}): ReactElement | null {
  const { ctx, initialMoreOpen = false } = props;
  const snapshot = useBotSnapshot();
  const ui = useBotUiState();
  const ctrl = useBotController(ctx);

  const [moreOpen, setMoreOpen] = useState(initialMoreOpen);
  const [launching, setLaunching] = useState(false);

  const idea =
    ui.activeIdeaId !== null
      ? (snapshot.ideaSections
          .flatMap((sec) => sec.items)
          .find((item) => item.id === ui.activeIdeaId) ?? null)
      : null;

  useEffect(() => {
    if (idea === null || typeof window === "undefined" || typeof document === "undefined") {
      return undefined;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (moreOpen && target !== null && !target.closest(".qj-muse-idea-modal-more-anchor")) {
        setMoreOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (moreOpen) setMoreOpen(false);
        else patchBotUi({ activeIdeaId: null });
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [idea, moreOpen]);

  if (idea === null) return null;

  const closeModal = () => {
    setMoreOpen(false);
    patchBotUi({ activeIdeaId: null });
  };

  const capabilities: readonly BotIdeaCapabilityItem[] =
    idea.capabilities && idea.capabilities.length > 0
      ? idea.capabilities
      : [
          {
            kind: "doc",
            title: `${idea.title.slice(0, 18)}执行结果`,
            subtitle: "按步骤核查上下文并生成可直接审阅的结论清单。",
            ready: true,
          },
        ];

  const howItWorksText =
    idea.howItWorks ||
    idea.reason ||
    "我会先只读核实相关上下文与约束条件，按步骤准备好交付产物；凡是涉及写操作或需要你拍板的地方，都会先停下来等你确认。";

  const handleLaunch = async () => {
    setLaunching(true);
    try {
      await ctrl.launchIdea(idea.id, idea.seedPrompt);
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div
      className="qj-bot-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeModal();
      }}
    >
      <div
        className="qj-bot-dialog qj-muse-idea-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label={idea.title}
        data-testid="idea-detail-modal"
      >
        <header className="qj-muse-dialog-top">
          <h2 className="qj-muse-dialog-heading">{idea.title}</h2>
          <button
            type="button"
            className="qj-muse-dialog-close"
            aria-label="关闭"
            data-testid="idea-modal-close-btn"
            onClick={closeModal}
          >
            <X size={16} strokeWidth={1.9} />
          </button>
        </header>

        <p className="qj-muse-idea-modal-desc">{idea.description}</p>

        <section className="qj-muse-idea-modal-section">
          <h4 className="qj-muse-idea-modal-subhead">包含哪些内容</h4>
          <div className="qj-muse-idea-cap-list" data-testid="idea-capabilities-list">
            {capabilities.map((cap, idx) => {
              const isReady = cap.ready !== false || idea.buildStatus === "installed";
              return (
                <div key={`${cap.kind}-${cap.title}-${idx}`} className="qj-muse-idea-cap-row">
                  <span className="qj-muse-idea-cap-icon" aria-hidden="true">
                    {renderCapabilityIcon(cap.kind)}
                  </span>
                  <div className="qj-muse-idea-cap-copy">
                    <div className="qj-muse-idea-cap-title">{cap.title}</div>
                    <div className="qj-muse-idea-cap-sub">{cap.subtitle}</div>
                  </div>
                  {isReady && (
                    <CheckCircle2
                      size={18}
                      strokeWidth={2}
                      className="qj-muse-idea-cap-ready"
                      data-testid="idea-cap-ready-icon"
                    />
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section className="qj-muse-idea-modal-section">
          <h4 className="qj-muse-idea-modal-subhead">如何运作</h4>
          <p className="qj-muse-idea-how-body">{howItWorksText}</p>
        </section>

        <footer className="qj-muse-idea-modal-foot">
          <div className="qj-muse-idea-modal-more-anchor">
            <button
              type="button"
              className="qj-muse-idea-modal-more-btn"
              aria-label="点子更多选项"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              data-testid="idea-modal-more-btn"
              onClick={() => setMoreOpen((cur) => !cur)}
            >
              <MoreHorizontal size={17} strokeWidth={1.9} />
            </button>

            {moreOpen && (
              <div
                className="qj-muse-floating-menu is-upward-left"
                role="menu"
                aria-label="点子方案包选项"
              >
                <button
                  type="button"
                  role="menuitem"
                  data-testid="idea-modal-more-like"
                  onClick={() => {
                    setMoreOpen(false);
                    void ctrl.feedbackIdea(idea.id, "more_like_this");
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
                  data-testid="idea-modal-dismiss"
                  onClick={() => {
                    setMoreOpen(false);
                    void ctrl.feedbackIdea(idea.id, "not_interested");
                  }}
                >
                  <ThumbsDown size={15} strokeWidth={1.8} />
                  <span>不感兴趣</span>
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            className="qj-muse-cta-full-pill"
            data-testid="idea-modal-launch-btn"
            disabled={launching}
            onClick={() => void handleLaunch()}
          >
            <WandSparkles size={16} strokeWidth={1.9} />
            <span>{launching ? "正在启动…" : "立即开始"}</span>
          </button>
        </footer>
      </div>
    </div>
  );
}
