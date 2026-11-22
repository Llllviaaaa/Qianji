/**
 * 1:1 High-Fidelity Discovery Views (`动态` / `点子` / `目标`) for Qianji Bot Mode.
 * Zero fake pre-seeded user records: Feed & Goals start clean with real creation actions.
 */
import { useState, type FormEvent, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { Trash2 } from "lucide-react";
import { BotIcon } from "./BotAvatarArt";
import { patchBotUi, useBotController, useBotSnapshot, useBotUiState } from "./botStore";

function RightToggleTopbar(): ReactElement {
  const ui = useBotUiState();
  return (
    <div className="qj-bot-topbar" data-tauri-drag-region="">
      <div />
      <div className="qj-bot-topbar-right">
        <button
          type="button"
          title={ui.rightPanelOpen ? "收起陪伴面板" : "展开陪伴面板"}
          aria-label="切换右侧陪伴面板"
          onClick={() => patchBotUi({ rightPanelOpen: !ui.rightPanelOpen })}
          className="qj-muse-glass-pill"
          style={{
            width: 32,
            height: 32,
            padding: 0,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: ui.rightPanelOpen ? "var(--qj-text-primary)" : "var(--qj-text-secondary)",
            cursor: "pointer",
          }}
        >
          <BotIcon name="panelRight" />
        </button>
      </div>
    </div>
  );
}

export function BotFeedView({ ctx }: { readonly ctx?: Context }): ReactElement {
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);

  return (
    <main className="qj-animate-page-in" style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", background: "var(--qj-bg-app)" }}>
      <RightToggleTopbar />
      <div style={{ flex: "1 1 auto", overflowY: "auto", padding: "0 32px 48px" }}>
        <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 28 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <h1 style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em", margin: 0 }}>动态</h1>
            <button
              type="button"
              className="qj-soft-btn"
              style={{ height: 34, padding: "0 16px", fontSize: 13, fontWeight: 500 }}
              onClick={() => ctrl.jumpToChatWithPrompt("帮我巡检当前工作区与关注事项，生成一份今日动态简报。")}
            >
              请千机生成今日简报
            </button>
          </div>

          {snapshot.feed.length === 0 ? (
            <div
              style={{
                padding: "48px 24px",
                borderRadius: 22,
                background: "var(--muse-soft-fill)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                textAlign: "center",
                gap: 10,
              }}
            >
              <div style={{ fontSize: 15.5, fontWeight: 500 }}>还没有主动动态简报</div>
              <div style={{ fontSize: 13.5, color: "var(--qj-text-secondary)", maxWidth: 420, lineHeight: 1.6 }}>
                当你开启定时巡检或在对话中让{snapshot.profile.displayName}持续跟进某项议题时，整理好的动态卡片会按时间呈现在这里。
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {snapshot.feed.map((f, idx) => (
                <article
                  key={f.id}
                  style={{
                    padding: idx === 0 ? "0 0 20px" : "20px 0",
                    borderTop: idx === 0 ? "none" : "1px solid var(--qj-border-default)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
                    <h2 style={{ fontSize: 17, fontWeight: 500, margin: 0 }}>{f.title}</h2>
                    <span style={{ fontSize: 12, color: "var(--qj-text-muted)", flexShrink: 0 }}>{f.timeLabel}</span>
                  </div>
                  <p style={{ fontSize: 15, lineHeight: 1.62, margin: 0, color: "var(--qj-text-secondary)" }}>
                    {f.body}
                  </p>
                  <div style={{ paddingTop: 4 }}>
                    <button
                      type="button"
                      className="qj-soft-btn"
                      style={{ height: 32, padding: "0 16px", fontSize: 12, fontWeight: 500 }}
                      onClick={() => ctrl.jumpToChatWithPrompt(f.seedPrompt)}
                    >
                      {f.actionLabel}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

export function BotIdeasView({ ctx }: { readonly ctx?: Context }): ReactElement {
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);

  return (
    <main className="qj-animate-page-in" style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", background: "var(--qj-bg-app)" }}>
      <RightToggleTopbar />
      <div style={{ flex: "1 1 auto", overflowY: "auto", padding: "0 32px 48px" }}>
        <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <h1 style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em", margin: 0 }}>点子</h1>
            <p style={{ fontSize: 15.5, margin: 0, color: "var(--qj-text-secondary)" }}>
              我一直在思考各种新奇的方式来帮你。我会把我觉得超棒的点子放在这里。
            </p>
          </div>

          {snapshot.ideaSections.map((sec, idx) => (
            <section key={sec.category ?? `top-${idx}`} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {sec.category && (
                <h2 style={{ fontSize: 16, fontWeight: 600, paddingTop: 8, margin: 0 }}>{sec.category}</h2>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {sec.items.map((it) => (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => ctrl.jumpToChatWithPrompt(it.seedPrompt)}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 14,
                      padding: 12,
                      margin: "0 -12px",
                      border: 0,
                      borderRadius: 16,
                      background: "transparent",
                      color: "var(--qj-text-primary)",
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "var(--muse-soft-fill)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <div
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 12,
                        background: "var(--muse-soft-fill)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                        fontSize: 14,
                        fontWeight: 600,
                        marginTop: 2,
                      }}
                    >
                      {it.icon}
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 15.5, fontWeight: 500, lineHeight: 1.38 }}>{it.title}</div>
                      <div style={{ fontSize: 13.5, lineHeight: 1.58, color: "var(--qj-text-secondary)", marginTop: 2 }}>
                        {it.description}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}

const GOAL_CATEGORIES = ["职业与研发", "效率提升", "金融", "健康", "人际关系", "兴趣", "其他"] as const;

export function BotGoalsView({ ctx }: { readonly ctx?: Context }): ReactElement {
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const [selectedCat, setSelectedCat] = useState<string | null>(null);
  const [goalTitle, setGoalTitle] = useState("");

  const handleCreateGoal = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedCat || goalTitle.trim() === "") return;
    await ctrl.createGoal(goalTitle, selectedCat);
    setGoalTitle("");
    setSelectedCat(null);
  };

  return (
    <main className="qj-animate-page-in" style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", background: "var(--qj-bg-app)" }}>
      <RightToggleTopbar />
      <div style={{ flex: "1 1 auto", overflowY: "auto", padding: "0 32px 48px" }}>
        <div style={{ maxWidth: 700, margin: "0 auto", display: "flex", flexDirection: "column", gap: 28 }}>
          <h1 style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em", margin: 0 }}>目标</h1>

          <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>追踪</h2>
            {snapshot.goals.length === 0 ? (
              <div
                style={{
                  padding: "20px 18px",
                  borderRadius: 18,
                  background: "var(--muse-soft-fill)",
                  color: "var(--qj-text-secondary)",
                  fontSize: 13.5,
                }}
              >
                暂无正在追踪的目标 · 点击下方分类即可创建需要长期跟进的目标。
              </div>
            ) : (
              snapshot.goals.map((goal) => {
                const handoff = goal.handoff;
                return (
                  <div
                    key={goal.id}
                    style={{
                      padding: 16,
                      borderRadius: 18,
                      background: "var(--muse-soft-fill)",
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 14,
                    }}
                  >
                    <div
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: "9999px",
                        background: "var(--qj-bg-surface)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      <BotIcon name="checkCircle" />
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 15.5, fontWeight: 500 }}>{goal.title}</div>
                      <div style={{ fontSize: 13.5, color: "var(--qj-text-secondary)", marginTop: 2 }}>
                        {goal.category} · {goal.summary}
                      </div>
                      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                        <button
                          type="button"
                          className="qj-soft-btn"
                          style={{ height: 28, padding: "0 12px", fontSize: 12, background: "var(--qj-bg-surface)" }}
                          onClick={() => ctrl.jumpToChatWithPrompt(`帮我梳理目标「${goal.title}」的拆解步骤与近期进展。`)}
                        >
                          在聊天中推进
                        </button>
                        {handoff && (
                          <button
                            type="button"
                            className="qj-primary-pill-btn"
                            style={{ height: 28, padding: "0 12px", fontSize: 12 }}
                            onClick={() => ctrl.triggerHandoff(handoff)}
                          >
                            在工作台中打开
                          </button>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="qj-msg-action-btn"
                      title="删除目标"
                      onClick={() => void ctrl.deleteGoal(goal.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })
            )}
          </section>

          {selectedCat !== null && (
            <form
              onSubmit={(e) => void handleCreateGoal(e)}
              style={{
                padding: 16,
                borderRadius: 18,
                background: "var(--muse-soft-fill)",
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>新建目标 · {selectedCat}</div>
              <input
                autoFocus
                type="text"
                placeholder="输入你想持续追踪的目标名称…"
                value={goalTitle}
                onChange={(e) => setGoalTitle(e.target.value)}
                style={{
                  width: "100%",
                  padding: "9px 12px",
                  borderRadius: 12,
                  border: "1px solid var(--qj-border-default)",
                  background: "var(--qj-bg-surface)",
                  color: "var(--qj-text-primary)",
                  fontSize: 14,
                  outline: "none",
                }}
              />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="qj-soft-btn"
                  style={{ height: 32, padding: "0 14px", fontSize: 12.5, background: "var(--qj-bg-surface)" }}
                  onClick={() => setSelectedCat(null)}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="qj-primary-pill-btn"
                  style={{ height: 32, padding: "0 16px", fontSize: 12.5 }}
                >
                  创建目标
                </button>
              </div>
            </form>
          )}

          <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>创建目标</h2>
            <div style={{ borderRadius: 18, overflow: "hidden", background: "var(--muse-soft-fill)" }}>
              {GOAL_CATEGORIES.map((cat, idx) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setSelectedCat(cat)}
                  style={{
                    width: "100%",
                    height: 48,
                    padding: "0 16px",
                    border: 0,
                    borderTop: idx === 0 ? "none" : "1px solid var(--qj-border-default)",
                    background: "transparent",
                    color: "var(--qj-text-primary)",
                    fontSize: 15,
                    fontWeight: 500,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    cursor: "pointer",
                  }}
                >
                  <span>{cat}</span>
                  <span style={{ color: "var(--qj-text-secondary)" }}>＋</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
