/**
 * 1:1+ Meta Muse V2 `目标` (Goals) View (`src/builtin-plugins/bot-mode/BotGoalsView.tsx`).
 *
 * Features top-level `目标选项` (`显示辅助字幕` / `自动排序` / `已完成的目标`),
 * active `追踪` goals with real checkboxes, per-goal `...` menu, `<BotGoalDetailModal>`,
 * and 7-category Chat-First Co-Planning Dialog (`创建[分类]目标` + secondary quick input).
 */
import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  Briefcase, Check, ChevronRight, CircleDollarSign, Heart, ListChecks,
  MessageCircle, Monitor, MoreHorizontal, Palette, Pencil, SquareCheck,
  SquarePlus, Trash2, Users, WandSparkles, X,
} from "lucide-react";
import { BotDiscoverySplitToggle } from "./BotFeedModals";
import { BotCompletedGoalsModal, BotGoalDetailModal } from "./BotGoalDetailModal";
import { patchBotUi, sortActiveGoals, useBotController, useBotSnapshot, useBotUiState } from "./botStore";

const GOAL_CATEGORIES: ReadonlyArray<{ readonly name: string; readonly Icon: typeof Heart }> = [
  { name: "健康", Icon: Heart },
  { name: "人际关系", Icon: Users },
  { name: "金融", Icon: CircleDollarSign },
  { name: "职业", Icon: Briefcase },
  { name: "兴趣", Icon: Palette },
  { name: "效率提升", Icon: Monitor },
  { name: "其他", Icon: SquareCheck },
];

export function BotGoalsView(props: {
  readonly ctx?: Context;
  readonly initialPageMenuOpen?: boolean;
  readonly initialOpenGoalMenuId?: string | null;
  readonly initialCompletedModalOpen?: boolean;
  readonly initialOpenCompletedMenuId?: string | null;
  readonly initialRenamingGoalId?: string | null;
  readonly initialSelectedCat?: string | null;
  readonly initialDirectInputOpen?: boolean;
}): ReactElement {
  const {
    ctx,
    initialPageMenuOpen = false,
    initialOpenGoalMenuId = null,
    initialCompletedModalOpen = false,
    initialOpenCompletedMenuId = null,
    initialRenamingGoalId = null,
    initialSelectedCat = null,
    initialDirectInputOpen = false,
  } = props;
  const snapshot = useBotSnapshot();
  const ui = useBotUiState();
  const ctrl = useBotController(ctx);

  const [pageMenuOpen, setPageMenuOpen] = useState(initialPageMenuOpen);
  const [openGoalMenuId, setOpenGoalMenuId] = useState<string | null>(initialOpenGoalMenuId);
  const [completedModalOpen, setCompletedModalOpen] = useState(initialCompletedModalOpen);
  const [renamingGoalId, setRenamingGoalId] = useState<string | null>(initialRenamingGoalId);
  const [renameDraft, setRenameDraft] = useState("");
  const [selectedCat, setSelectedCat] = useState<string | null>(initialSelectedCat);
  const [directInputOpen, setDirectInputOpen] = useState(initialDirectInputOpen);
  const [goalTitle, setGoalTitle] = useState("");

  const showSubtitles = snapshot.goalViewPrefs?.showSubtitles !== false;
  const autoSort = snapshot.goalViewPrefs?.autoSort === true;
  const activeGoals = sortActiveGoals(snapshot.goals, autoSort);
  const completedGoals = snapshot.goals.filter((g) => g.status === "completed");

  useEffect(() => {
    const anyOverlay = pageMenuOpen || openGoalMenuId !== null || completedModalOpen || selectedCat !== null;
    if (!anyOverlay || typeof document === "undefined" || typeof window === "undefined") return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (pageMenuOpen && target !== null && !target.closest(".qj-muse-goals-head-menu-anchor")) setPageMenuOpen(false);
      if (openGoalMenuId !== null && target !== null && !target.closest(".qj-muse-goal-menu-anchor")) setOpenGoalMenuId(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPageMenuOpen(false);
        setOpenGoalMenuId(null);
        setCompletedModalOpen(false);
        setSelectedCat(null);
        setDirectInputOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [pageMenuOpen, openGoalMenuId, completedModalOpen, selectedCat]);

  const commitRename = (goalId: string) => {
    const trimmed = renameDraft.trim();
    setRenamingGoalId(null);
    if (trimmed !== "") void ctrl.updateGoal({ id: goalId, title: trimmed });
  };

  const closeInterviewModal = () => {
    setSelectedCat(null);
    setDirectInputOpen(false);
    setGoalTitle("");
  };

  const handleStartGoalInterview = () => {
    if (selectedCat === null) return;
    const cat = selectedCat;
    closeInterviewModal();
    ctrl.startInBotNow(
      `我想设定一个「${cat}」目标。请先问我两三个简短问题明确具体目标、衡量方式与跟进频率，确认后帮我正式立项追踪。`,
    );
  };

  const handleDirectCreateGoal = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = goalTitle.trim();
    if (trimmed === "" || selectedCat === null) return;
    const cat = selectedCat;
    closeInterviewModal();
    await ctrl.createGoal(trimmed, cat, { source: "manual" });
  };

  const interviewDialogTitle =
    selectedCat === null ? "" : selectedCat === "其他" ? "创建新目标" : `创建${selectedCat}目标`;

  return (
    <main className="qj-animate-page-in qj-sanctuary-view" data-testid="bot-goals-view">
      <BotDiscoverySplitToggle splitChatOpen={ui.splitChatOpen} />

      <div className="qj-sanctuary-scroll">
        <div className="qj-muse-doc-col">
          <header className="qj-muse-doc-head">
            <h1 className="qj-muse-doc-title">目标</h1>

            <div className="qj-muse-goals-head-menu-anchor">
              <button
                type="button"
                className={`qj-muse-circle-action${pageMenuOpen ? " active" : ""}`}
                aria-label="目标选项"
                aria-haspopup="menu"
                aria-expanded={pageMenuOpen}
                data-testid="goals-page-options-btn"
                onClick={() => setPageMenuOpen((cur) => !cur)}
              >
                <MoreHorizontal size={16} strokeWidth={1.85} />
              </button>

              {pageMenuOpen && (
                <div className="qj-muse-floating-menu" role="menu" aria-label="目标视图选项">
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={showSubtitles}
                    data-testid="goals-opt-subtitles"
                    onClick={() => void ctrl.saveGoalPrefs({ showSubtitles: !showSubtitles })}
                  >
                    <span className="qj-muse-menu-check-slot" aria-hidden="true">
                      {showSubtitles && <Check size={15} strokeWidth={2} />}
                    </span>
                    <span>显示辅助字幕</span>
                  </button>
                  <div className="qj-muse-menu-divider" role="separator" />
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={autoSort}
                    data-testid="goals-opt-autosort"
                    onClick={() => void ctrl.saveGoalPrefs({ autoSort: !autoSort })}
                  >
                    <span className="qj-muse-menu-check-slot" aria-hidden="true">
                      {autoSort && <Check size={15} strokeWidth={2} />}
                    </span>
                    <span>自动排序</span>
                  </button>
                  <div className="qj-muse-menu-divider" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="goals-opt-completed"
                    onClick={() => { setPageMenuOpen(false); setCompletedModalOpen(true); }}
                  >
                    <ListChecks size={15} strokeWidth={1.8} />
                    <span>已完成的目标</span>
                    {completedGoals.length > 0 && (
                      <span className="qj-muse-menu-count-badge">{completedGoals.length}</span>
                    )}
                  </button>
                </div>
              )}
            </div>
          </header>

          <section className="qj-muse-goals-block">
            <div className="qj-muse-track-header">
              <span className="qj-muse-track-halo" aria-hidden="true"><span className="qj-muse-track-dot" /></span>
              <span className="qj-muse-track-text">追踪</span>
            </div>

            {activeGoals.length === 0 ? (
              <div className="qj-muse-track-empty">还没有正在追踪的目标</div>
            ) : (
              <div className="qj-muse-goal-rows">
                {activeGoals.map((goal) => {
                  const subGoals = goal.subGoals ?? [];
                  const doneCount = subGoals.filter((s) => s.done).length;
                  const isMenuOpen = openGoalMenuId === goal.id;
                  const isRenaming = renamingGoalId === goal.id;

                  return (
                    <div
                      key={goal.id}
                      className={`qj-muse-goal-row${isMenuOpen ? " is-menu-open" : ""}`}
                      data-testid={`goal-row-${goal.id}`}
                    >
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked="false"
                        aria-label={`把${goal.title}标记为已完成`}
                        data-testid={`goal-check-${goal.id}`}
                        className="qj-muse-goal-check"
                        onClick={() => void ctrl.updateGoal({ id: goal.id, status: "completed" })}
                      />

                      {isRenaming ? (
                        <input
                          autoFocus
                          type="text"
                          className="qj-muse-goal-rename-input"
                          data-testid={`goal-rename-input-${goal.id}`}
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onBlur={() => commitRename(goal.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); commitRename(goal.id); }
                            else if (e.key === "Escape") { e.preventDefault(); setRenamingGoalId(null); }
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className="qj-muse-goal-main-btn"
                          data-testid={`goal-main-${goal.id}`}
                          onClick={() => patchBotUi({ activeGoalId: goal.id, activeGoalFocusSubGoal: false })}
                        >
                          <span className="qj-muse-goal-title-line">
                            <span className="qj-muse-goal-title">{goal.title}</span>
                            {subGoals.length > 0 && (
                              <span className="qj-muse-goal-progress-pill">{doneCount}/{subGoals.length}</span>
                            )}
                          </span>
                          {showSubtitles && goal.summary !== "" && (
                            <span className="qj-muse-goal-desc">{goal.summary}</span>
                          )}
                        </button>
                      )}

                      <div className="qj-muse-goal-menu-anchor">
                        <button
                          type="button"
                          className={`qj-muse-row-more-btn${isMenuOpen ? " active" : ""}`}
                          aria-label="目标选项"
                          aria-haspopup="menu"
                          aria-expanded={isMenuOpen}
                          data-testid={`goal-more-${goal.id}`}
                          onClick={() => setOpenGoalMenuId((cur) => (cur === goal.id ? null : goal.id))}
                        >
                          <MoreHorizontal size={16} strokeWidth={1.85} />
                        </button>

                        {isMenuOpen && (
                          <div className="qj-muse-floating-menu" role="menu" aria-label="目标操作菜单">
                            <button
                              type="button"
                              role="menuitem"
                              data-testid={`goal-discuss-${goal.id}`}
                              onClick={() => {
                                setOpenGoalMenuId(null);
                                ctrl.discussInBot(`围绕目标「${goal.title}」（当前进展：${goal.summary}），帮我推进下一步。`);
                              }}
                            >
                              <MessageCircle size={15} strokeWidth={1.8} />
                              <span>讨论</span>
                            </button>
                            <div className="qj-muse-menu-divider" role="separator" />
                            <button
                              type="button"
                              role="menuitem"
                              data-testid={`goal-rename-${goal.id}`}
                              onClick={() => { setOpenGoalMenuId(null); setRenameDraft(goal.title); setRenamingGoalId(goal.id); }}
                            >
                              <Pencil size={15} strokeWidth={1.8} />
                              <span>重命名</span>
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              data-testid={`goal-add-subgoal-${goal.id}`}
                              onClick={() => { setOpenGoalMenuId(null); patchBotUi({ activeGoalId: goal.id, activeGoalFocusSubGoal: true }); }}
                            >
                              <SquarePlus size={15} strokeWidth={1.8} />
                              <span>添加子目标</span>
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              data-testid={`goal-complete-${goal.id}`}
                              onClick={() => { setOpenGoalMenuId(null); void ctrl.updateGoal({ id: goal.id, status: "completed" }); }}
                            >
                              <SquareCheck size={15} strokeWidth={1.8} />
                              <span>已完成</span>
                            </button>
                            <div className="qj-muse-menu-divider" role="separator" />
                            <button
                              type="button"
                              role="menuitem"
                              className="is-danger"
                              data-testid={`goal-delete-${goal.id}`}
                              onClick={() => { setOpenGoalMenuId(null); void ctrl.deleteGoal(goal.id); }}
                            >
                              <Trash2 size={15} strokeWidth={1.8} />
                              <span>删除</span>
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="qj-muse-goals-block">
            <h2 className="qj-muse-group-heading">创建目标</h2>
            <div className="qj-muse-goal-cat-list">
              {GOAL_CATEGORIES.map(({ name, Icon }) => (
                <button
                  key={name}
                  type="button"
                  data-testid={`goal-cat-${name}`}
                  className={`qj-muse-goal-cat-row${selectedCat === name ? " active" : ""}`}
                  onClick={() => { setGoalTitle(""); setDirectInputOpen(false); setSelectedCat(name); }}
                >
                  <Icon size={17} strokeWidth={1.75} className="qj-muse-goal-cat-icon" />
                  <span className="qj-muse-goal-cat-name">{name}</span>
                  <ChevronRight size={15} strokeWidth={1.75} className="qj-muse-goal-cat-chevron" />
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>

      {selectedCat !== null && (
        <div className="qj-bot-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) closeInterviewModal(); }}>
          <div
            className="qj-bot-dialog qj-muse-goal-interview-modal"
            role="dialog"
            aria-modal="true"
            aria-label={interviewDialogTitle}
            data-testid="goal-interview-dialog"
          >
            <div className="qj-muse-dialog-top">
              <h2 className="qj-muse-dialog-heading">{interviewDialogTitle}</h2>
              <button
                type="button"
                className="qj-muse-dialog-close"
                aria-label="关闭"
                data-testid="goal-interview-close-btn"
                onClick={closeInterviewModal}
              >
                <X size={16} strokeWidth={1.9} />
              </button>
            </div>

            <p className="qj-muse-dialog-desc">
              首先，我们将在聊天中一起完善目标。我会问你几个问题，准确了解你的目标。目标确定后，我会在此处追踪你的进度。
            </p>

            <button
              type="button"
              className="qj-muse-cta-full-pill"
              data-testid="goal-interview-start-btn"
              onClick={handleStartGoalInterview}
            >
              <WandSparkles size={16} strokeWidth={1.9} />
              <span>立即开始</span>
            </button>

            <div className="qj-muse-goal-direct-zone">
              <button
                type="button"
                className="qj-muse-goal-direct-toggle"
                data-testid="goal-direct-toggle-btn"
                onClick={() => setDirectInputOpen((cur) => !cur)}
              >
                已知明确目标？直接快速录入
              </button>

              {directInputOpen && (
                <form className="qj-muse-goal-direct-form" onSubmit={(e) => void handleDirectCreateGoal(e)}>
                  <input
                    autoFocus
                    type="text"
                    placeholder={`输入「${selectedCat}」目标标题…`}
                    value={goalTitle}
                    onChange={(e) => setGoalTitle(e.target.value)}
                    className="qj-muse-goal-direct-input"
                    data-testid="goal-create-input"
                  />
                  <button
                    type="submit"
                    disabled={goalTitle.trim() === ""}
                    className="qj-muse-pill-primary is-sm"
                    data-testid="goal-create-submit-btn"
                  >
                    添加
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>
      )}

      <BotCompletedGoalsModal
        open={completedModalOpen}
        onClose={() => setCompletedModalOpen(false)}
        initialOpenMenuId={initialOpenCompletedMenuId}
        ctx={ctx}
      />

      <BotGoalDetailModal ctx={ctx} />
    </main>
  );
}
