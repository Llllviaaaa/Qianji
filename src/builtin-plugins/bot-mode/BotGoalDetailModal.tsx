/**
 * 1:1+ Meta Muse `目标详情` Modal & Month-Grouped `已完成的目标` Archive Modal
 * (`src/builtin-plugins/bot-mode/BotGoalDetailModal.tsx`).
 */
import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  ArrowUpRight, Check, CheckCircle2, Eye, MessageCircle,
  MoreHorizontal, Pencil, Plus, RotateCcw, SquareCheck, Trash2, X,
} from "lucide-react";
import {
  groupCompletedGoalsByMonth, groupGoalTimelineByDate,
  patchBotUi, useBotController, useBotSnapshot, useBotUiState,
} from "./botStore";

export function BotGoalDetailModal(props: {
  readonly ctx?: Context;
  readonly initialMenuOpen?: boolean;
  readonly initialEditingDesc?: boolean;
}): ReactElement | null {
  const { ctx, initialMenuOpen = false, initialEditingDesc = false } = props;
  const snapshot = useBotSnapshot();
  const ui = useBotUiState();
  const ctrl = useBotController(ctx);

  const goal = snapshot.goals.find((g) => g.id === ui.activeGoalId) ?? null;

  const [menuOpen, setMenuOpen] = useState(initialMenuOpen);
  const [editingDesc, setEditingDesc] = useState(initialEditingDesc);
  const [descDraft, setDescDraft] = useState("");
  const [subGoalDraft, setSubGoalDraft] = useState("");

  useEffect(() => {
    if (goal === null || typeof window === "undefined" || typeof document === "undefined") return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (menuOpen && target !== null && !target.closest(".qj-muse-goal-detail-menu-anchor")) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (menuOpen) setMenuOpen(false);
        else if (editingDesc) setEditingDesc(false);
        else patchBotUi({ activeGoalId: null, activeGoalFocusSubGoal: false });
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [goal, menuOpen, editingDesc]);

  if (goal === null) return null;

  const closeModal = () => {
    setMenuOpen(false);
    setEditingDesc(false);
    patchBotUi({ activeGoalId: null, activeGoalFocusSubGoal: false });
  };

  const statusText = goal.description || goal.summary;
  const subGoals = goal.subGoals ?? [];
  const doneCount = subGoals.filter((s) => s.done).length;
  const timelineGroups = groupGoalTimelineByDate(goal);

  const handleSaveDesc = async () => {
    const trimmed = descDraft.trim();
    await ctrl.updateGoal({
      id: goal.id,
      description: trimmed,
      ...(trimmed !== "" ? { summary: trimmed.slice(0, 140) } : {}),
    });
    setEditingDesc(false);
  };

  const handleAddSubGoal = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = subGoalDraft.trim();
    if (trimmed === "") return;
    setSubGoalDraft("");
    await ctrl.updateGoal({ id: goal.id, addSubGoal: trimmed });
  };

  const discussPrompt = `围绕目标「${goal.title}」（当前进展：${statusText || "刚创建，待拆解"}），帮我拆解关键步骤并推进下一步。`;

  return (
    <div className="qj-bot-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
      <div
        className="qj-bot-dialog qj-muse-goal-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label="目标详情"
        data-testid="goal-detail-modal"
      >
        <header className="qj-muse-goal-detail-head">
          <div className="qj-muse-goal-detail-titles">
            <h2 className="qj-muse-goal-detail-title">{goal.title}</h2>
            {goal.category && <span className="qj-muse-goal-cat-badge">{goal.category}</span>}
          </div>

          <div className="qj-muse-goal-detail-actions">
            <div className="qj-muse-goal-detail-menu-anchor">
              <button
                type="button"
                className="qj-muse-dialog-close"
                aria-label="目标详情更多操作"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                data-testid="goal-detail-more-btn"
                onClick={() => setMenuOpen((cur) => !cur)}
              >
                <MoreHorizontal size={16} strokeWidth={1.85} />
              </button>

              {menuOpen && (
                <div className="qj-muse-floating-menu" role="menu" aria-label="目标详情菜单">
                  <button type="button" role="menuitem" onClick={() => { closeModal(); ctrl.discussInBot(discussPrompt); }}>
                    <MessageCircle size={15} strokeWidth={1.8} />
                    <span>讨论</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      const nextStatus = goal.status === "completed" ? "active" : "completed";
                      void ctrl.updateGoal({ id: goal.id, status: nextStatus });
                      if (nextStatus === "completed") closeModal();
                    }}
                  >
                    <SquareCheck size={15} strokeWidth={1.8} />
                    <span>{goal.status === "completed" ? "重新激活目标" : "标记已完成"}</span>
                  </button>
                  {goal.handoff !== undefined && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        const handoff = goal.handoff;
                        closeModal();
                        if (handoff !== undefined) ctrl.triggerHandoff(handoff);
                      }}
                    >
                      <ArrowUpRight size={15} strokeWidth={1.8} />
                      <span>在工作台中打开</span>
                    </button>
                  )}
                  <div className="qj-muse-menu-divider" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    className="is-danger"
                    onClick={() => {
                      const idToDelete = goal.id;
                      closeModal();
                      void ctrl.deleteGoal(idToDelete);
                    }}
                  >
                    <Trash2 size={15} strokeWidth={1.8} />
                    <span>删除</span>
                  </button>
                </div>
              )}
            </div>

            <button
              type="button"
              className="qj-muse-dialog-close"
              aria-label="关闭"
              data-testid="goal-detail-close-btn"
              onClick={closeModal}
            >
              <X size={16} strokeWidth={1.9} />
            </button>
          </div>
        </header>

        <div className="qj-muse-goal-detail-scroll">
          <section className="qj-muse-goal-desc-section">
            {editingDesc ? (
              <div className="qj-muse-goal-desc-editor">
                <textarea
                  autoFocus
                  rows={3}
                  className="qj-muse-instructions-textarea"
                  data-testid="goal-desc-textarea"
                  value={descDraft}
                  onChange={(e) => setDescDraft(e.target.value)}
                  placeholder="补充目标背景、衡量标准或当前进展…"
                />
                <div className="qj-muse-goal-desc-editor-foot">
                  <button type="button" className="qj-muse-pill-secondary is-sm" onClick={() => setEditingDesc(false)}>
                    取消
                  </button>
                  <button type="button" className="qj-muse-pill-primary is-sm" data-testid="goal-desc-save-btn" onClick={() => void handleSaveDesc()}>
                    保存
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="qj-muse-goal-desc-trigger"
                data-testid="goal-desc-edit-trigger"
                onClick={() => { setDescDraft(statusText); setEditingDesc(true); }}
              >
                <span>{statusText || "点击补充目标背景与关键里程碑…"}</span>
                <Pencil size={13} strokeWidth={1.8} className="qj-muse-goal-desc-edit-icon" />
              </button>
            )}

            <div className="qj-muse-goal-detail-cta-row">
              <button
                type="button"
                className="qj-muse-subtle-pill-btn"
                data-testid="goal-detail-discuss-btn"
                onClick={() => { closeModal(); ctrl.discussInBot(discussPrompt); }}
              >
                <MessageCircle size={14} strokeWidth={1.85} />
                <span>在并排聊天中推进</span>
              </button>
            </div>
          </section>

          <section className="qj-muse-goal-sub-section" data-testid="goal-detail-subgoals">
            <div className="qj-muse-goal-section-head">
              <h3 className="qj-muse-goal-section-title">子目标</h3>
              {subGoals.length > 0 && (
                <span className="qj-muse-goal-progress-pill">{doneCount}/{subGoals.length}</span>
              )}
            </div>

            {subGoals.length > 0 && (
              <div className="qj-muse-subgoal-list">
                {subGoals.map((sg) => (
                  <div key={sg.id} className="qj-muse-subgoal-row">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={sg.done}
                      aria-label={`切换子目标 ${sg.title}`}
                      data-testid={`subgoal-toggle-${sg.id}`}
                      className={`qj-muse-goal-check${sg.done ? " is-checked" : ""}`}
                      onClick={() => void ctrl.updateGoal({ id: goal.id, toggleSubGoalId: sg.id })}
                    >
                      {sg.done && <Check size={11} strokeWidth={2.5} />}
                    </button>
                    <span className={`qj-muse-subgoal-title${sg.done ? " is-done" : ""}`}>{sg.title}</span>
                    <button
                      type="button"
                      className="qj-muse-subgoal-del"
                      aria-label={`删除子目标 ${sg.title}`}
                      data-testid={`subgoal-delete-${sg.id}`}
                      onClick={() => void ctrl.updateGoal({ id: goal.id, deleteSubGoalId: sg.id })}
                    >
                      <Trash2 size={13.5} strokeWidth={1.8} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <form className="qj-muse-subgoal-form" data-testid="subgoal-add-form" onSubmit={(e) => void handleAddSubGoal(e)}>
              <Plus size={14} strokeWidth={1.9} className="qj-muse-subgoal-plus" />
              <input
                key={ui.activeGoalFocusSubGoal ? "focus-subgoal" : "idle-subgoal"}
                autoFocus={ui.activeGoalFocusSubGoal}
                type="text"
                className="qj-muse-subgoal-input"
                data-testid="subgoal-add-input"
                placeholder="添加子目标步骤…"
                value={subGoalDraft}
                onChange={(e) => setSubGoalDraft(e.target.value)}
              />
              {subGoalDraft.trim() !== "" && (
                <button type="submit" className="qj-muse-pill-primary is-xs" data-testid="subgoal-add-submit">添加</button>
              )}
            </form>
          </section>

          <section className="qj-muse-goal-timeline-section" data-testid="goal-detail-timeline">
            <h3 className="qj-muse-goal-section-title">动态</h3>
            <div className="qj-muse-timeline-groups">
              {timelineGroups.map((group) => (
                <div key={group.label} className="qj-muse-timeline-group">
                  <div className="qj-muse-timeline-date">{group.label}</div>
                  <div className="qj-muse-timeline-items">
                    {group.items.map((entry) => (
                      <div key={entry.id} className="qj-muse-timeline-item">
                        <CheckCircle2 size={16} strokeWidth={1.9} className="qj-muse-timeline-check" />
                        <div className="qj-muse-timeline-copy">
                          <div className="qj-muse-timeline-title">{entry.title}</div>
                          {entry.detail !== "" && <div className="qj-muse-timeline-detail">{entry.detail}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export function BotCompletedGoalsModal(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly initialOpenMenuId?: string | null;
  readonly ctx?: Context;
}): ReactElement | null {
  const { open, onClose, initialOpenMenuId = null, ctx } = props;
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const [openRowMenuId, setOpenRowMenuId] = useState<string | null>(initialOpenMenuId);

  useEffect(() => {
    if (!open || openRowMenuId === null || typeof document === "undefined") return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target !== null && !target.closest(".qj-muse-completed-menu-anchor")) setOpenRowMenuId(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, openRowMenuId]);

  if (!open) return null;

  const monthGroups = groupCompletedGoalsByMonth(snapshot.goals);

  return (
    <div className="qj-bot-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="qj-bot-dialog qj-muse-completed-goals-modal"
        role="dialog"
        aria-modal="true"
        aria-label="已完成的目标"
        data-testid="completed-goals-modal"
      >
        <div className="qj-muse-dialog-top">
          <h2 className="qj-muse-dialog-heading">已完成的目标</h2>
          <button type="button" className="qj-muse-dialog-close" aria-label="关闭" onClick={onClose}>
            <X size={16} strokeWidth={1.9} />
          </button>
        </div>

        {monthGroups.length === 0 ? (
          <div className="qj-muse-completed-empty">暂无已完成的目标记录</div>
        ) : (
          <div className="qj-muse-completed-groups">
            {monthGroups.map((group) => (
              <div key={group.monthLabel} className="qj-muse-completed-month-group">
                <div className="qj-muse-completed-month-label">{group.monthLabel}</div>
                <div className="qj-muse-completed-list">
                  {group.items.map((cg) => {
                    const rowMenuOpen = openRowMenuId === cg.id;
                    return (
                      <div key={cg.id} className="qj-muse-completed-row" data-testid={`completed-goal-${cg.id}`}>
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked="true"
                          aria-label={`重新激活 ${cg.title}`}
                          data-testid={`completed-reactivate-${cg.id}`}
                          className="qj-muse-goal-check is-completed-blue"
                          onClick={() => void ctrl.updateGoal({ id: cg.id, status: "active" })}
                        >
                          <Check size={11} strokeWidth={2.6} />
                        </button>

                        <div className="qj-muse-completed-copy">
                          <div className="qj-muse-completed-title">{cg.title}</div>
                        </div>

                        <div className="qj-muse-completed-menu-anchor">
                          <button
                            type="button"
                            className={`qj-muse-row-more-btn${rowMenuOpen ? " active" : ""}`}
                            aria-label={`${cg.title}的选项`}
                            aria-haspopup="menu"
                            aria-expanded={rowMenuOpen}
                            data-testid={`completed-more-${cg.id}`}
                            onClick={() => setOpenRowMenuId((cur) => (cur === cg.id ? null : cg.id))}
                          >
                            <MoreHorizontal size={16} strokeWidth={1.85} />
                          </button>

                          {rowMenuOpen && (
                            <div className="qj-muse-floating-menu" role="menu" aria-label={`${cg.title}操作菜单`}>
                              <button
                                type="button"
                                role="menuitem"
                                data-testid={`completed-menu-reactivate-${cg.id}`}
                                onClick={() => { setOpenRowMenuId(null); void ctrl.updateGoal({ id: cg.id, status: "active" }); }}
                              >
                                <RotateCcw size={15} strokeWidth={1.8} />
                                <span>重新激活</span>
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                data-testid={`completed-menu-detail-${cg.id}`}
                                onClick={() => { setOpenRowMenuId(null); onClose(); patchBotUi({ activeGoalId: cg.id, activeGoalFocusSubGoal: false }); }}
                              >
                                <Eye size={15} strokeWidth={1.8} />
                                <span>查看详情</span>
                              </button>
                              <div className="qj-muse-menu-divider" role="separator" />
                              <button
                                type="button"
                                role="menuitem"
                                className="is-danger"
                                data-testid={`completed-delete-${cg.id}`}
                                onClick={() => { setOpenRowMenuId(null); void ctrl.deleteGoal(cg.id); }}
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
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
