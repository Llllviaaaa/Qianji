/** Modal overlays for Qianji Bot Mode (`src/builtin-plugins/bot-mode/BotModals.tsx`). */
import { useEffect, useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { useFrontendService } from "@qianji/client";
import { BotIcon } from "./BotAvatarArt";
import { BotSearchDialog } from "./BotSearchDialog";
import { BotSettingsPaneContent } from "./BotSettingsPanes";
import {
  openBotModal,
  patchBotUi,
  useBotController,
  useBotSnapshot,
  useBotUiState,
  type BotSettingsTab,
} from "./botStore";

const SETTINGS_TABS: ReadonlyArray<{ readonly id: BotSettingsTab; readonly name: string }> = [
  { id: "general", name: "通用" },
  { id: "server", name: "虚拟服务器" },
  { id: "browser", name: "浏览器" },
  { id: "connectors", name: "连接器" },
  { id: "vault", name: "安全存储" },
  { id: "permissions", name: "权限" },
  { id: "channels", name: "消息渠道" },
  { id: "data", name: "数据控制" },
  { id: "voice", name: "声音和虚拟形象" },
];

function CloseCircleBtn({ label, onClick }: { readonly label: string; readonly onClick: () => void }): ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={{
        width: 32,
        height: 32,
        borderRadius: 9999,
        border: 0,
        background: "transparent",
        color: "var(--qj-text-secondary)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
      }}
    >
      <BotIcon name="closeX" />
    </button>
  );
}

function MarkdownContractEditor({
  title,
  initialValue,
  onSave,
  onClose,
}: {
  readonly title: string;
  readonly initialValue: string;
  readonly onSave: (next: string) => void;
  readonly onClose: () => void;
}): ReactElement {
  const [draft, setDraft] = useState(initialValue);

  return (
    <div
      className="qj-bot-dialog"
      style={{ width: 560, maxWidth: "92vw", padding: 24, display: "flex", flexDirection: "column", gap: 16 }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{title}</div>
          <div style={{ fontSize: 12, color: "var(--qj-text-secondary)", marginTop: 2 }}>
            请谨慎编辑 · 修改后将同步至千机长期记忆上下文
          </div>
        </div>
        <CloseCircleBtn label="关闭编辑器" onClick={onClose} />
      </div>

      <textarea
        rows={9}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        style={{
          width: "100%",
          padding: 14,
          borderRadius: 16,
          border: 0,
          outline: "none",
          resize: "vertical",
          fontFamily: "var(--qj-font-mono)",
          fontSize: 12,
          lineHeight: 1.65,
          background: "var(--muse-soft-fill)",
          color: "var(--qj-text-primary)",
        }}
      />

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button
          type="button"
          className="qj-soft-btn"
          style={{ height: 36, padding: "0 16px", fontSize: 12, fontWeight: 520 }}
          onClick={onClose}
        >
          取消
        </button>
        <button
          type="button"
          className="qj-primary-pill-btn"
          style={{ height: 36, padding: "0 20px", fontSize: 12, fontWeight: 520 }}
          onClick={() => onSave(draft)}
        >
          保存
        </button>
      </div>
    </div>
  );
}

export function BotModals({ ctx }: { readonly ctx?: Context }): ReactElement | null {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const navigationService = useFrontendService("navigationService", ctx);
  const [issueText, setIssueText] = useState("");

  useEffect(() => {
    if (ui.modal === null || typeof window === "undefined") return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        patchBotUi({ modal: null });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ui.modal]);

  if (ui.modal === null) return null;

  const closeModal = () => patchBotUi({ modal: null });

  if (ui.modal === "search") {
    return <BotSearchDialog key={`search-${ui.modalNonce}`} ctx={ctx} onClose={closeModal} />;
  }

  if (ui.modal === "soul" || ui.modal === "memory") {
    const isSoul = ui.modal === "soul";
    return (
      <div className="qj-bot-modal-backdrop" onClick={closeModal}>
        <MarkdownContractEditor
          key={`${ui.modal}-${ui.modalNonce}`}
          title={isSoul ? "SOUL.md" : "记忆 (MEMORY.md)"}
          initialValue={isSoul ? snapshot.soulContent : ui.memoryContent}
          onClose={closeModal}
          onSave={(next) => {
            if (isSoul) {
              void ctrl.saveSoul(next);
            } else {
              void ctrl.saveMemory(next);
            }
            closeModal();
          }}
        />
      </div>
    );
  }

  if (ui.modal === "shortcuts") {
    const rows: ReadonlyArray<readonly [string, string]> = [
      ["展开 / 收起旁聊抽屉", "Ctrl + J"],
      ["全局搜索", "Ctrl + K"],
      ["打开设置", "Ctrl + ,"],
      ["丝滑切换 Agent / Bot", "Ctrl + Shift + M"],
      ["紧急安全模式（暂停外部插件）", "Ctrl + Shift + Alt + R"],
    ];
    return (
      <div className="qj-bot-modal-backdrop" onClick={closeModal}>
        <div
          className="qj-bot-dialog"
          style={{ width: 420, maxWidth: "92vw", padding: 24, display: "flex", flexDirection: "column", gap: 16 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 16, fontWeight: 600 }}>键盘快捷键</span>
            <CloseCircleBtn label="关闭快捷键" onClick={closeModal} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }}>
            {rows.map(([label, chord]) => (
              <div
                key={label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "8px 12px",
                  borderRadius: 12,
                  background: "var(--muse-soft-fill)",
                }}
              >
                <span>{label}</span>
                <kbd
                  style={{
                    fontFamily: "var(--qj-font-mono)",
                    padding: "2px 8px",
                    borderRadius: 6,
                    background: "var(--qj-bg-surface)",
                  }}
                >
                  {chord}
                </kbd>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (ui.modal === "live-view") {
    return (
      <div className="qj-bot-modal-backdrop" onClick={closeModal}>
        <div
          className="qj-bot-dialog"
          style={{ width: 560, maxWidth: "92vw", padding: 24, display: "flex", flexDirection: "column", gap: 16 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 16, fontWeight: 600 }}>虚拟服务器实时画面 · 受控工作环境</span>
            <CloseCircleBtn label="关闭画面" onClick={closeModal} />
          </div>
          <div
            style={{
              minHeight: 200,
              padding: 24,
              borderRadius: 18,
              background: "var(--muse-soft-fill)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              textAlign: "center",
              gap: 8,
            }}
          >
            <BotIcon name="tabShield" />
            <strong style={{ fontSize: 14 }}>当前受控运行环境处于安全待命状态</strong>
            <span style={{ fontSize: 12.5, color: "var(--qj-text-secondary)", maxWidth: 400, lineHeight: 1.6 }}>
              当分身在虚拟服务器中访问网页遇到登录授权或人机验证时，将在此窗口暂停并请求你手动完成验证，绝不私自绕过安全门禁。
            </span>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              className="qj-soft-btn"
              style={{ height: 34, padding: "0 14px", fontSize: 12, fontWeight: 520 }}
              onClick={() => openBotModal("settings", "server")}
            >
              返回虚拟服务器设置
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (ui.modal === "doc-preview" && ui.activeDoc !== null) {
    const doc = ui.activeDoc;
    return (
      <div className="qj-bot-modal-backdrop" onClick={closeModal}>
        <div
          className="qj-bot-dialog"
          style={{ width: 620, maxWidth: "92vw", padding: 24, display: "flex", flexDirection: "column", gap: 16 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 17, fontWeight: 600 }}>{doc.name}</div>
              <div style={{ fontSize: 12, color: "var(--qj-text-secondary)", marginTop: 2 }}>
                {doc.sizeLabel} · {doc.updatedLabel}
              </div>
            </div>
            <CloseCircleBtn label="关闭文档预览" onClick={closeModal} />
          </div>
          <pre
            style={{
              margin: 0,
              maxHeight: 340,
              overflow: "auto",
              padding: 16,
              borderRadius: 16,
              background: "var(--muse-soft-fill)",
              fontFamily: "var(--qj-font-mono)",
              fontSize: 12,
              lineHeight: 1.65,
              whiteSpace: "pre-wrap",
            }}
          >
            {doc.content}
          </pre>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            {doc.path && (
              <button
                type="button"
                className="qj-primary-pill-btn"
                style={{ height: 34, padding: "0 16px", fontSize: 12, fontWeight: 520 }}
                onClick={() => {
                  closeModal();
                  ctrl.triggerHandoff({
                    id: `doc-${doc.id}`,
                    title: doc.name,
                    kindLabel: "沉淀文档",
                    summary: `从 Bot 资源库打开文档：${doc.name}`,
                    targetCwd: "",
                    highlightFile: doc.path,
                  });
                }}
              >
                在 Agent 工作台中打开
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (ui.modal === "space-detail" && ui.activeSpace !== null) {
    const sp = ui.activeSpace;
    return (
      <div className="qj-bot-modal-backdrop" onClick={closeModal}>
        <div
          className="qj-bot-dialog"
          style={{ width: 580, maxWidth: "92vw", padding: 24, display: "flex", flexDirection: "column", gap: 16 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 600 }}>{sp.title}</div>
              <div style={{ fontSize: 12, color: "var(--qj-text-secondary)", marginTop: 2 }}>
                创建/更新于 {sp.updatedLabel}
              </div>
            </div>
            <CloseCircleBtn label="关闭空间详情" onClick={closeModal} />
          </div>
          <div style={{ padding: 16, borderRadius: 18, background: "var(--muse-soft-fill)", fontSize: 13.5, lineHeight: 1.65 }}>
            {sp.description}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              type="button"
              className="qj-soft-btn"
              style={{ height: 36, padding: "0 16px", fontSize: 12, fontWeight: 520 }}
              onClick={() => ctrl.jumpToChatWithPrompt(`继续推进空间「${sp.title}」的下一步计划：`)}
            >
              在主聊天中推进
            </button>
            <button
              type="button"
              className="qj-primary-pill-btn"
              style={{ height: 36, padding: "0 18px", fontSize: 12, fontWeight: 520 }}
              onClick={() => {
                closeModal();
                ctrl.triggerHandoff(
                  sp.handoff ?? {
                    id: sp.id,
                    title: sp.title,
                    kindLabel: "常驻空间",
                    summary: sp.description,
                    targetCwd: "",
                  },
                );
              }}
            >
              在 Agent 工作台中打开 ↗
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (ui.modal === "report-issue") {
    return (
      <div className="qj-bot-modal-backdrop" onClick={closeModal}>
        <div
          className="qj-bot-dialog"
          style={{ width: 480, maxWidth: "92vw", padding: 24, display: "flex", flexDirection: "column", gap: 14 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 16, fontWeight: 600 }}>报告问题与体验反馈</span>
            <CloseCircleBtn label="关闭反馈" onClick={closeModal} />
          </div>
          <textarea
            rows={5}
            value={issueText}
            onChange={(e) => setIssueText(e.target.value)}
            placeholder="请描述你遇到的问题或希望千机分身改进的地方…"
            style={{
              width: "100%",
              padding: 12,
              borderRadius: 14,
              border: 0,
              outline: "none",
              background: "var(--muse-soft-fill)",
              color: "var(--qj-text-primary)",
              fontSize: 13,
            }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="qj-soft-btn" style={{ height: 34, padding: "0 14px", fontSize: 12 }} onClick={closeModal}>
              取消
            </button>
            <button
              type="button"
              className="qj-primary-pill-btn"
              style={{ height: 34, padding: "0 16px", fontSize: 12 }}
              disabled={issueText.trim() === ""}
              onClick={() => {
                setIssueText("");
                closeModal();
                navigationService?.showToast("感谢反馈，问题记录已保存至本地诊断日志", "info");
              }}
            >
              提交反馈
            </button>
          </div>
        </div>
      </div>
    );
  }

  // `settings` (`760px × 520px` 9-Tab Modal)
  return (
    <div className="qj-bot-modal-backdrop" onClick={closeModal} data-testid="bot-settings-modal">
      <div
        className="qj-bot-dialog"
        style={{ width: 760, maxWidth: "94vw", height: 520, display: "flex", position: "relative" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ position: "absolute", top: 14, right: 14, zIndex: 2 }}>
          <CloseCircleBtn label="关闭设置" onClick={closeModal} />
        </div>

        <aside
          aria-label="Bot 设置分类"
          style={{
            width: 204,
            flexShrink: 0,
            padding: 14,
            display: "flex",
            flexDirection: "column",
            gap: 4,
            overflowY: "auto",
            background: "var(--qj-bg-sidebar)",
          }}
        >
          <div style={{ padding: "8px 12px", fontSize: 15.5, fontWeight: 600 }}>设置</div>
          {SETTINGS_TABS.map((t) => {
            const active = ui.settingsTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                data-bot-settings-tab={t.id}
                onClick={() => patchBotUi({ settingsTab: t.id, serverFeedback: null })}
                style={{
                  width: "100%",
                  border: 0,
                  borderRadius: 12,
                  padding: "8px 12px",
                  textAlign: "left",
                  fontSize: 13.5,
                  fontWeight: active ? 550 : 400,
                  background: active ? "var(--qj-bg-active)" : "transparent",
                  color: "var(--qj-text-primary)",
                  cursor: "pointer",
                }}
              >
                {t.name}
              </button>
            );
          })}
        </aside>

        <div style={{ flex: 1, padding: "28px 44px 28px 28px", overflowY: "auto" }}>
          <BotSettingsPaneContent ctx={ctx} onClose={closeModal} />
        </div>
      </div>
    </div>
  );
}
