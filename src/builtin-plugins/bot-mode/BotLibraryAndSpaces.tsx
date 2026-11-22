/**
 * 1:1 High-Fidelity `资源库 (Library)` & `空间 (Spaces Canvas)` matching `qj-v6-4-library-spaces.png`.
 * Surfaces real workspace files from `<dataDir>/bot-workspace/` and real persisted Spaces.
 */
import { useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { Trash2 } from "lucide-react";
import {
  openBotModal,
  patchBotUi,
  useBotController,
  useBotSnapshot,
  useBotUiState,
  type BotLibrarySection,
} from "./botStore";

export function BotSpacesCanvas({
  ctx,
  inSplit,
}: {
  readonly ctx?: Context;
  readonly inSplit: boolean;
}): ReactElement {
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const [selecting, setSelecting] = useState(false);

  return (
    <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", background: "var(--qj-bg-app)" }}>
      <div style={{ height: 42, flexShrink: 0 }} data-tauri-drag-region="" />
      <div style={{ flex: "1 1 auto", overflowY: "auto", padding: "0 32px 48px" }}>
        <div style={{ maxWidth: 820, margin: "0 auto", display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <h1 style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em", margin: 0 }}>空间</h1>
            {!inSplit ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {snapshot.spaces.length > 0 && (
                  <button
                    type="button"
                    className="qj-soft-btn"
                    style={{ height: 36, padding: "0 16px", fontSize: 13.5, fontWeight: 500 }}
                    onClick={() => setSelecting((v) => !v)}
                  >
                    {selecting ? "完成" : "选择"}
                  </button>
                )}
                <button
                  type="button"
                  className="qj-primary-pill-btn"
                  style={{ height: 36, padding: "0 16px", fontSize: 13.5, fontWeight: 500 }}
                  onClick={() =>
                    patchBotUi({ activeView: "spaces", composerDraft: "我想创建一个空间，关于 " })
                  }
                >
                  ＋ 创建空间
                </button>
              </div>
            ) : (
              <span
                style={{
                  fontSize: 12,
                  padding: "4px 12px",
                  borderRadius: 9999,
                  background: "var(--muse-soft-fill)",
                  color: "var(--qj-text-secondary)",
                }}
              >
                在左侧对话输入主题即可实时生成空间
              </span>
            )}
          </div>

          {snapshot.spaces.length === 0 ? (
            <div
              style={{
                padding: "56px 24px",
                borderRadius: 22,
                background: "var(--muse-soft-fill)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                textAlign: "center",
                gap: 12,
              }}
            >
              <div style={{ fontSize: 16, fontWeight: 500 }}>还没有创建常驻空间</div>
              <div style={{ fontSize: 13.5, color: "var(--qj-text-secondary)", maxWidth: 400, lineHeight: 1.6 }}>
                空间是可以持续更新的主题看板、资料馆或追踪工具。在左侧输入一句描述即可创建你的第一个空间。
              </div>
              {!inSplit && (
                <button
                  type="button"
                  className="qj-primary-pill-btn"
                  style={{ height: 36, padding: "0 18px", fontSize: 13.5, fontWeight: 500, marginTop: 4 }}
                  onClick={() =>
                    patchBotUi({ activeView: "spaces", composerDraft: "我想创建一个空间，关于 " })
                  }
                >
                  ＋ 创建第一个空间
                </button>
              )}
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(310px, 1fr))", gap: 16 }}>
              {snapshot.spaces.map((sp) => (
                <div
                  key={sp.id}
                  onClick={() => {
                    if (selecting) return;
                    patchBotUi({ activeSpace: sp });
                    openBotModal("space-detail");
                  }}
                  style={{
                    padding: 20,
                    borderRadius: 20,
                    background: "var(--muse-soft-fill)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                    cursor: selecting ? "default" : "pointer",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, color: "var(--qj-text-muted)" }}>
                    <span>常驻空间</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span>{sp.updatedLabel}</span>
                      {selecting && (
                        <button
                          type="button"
                          className="qj-msg-action-btn"
                          title="删除空间"
                          onClick={(e) => {
                            e.stopPropagation();
                            void ctrl.deleteSpace(sp.id);
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                  <div style={{ fontSize: 16.5, fontWeight: 600 }}>{sp.title}</div>
                  <div style={{ fontSize: 13.5, lineHeight: 1.58, color: "var(--qj-text-secondary)" }}>
                    {sp.description}
                  </div>
                  <div style={{ paddingTop: 4, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span
                      style={{
                        padding: "4px 10px",
                        borderRadius: 9999,
                        fontSize: 12,
                        fontWeight: 500,
                        background: "var(--qj-bg-surface)",
                      }}
                    >
                      {sp.metricBadge}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 500, color: "var(--qj-brand-primary)" }}>
                      打开看板 ↗
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const NAV_GROUPS: ReadonlyArray<{
  readonly label: string;
  readonly items: ReadonlyArray<{ readonly id: BotLibrarySection; readonly name: string }>;
}> = [
  {
    label: "文件",
    items: [
      { id: "spaces", name: "空间" },
      { id: "docs", name: "文档" },
    ],
  },
  {
    label: "影音内容",
    items: [
      { id: "images", name: "图片" },
      { id: "videos", name: "视频" },
      { id: "podcasts", name: "播客" },
    ],
  },
];

export function BotLibraryView({ ctx }: { readonly ctx?: Context }): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();

  const mediaList = snapshot.media.filter((m) => m.kind === ui.libSection);
  const mediaTitleMap: Record<string, string> = { images: "图片", videos: "视频", podcasts: "播客" };

  return (
    <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", background: "var(--qj-bg-app)" }}>
      <aside
        style={{
          width: 224,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "16px 12px",
          borderRight: "1px solid var(--qj-border-default)",
          fontSize: 13.5,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 20, paddingTop: 4 }}>
          {NAV_GROUPS.map((group) => (
            <div key={group.label} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ padding: "4px 12px", fontSize: 12, fontWeight: 500, color: "var(--qj-text-muted)" }}>
                {group.label}
              </div>
              {group.items.map((it) => {
                const active = ui.libSection === it.id;
                return (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => patchBotUi({ libSection: it.id })}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      padding: "8px 12px",
                      border: 0,
                      borderRadius: 12,
                      cursor: "pointer",
                      background: active ? "var(--muse-soft-fill)" : "transparent",
                      fontWeight: active ? 550 : 400,
                      color: "var(--qj-text-primary)",
                      fontSize: 13.5,
                    }}
                  >
                    {it.name}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() => patchBotUi({ libSection: "sysfiles" })}
          style={{
            width: "100%",
            textAlign: "left",
            padding: "8px 12px",
            border: 0,
            borderRadius: 12,
            cursor: "pointer",
            background: ui.libSection === "sysfiles" ? "var(--muse-soft-fill)" : "transparent",
            fontWeight: ui.libSection === "sysfiles" ? 550 : 400,
            color: "var(--qj-text-primary)",
            fontSize: 13.5,
          }}
        >
          系统文件
        </button>
      </aside>

      {ui.libSection === "spaces" && <BotSpacesCanvas ctx={ctx} inSplit={false} />}

      {ui.libSection === "docs" && (
        <div className="qj-animate-page-in" style={{ flex: "1 1 auto", display: "flex", flexDirection: "column" }}>
          <div style={{ height: 42, flexShrink: 0 }} data-tauri-drag-region="" />
          <div style={{ flex: "1 1 auto", overflowY: "auto", padding: "0 32px 48px" }}>
            <div style={{ maxWidth: 820, margin: "0 auto", display: "flex", flexDirection: "column", gap: 24 }}>
              <h1 style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em", margin: 0 }}>文档</h1>
              {snapshot.documents.length === 0 ? (
                <div style={{ padding: "56px 24px", textAlign: "center", color: "var(--qj-text-secondary)" }}>
                  <div style={{ fontSize: 15, fontWeight: 500, color: "var(--qj-text-primary)" }}>还没有归档文档</div>
                  <div style={{ fontSize: 12.5, marginTop: 6 }}>
                    分身在虚拟服务器工作目录中生成的报告与笔记会自动呈现在这里
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {snapshot.documents.map((doc) => (
                    <div
                      key={doc.id}
                      onClick={() => {
                        patchBotUi({ activeDoc: doc });
                        openBotModal("doc-preview");
                      }}
                      style={{
                        padding: 16,
                        borderRadius: 16,
                        background: "var(--muse-soft-fill)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        cursor: "pointer",
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 14.5, fontWeight: 500 }}>{doc.name}</div>
                        <div style={{ fontSize: 12, color: "var(--qj-text-muted)", marginTop: 2 }}>
                          更新于 {doc.updatedLabel} · {doc.sizeLabel}
                        </div>
                      </div>
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 500,
                          padding: "6px 12px",
                          borderRadius: 9999,
                          background: "var(--qj-bg-surface)",
                        }}
                      >
                        查看文档
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {ui.libSection === "sysfiles" && (
        <div className="qj-animate-page-in" style={{ flex: "1 1 auto", display: "flex", flexDirection: "column" }}>
          <div style={{ height: 42, flexShrink: 0 }} data-tauri-drag-region="" />
          <div style={{ flex: "1 1 auto", overflowY: "auto", padding: "0 32px 48px" }}>
            <div style={{ maxWidth: 820, margin: "0 auto", display: "flex", flexDirection: "column", gap: 24 }}>
              <h1 style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em", margin: 0 }}>系统文件</h1>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
                <button
                  type="button"
                  onClick={() => openBotModal("soul")}
                  style={{
                    padding: 20,
                    borderRadius: 20,
                    border: 0,
                    background: "var(--muse-soft-fill)",
                    color: "var(--qj-text-primary)",
                    textAlign: "left",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontSize: 16, fontWeight: 600 }}>SOUL.md</div>
                  <div style={{ fontSize: 12.5, color: "var(--qj-text-secondary)" }}>
                    核心人格、语气边界与安全准则 · 请谨慎访问
                  </div>
                  <div style={{ fontSize: 12, color: "var(--qj-text-muted)", paddingTop: 8 }}>
                    {snapshot.soulUpdatedAt}
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => openBotModal("memory")}
                  style={{
                    padding: 20,
                    borderRadius: 20,
                    border: 0,
                    background: "var(--muse-soft-fill)",
                    color: "var(--qj-text-primary)",
                    textAlign: "left",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontSize: 16, fontWeight: 600 }}>MEMORY.md</div>
                  <div style={{ fontSize: 12.5, color: "var(--qj-text-secondary)" }}>
                    长期工作习惯、关注偏好与事实档案 · 请谨慎访问
                  </div>
                  <div style={{ fontSize: 12, color: "var(--qj-text-muted)", paddingTop: 8 }}>
                    {snapshot.memoryUpdatedAt}
                  </div>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {(ui.libSection === "images" || ui.libSection === "videos" || ui.libSection === "podcasts") && (
        <div className="qj-animate-page-in" style={{ flex: "1 1 auto", display: "flex", flexDirection: "column" }}>
          <div style={{ height: 42, flexShrink: 0 }} data-tauri-drag-region="" />
          <div style={{ flex: "1 1 auto", display: "flex", flexDirection: "column", padding: "0 32px 48px" }}>
            <h1 style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em", margin: 0 }}>
              {mediaTitleMap[ui.libSection]}
            </h1>
            {mediaList.length === 0 ? (
              <div style={{ flex: "1 1 auto", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, color: "var(--qj-text-secondary)" }}>
                <div style={{ fontSize: 15, fontWeight: 500, color: "var(--qj-text-primary)" }}>
                  还没有{mediaTitleMap[ui.libSection]}
                </div>
                <div style={{ fontSize: 12.5 }}>
                  在聊天中生成或收藏的{mediaTitleMap[ui.libSection]}会自动归档在这里
                </div>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 14, marginTop: 24 }}>
                {mediaList.map((m) => (
                  <div key={m.id} style={{ padding: 16, borderRadius: 16, background: "var(--muse-soft-fill)" }}>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{m.title}</div>
                    <div style={{ fontSize: 12, color: "var(--qj-text-muted)", marginTop: 4 }}>{m.updatedLabel}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
