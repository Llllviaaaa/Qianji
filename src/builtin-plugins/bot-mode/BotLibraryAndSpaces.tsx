/**
 * `资源库 (Library)` (with 220px sub-navigation across Spaces / Docs / Images /
 * Videos / Podcasts / System Files) and `创建空间 (Space Builder)` split creator.
 */
import { useState, type FormEvent, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { ArrowUpRight, FileText, FolderKanban, PanelRight, Plus, Sparkles } from "lucide-react";
import {
  openBotModal,
  patchBotUi,
  useBotController,
  useBotSnapshot,
  useBotUiState,
  type BotLibrarySection,
} from "./botStore";

const LIB_NAV_ITEMS: ReadonlyArray<{ readonly id: BotLibrarySection; readonly label: string }> = [
  { id: "spaces", label: "空间" },
  { id: "docs", label: "文档" },
  { id: "images", label: "图片" },
  { id: "videos", label: "视频" },
  { id: "podcasts", label: "播客" },
  { id: "system", label: "系统文件" },
];

export function BotLibraryView({ ctx }: { readonly ctx?: Context }): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);

  const filteredMedia = snapshot.media.filter((m) => m.kind === ui.libSection);

  return (
    <section className="qj-bot-main" aria-label="千机资源库">
      <header className="qj-bot-topbar" data-tauri-drag-region="">
        <div className="qj-bot-topbar-left">
          <span style={{ fontSize: 14, fontWeight: 600 }}>资源库</span>
        </div>
        <div className="qj-bot-topbar-right">
          <button
            type="button"
            className="qj-bot-pill-btn"
            onClick={() => patchBotUi({ activeView: "spaces" })}
          >
            <Plus size={14} />
            <span>创建空间</span>
          </button>
          <button
            type="button"
            className={`qj-bot-icon-btn${ui.rightPanelOpen ? " active" : ""}`}
            aria-label="切换右侧分身面板"
            onClick={() => patchBotUi({ rightPanelOpen: !ui.rightPanelOpen })}
          >
            <PanelRight size={15} />
          </button>
        </div>
      </header>

      <div className="qj-bot-lib-shell">
        <nav className="qj-bot-lib-nav" aria-label="资源库分类">
          {LIB_NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={ui.libSection === item.id ? "active" : undefined}
              onClick={() => patchBotUi({ libSection: item.id })}
            >
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="qj-bot-view-scroll">
          <div className="qj-bot-view-inner">
            {ui.libSection === "spaces" && (
              <>
                <div>
                  <h2 className="qj-bot-view-title">专题空间</h2>
                  <p className="qj-bot-view-sub">由分身持续整理的交互式看板、知识馆藏与迷你工具</p>
                </div>
                <div className="qj-bot-grid-2">
                  {snapshot.spaces.map((space) => (
                    <div key={space.id} className="qj-bot-soft-card">
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <strong style={{ fontSize: 14.5 }}>{space.title}</strong>
                        <span style={{ fontSize: 11.5, color: "var(--qj-text-muted)" }}>{space.metricBadge}</span>
                      </div>
                      <span style={{ fontSize: 13, color: "var(--qj-text-secondary)", lineHeight: 1.55 }}>
                        {space.description}
                      </span>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: 11.5, color: "var(--qj-text-muted)" }}>{space.updatedLabel}</span>
                        <button
                          type="button"
                          className="qj-bot-pill-btn"
                          onClick={() => ctrl.jumpToChatWithPrompt(`打开空间「${space.title}」并汇报最新动态。`)}
                        >
                          <span>进入空间</span>
                          <ArrowUpRight size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {ui.libSection === "docs" && (
              <>
                <div>
                  <h2 className="qj-bot-view-title">沉淀文档</h2>
                  <p className="qj-bot-view-sub">对话与后台调研自动归档的结构化文档</p>
                </div>
                {snapshot.documents.map((doc) => (
                  <div key={doc.id} className="qj-bot-soft-card">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
                        <FileText size={16} />
                        {doc.name}
                      </span>
                      <span style={{ fontSize: 12, color: "var(--qj-text-muted)" }}>
                        {doc.sizeLabel} · {doc.updatedLabel}
                      </span>
                    </div>
                    <pre
                      style={{
                        margin: 0,
                        whiteSpace: "pre-wrap",
                        fontFamily: "var(--qj-font-sans)",
                        fontSize: 13,
                        color: "var(--qj-text-secondary)",
                      }}
                    >
                      {doc.content}
                    </pre>
                  </div>
                ))}
              </>
            )}

            {(ui.libSection === "images" || ui.libSection === "videos" || ui.libSection === "podcasts") && (
              <>
                <div>
                  <h2 className="qj-bot-view-title">
                    {ui.libSection === "images" ? "图片素材" : ui.libSection === "videos" ? "视频剪辑" : "播客音频"}
                  </h2>
                  <p className="qj-bot-view-sub">分身生成或整理的多模态资料馆</p>
                </div>
                {filteredMedia.length === 0 ? (
                  <div className="qj-bot-soft-card">
                    <span style={{ color: "var(--qj-text-secondary)", fontSize: 13.5 }}>
                      暂无该分类媒体文件；你可以在主聊天中让{snapshot.profile.displayName}为你生成简报配图或音频播客。
                    </span>
                  </div>
                ) : (
                  <div className="qj-bot-grid-2">
                    {filteredMedia.map((m) => (
                      <div key={m.id} className="qj-bot-soft-card">
                        <strong>{m.title}</strong>
                        <span style={{ fontSize: 12, color: "var(--qj-text-muted)" }}>{m.updatedLabel}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {ui.libSection === "system" && (
              <>
                <div>
                  <h2 className="qj-bot-view-title">核心身份与记忆系统文件</h2>
                  <p className="qj-bot-view-sub">透明、可直接审阅与编辑的本地 Markdown 契约文件</p>
                </div>
                <div className="qj-bot-grid-2">
                  <div className="qj-bot-soft-card">
                    <strong>SOUL.md · 灵魂与行为契约</strong>
                    <span style={{ fontSize: 13, color: "var(--qj-text-secondary)" }}>
                      定义分身的性格语气、沟通节奏与外部动作安全边界（最近更新：{snapshot.soulUpdatedAt}）
                    </span>
                    <div>
                      <button type="button" className="qj-bot-pill-btn" onClick={() => openBotModal("soul")}>
                        查看与编辑 SOUL.md
                      </button>
                    </div>
                  </div>
                  <div className="qj-bot-soft-card">
                    <strong>MEMORY.md · 长期记忆账本</strong>
                    <span style={{ fontSize: 13, color: "var(--qj-text-secondary)" }}>
                      记录分身在长期陪伴中习得的偏好、背景事实与里程碑（最近更新：{snapshot.memoryUpdatedAt}）
                    </span>
                    <div>
                      <button type="button" className="qj-bot-pill-btn" onClick={() => openBotModal("memory")}>
                        审阅与编辑 MEMORY.md
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export function BotSpaceBuilderView({ ctx }: { readonly ctx?: Context }): ReactElement {
  const ui = useBotUiState();
  const ctrl = useBotController(ctx);
  const [title, setTitle] = useState("每周产品灵感与竞品雷达");
  const [description, setDescription] = useState(
    "自动汇总对话中的灵感火花、行业资讯与待验证假设，并以清爽卡片看板持续更新。",
  );

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await ctrl.createSpace(title, description);
  };

  return (
    <section className="qj-bot-main" aria-label="创建专题空间">
      <header className="qj-bot-topbar" data-tauri-drag-region="">
        <div className="qj-bot-topbar-left">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14, fontWeight: 600 }}>
            <FolderKanban size={16} />
            创建空间
          </span>
        </div>
        <div className="qj-bot-topbar-right">
          <button
            type="button"
            className={`qj-bot-icon-btn${ui.rightPanelOpen ? " active" : ""}`}
            aria-label="切换右侧分身面板"
            onClick={() => patchBotUi({ rightPanelOpen: !ui.rightPanelOpen })}
          >
            <PanelRight size={15} />
          </button>
        </div>
      </header>

      <div className="qj-bot-space-split">
        <form className="qj-bot-space-form" onSubmit={(e) => void handleSubmit(e)}>
          <div>
            <h2 className="qj-bot-view-title" style={{ fontSize: 19 }}>
              用一句话生成持久交互空间
            </h2>
            <p className="qj-bot-view-sub">创建后将保存在资源库「空间」分类中，供分身长期更新维护</p>
          </div>

          <div className="qj-bot-field">
            <label>空间名称</label>
            <input
              className="qj-bot-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="输入空间名称…"
            />
          </div>

          <div className="qj-bot-field">
            <label>目标与展示方式描述</label>
            <textarea
              className="qj-bot-textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="描述你希望千机如何收集、整理和呈现这个空间的数据…"
            />
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" className="qj-bot-task-handoff-btn">
              <Sparkles size={14} />
              <span>立即创建空间</span>
            </button>
            <button
              type="button"
              className="qj-bot-pill-btn"
              onClick={() => patchBotUi({ activeView: "library", libSection: "spaces" })}
            >
              返回资源库
            </button>
          </div>
        </form>

        <div className="qj-bot-space-preview">
          <div className="qj-bot-soft-card" style={{ width: "min(440px, 100%)", background: "var(--qj-bg-surface)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 11.5, color: "var(--qj-text-muted)" }}>实时预览 · 空间卡片</span>
              <span style={{ fontSize: 11.5, color: "var(--qj-status-success)" }}>● 自动持续同步</span>
            </div>
            <strong style={{ fontSize: 17 }}>{title || "未命名专题空间"}</strong>
            <p style={{ margin: 0, fontSize: 13.5, color: "var(--qj-text-secondary)", lineHeight: 1.6 }}>
              {description || "在左侧输入描述，预览空间结构…"}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
