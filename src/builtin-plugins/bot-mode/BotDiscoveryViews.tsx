/**
 * Discovery views for Qianji Bot Mode:
 * - `动态 (Feed)`: Proactive daily briefings & background insights
 * - `点子 (Ideas)`: Categorized starter inspiration cards
 * - `目标 (Goals)`: Persistent multi-day goal tracking & Agent Workbench handoff
 */
import { useState, type FormEvent, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { ArrowUpRight, Compass, Lightbulb, PanelRight, Plus, Sparkles, Target } from "lucide-react";
import { patchBotUi, useBotController, useBotSnapshot, useBotUiState } from "./botStore";

function DiscoveryTopbar({ title }: { readonly title: string }): ReactElement {
  const ui = useBotUiState();
  return (
    <header className="qj-bot-topbar" data-tauri-drag-region="">
      <div className="qj-bot-topbar-left">
        <span style={{ fontSize: 14, fontWeight: 600 }}>{title}</span>
      </div>
      <div className="qj-bot-topbar-right">
        <button
          type="button"
          className={`qj-bot-icon-btn${ui.rightPanelOpen ? " active" : ""}`}
          title={ui.rightPanelOpen ? "收起右侧分身面板" : "展开右侧分身面板"}
          aria-label="切换右侧分身面板"
          onClick={() => patchBotUi({ rightPanelOpen: !ui.rightPanelOpen })}
        >
          <PanelRight size={15} />
        </button>
      </div>
    </header>
  );
}

export function BotFeedView({ ctx }: { readonly ctx?: Context }): ReactElement {
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);

  return (
    <section className="qj-bot-main" aria-label="千机动态流">
      <DiscoveryTopbar title="动态" />
      <div className="qj-bot-view-scroll">
        <div className="qj-bot-view-inner">
          <div className="qj-bot-view-header">
            <div>
              <h2 className="qj-bot-view-title">主动动态与每日简报</h2>
              <p className="qj-bot-view-sub">
                {snapshot.profile.displayName}根据你的关注方向与长期目标主动沉淀的研究简报与提醒
              </p>
            </div>
          </div>

          {snapshot.feed.map((item) => (
            <article key={item.id} className="qj-bot-soft-card">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 620, fontSize: 15 }}>
                  <Compass size={16} />
                  {item.title}
                </span>
                <span style={{ fontSize: 12, color: "var(--qj-text-muted)" }}>{item.timeLabel}</span>
              </div>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, color: "var(--qj-text-secondary)" }}>
                {item.body}
              </p>
              <div>
                <button
                  type="button"
                  className="qj-bot-pill-btn"
                  onClick={() => ctrl.jumpToChatWithPrompt(item.seedPrompt)}
                >
                  <span>{item.actionLabel}</span>
                  <ArrowUpRight size={14} />
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function BotIdeasView({ ctx }: { readonly ctx?: Context }): ReactElement {
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);

  return (
    <section className="qj-bot-main" aria-label="灵感点子库">
      <DiscoveryTopbar title="点子" />
      <div className="qj-bot-view-scroll">
        <div className="qj-bot-view-inner">
          <div>
            <h2 className="qj-bot-view-title">一起探索新点子</h2>
            <p className="qj-bot-view-sub">点击任一卡片，直接带入主聊天与{snapshot.profile.displayName}展开推演</p>
          </div>

          {snapshot.ideaSections.map((section, idx) => (
            <div key={section.category ?? `sec-${idx}`} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {section.category && (
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--qj-text-secondary)" }}>
                  {section.category}
                </div>
              )}
              <div className="qj-bot-grid-2">
                {section.items.map((idea) => (
                  <button
                    key={idea.id}
                    type="button"
                    className="qj-bot-soft-card interactive"
                    style={{ border: 0, textAlign: "left" }}
                    onClick={() => ctrl.jumpToChatWithPrompt(idea.seedPrompt)}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 14 }}>
                      {idea.icon === "sparkles" ? <Sparkles size={16} /> : <Lightbulb size={16} />}
                      <span>{idea.title}</span>
                    </div>
                    <span style={{ fontSize: 13, lineHeight: 1.55, color: "var(--qj-text-secondary)" }}>
                      {idea.description}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function BotGoalsView({ ctx }: { readonly ctx?: Context }): ReactElement {
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("长期跟进");

  const handleAdd = async (event: FormEvent) => {
    event.preventDefault();
    if (title.trim() === "") return;
    await ctrl.createGoal(title, category);
    setTitle("");
    setAdding(false);
  };

  return (
    <section className="qj-bot-main" aria-label="长期目标追踪">
      <DiscoveryTopbar title="目标" />
      <div className="qj-bot-view-scroll">
        <div className="qj-bot-view-inner">
          <div className="qj-bot-view-header">
            <div>
              <h2 className="qj-bot-view-title">长期目标与里程碑</h2>
              <p className="qj-bot-view-sub">跨日、跨周持续委托分身跟进的目标列表</p>
            </div>
            <button type="button" className="qj-bot-pill-btn" onClick={() => setAdding((v) => !v)}>
              <Plus size={15} />
              <span>新建目标</span>
            </button>
          </div>

          {adding && (
            <form className="qj-bot-soft-card" onSubmit={(e) => void handleAdd(e)}>
              <div className="qj-bot-field">
                <label>目标名称</label>
                <input
                  className="qj-bot-input"
                  placeholder="例如：每周跟踪开源 Agent 框架演进并输出对比简报"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
              <div className="qj-bot-field">
                <label>分类标签</label>
                <input
                  className="qj-bot-input"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="submit" className="qj-bot-task-handoff-btn">
                  保存并启动追踪
                </button>
                <button type="button" className="qj-bot-pill-btn" onClick={() => setAdding(false)}>
                  取消
                </button>
              </div>
            </form>
          )}

          {snapshot.goals.map((goal) => {
            const handoff = goal.handoff;
            return (
            <div key={goal.id} className="qj-bot-soft-card">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontWeight: 620, fontSize: 15 }}>
                  <Target size={16} />
                  {goal.title}
                </span>
                <span style={{ fontSize: 12, color: "var(--qj-text-muted)" }}>{goal.category}</span>
              </div>
              <p style={{ margin: 0, fontSize: 13.5, color: "var(--qj-text-secondary)", lineHeight: 1.55 }}>
                {goal.summary}
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className="qj-bot-pill-btn"
                  onClick={() => ctrl.jumpToChatWithPrompt(`帮我汇报一下目标「${goal.title}」的最新进展与下一步建议。`)}
                >
                  在聊天中跟进
                </button>
                {handoff && (
                  <button
                    type="button"
                    className="qj-bot-task-handoff-btn"
                    onClick={() => ctrl.triggerHandoff(handoff)}
                  >
                    <span>切入工作台深加工</span>
                    <ArrowUpRight size={14} />
                  </button>
                )}
              </div>
            </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
