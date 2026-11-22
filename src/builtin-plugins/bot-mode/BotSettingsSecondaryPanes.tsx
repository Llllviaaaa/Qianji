/**
 * Secondary panes (`browser` | `vault` | `permissions` | `channels` | `data`)
 * for the 9-tab Bot Settings modal (`760px × 520px`).
 */
import { useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { useFrontendService } from "@qianji/client";
import { openBotModal, patchBotUi, useBotController, useBotSnapshot, useBotUiState } from "./botStore";

function downloadMarkdownFile(filename: string, content: string): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function BotSettingsSecondaryPane({
  ctx,
  onClose,
}: {
  readonly ctx?: Context;
  readonly onClose: () => void;
}): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const navigationService = useFrontendService("navigationService", ctx);
  const [confirmReset, setConfirmReset] = useState(false);

  if (ui.settingsTab === "browser") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>浏览器</h3>
        <div style={{ padding: 16, borderRadius: 18, background: "var(--muse-soft-fill)", fontSize: 12.5, lineHeight: 1.65 }}>
          <div style={{ fontSize: 14, fontWeight: 550, marginBottom: 6 }}>独立浏览器会话隔离</div>
          <div style={{ color: "var(--qj-text-secondary)" }}>
            分身使用与个人浏览器严格隔离的独立 Profile 执行网页检索与阅读。遇到需要账号登录或人机验证的站点时，会自动暂停并请求你在实时画面中手动完成验证。
          </div>
          <button
            type="button"
            onClick={() => openBotModal("live-view")}
            style={{
              marginTop: 12,
              height: 32,
              padding: "0 14px",
              borderRadius: 9999,
              border: 0,
              background: "var(--qj-bg-surface)",
              color: "var(--qj-text-primary)",
              fontSize: 12,
              fontWeight: 520,
              cursor: "pointer",
            }}
          >
            查看实时画面
          </button>
        </div>
      </div>
    );
  }

  if (ui.settingsTab === "vault") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>安全存储</h3>
        <div style={{ padding: 16, borderRadius: 18, background: "var(--muse-soft-fill)", fontSize: 12.5, lineHeight: 1.65 }}>
          <div style={{ fontSize: 14, fontWeight: 550, marginBottom: 6 }}>系统级密钥保险箱 (OS Keychain)</div>
          <div style={{ color: "var(--qj-text-secondary)" }}>
            所有模型供应商 API Key 与远端凭据均由千机桌面底座统一加密托管，分身对话记录与 SOUL/记忆文件中绝不明文落盘。
          </div>
          <button
            type="button"
            className="qj-primary-pill-btn"
            style={{ marginTop: 12, height: 34, padding: "0 16px", fontSize: 12, fontWeight: 520 }}
            onClick={() => {
              onClose();
              navigationService?.setShellMode("agent");
              navigationService?.openSettings("providers");
            }}
          >
            管理模型供应商与密钥
          </button>
        </div>
      </div>
    );
  }

  if (ui.settingsTab === "permissions") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>权限</h3>
        <div style={{ padding: 16, borderRadius: 18, background: "var(--muse-soft-fill)", fontSize: 12.5, lineHeight: 1.65 }}>
          <div style={{ fontSize: 14, fontWeight: 550, marginBottom: 6 }}>对外动作强制审批边界</div>
          <div style={{ color: "var(--qj-text-secondary)" }}>
            • 本地工作空间整理、笔记撰写与受控目录只读分析无需打断；
            <br />• 任何对外发信、推送代码、删除外部文件或高敏命令均自动拦截并排入右侧「批准」栏，未经允许绝不越界执行。
          </div>
          <button
            type="button"
            onClick={() => patchBotUi({ modal: null, rightPanelOpen: true, rightTab: "approvals" })}
            style={{
              marginTop: 12,
              height: 32,
              padding: "0 14px",
              borderRadius: 9999,
              border: 0,
              background: "var(--qj-bg-surface)",
              color: "var(--qj-text-primary)",
              fontSize: 12,
              fontWeight: 520,
              cursor: "pointer",
            }}
          >
            查看当前待批准项 ({snapshot.pendingApprovals.length})
          </button>
        </div>
      </div>
    );
  }

  if (ui.settingsTab === "channels") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>消息渠道</h3>
        <div style={{ padding: 16, borderRadius: 18, background: "var(--muse-soft-fill)", fontSize: 12.5, lineHeight: 1.65 }}>
          <div style={{ fontSize: 14, fontWeight: 550, marginBottom: 6 }}>专属收件箱与外部消息桥接</div>
          <div style={{ color: "var(--qj-text-secondary)" }}>
            {snapshot.inboxEnabled
              ? `专属收件通道已启用（${snapshot.inboxAddress || "local-inbox"}），外部投递摘要将汇总在右侧「邮箱」标签。`
              : "启用专属收件通道或通过千机插件中心接入飞书 / Telegram / Slack 消息桥接。"}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            {!snapshot.inboxEnabled && (
              <button
                type="button"
                className="qj-primary-pill-btn"
                style={{ height: 32, padding: "0 14px", fontSize: 12, fontWeight: 520 }}
                onClick={() => void ctrl.enableInbox()}
              >
                启用专属收件箱
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                onClose();
                navigationService?.setShellMode("agent");
                navigationService?.openSettings("plugins");
              }}
              style={{
                height: 32,
                padding: "0 14px",
                borderRadius: 9999,
                border: 0,
                background: "var(--qj-bg-surface)",
                color: "var(--qj-text-primary)",
                fontSize: 12,
                fontWeight: 520,
                cursor: "pointer",
              }}
            >
              管理渠道插件
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>数据控制</h3>
      <div style={{ padding: 16, borderRadius: 18, background: "var(--muse-soft-fill)", display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 550 }}>导出透明档案</div>
          <div style={{ fontSize: 12, color: "var(--qj-text-secondary)", marginTop: 2 }}>
            随时导出分身的 SOUL.md 灵魂契约与 MEMORY.md 长期记忆账本
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={() => downloadMarkdownFile("SOUL.md", snapshot.soulContent)}
            style={{
              height: 32,
              padding: "0 14px",
              borderRadius: 9999,
              border: 0,
              background: "var(--qj-bg-surface)",
              color: "var(--qj-text-primary)",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            导出 SOUL.md
          </button>
          <button
            type="button"
            onClick={() => downloadMarkdownFile("MEMORY.md", ui.memoryContent || "# MEMORY.md\n")}
            style={{
              height: 32,
              padding: "0 14px",
              borderRadius: 9999,
              border: 0,
              background: "var(--qj-bg-surface)",
              color: "var(--qj-text-primary)",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            导出 MEMORY.md
          </button>
        </div>
      </div>

      <div style={{ padding: 16, borderRadius: 18, background: "var(--muse-soft-fill)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 550 }}>清空 Bot 对话与状态数据</div>
          <div style={{ fontSize: 12, color: "var(--qj-text-secondary)", marginTop: 2 }}>
            重置主聊天、旁聊、空间、目标与动态记录，恢复全新初始状态
          </div>
        </div>
        {confirmReset ? (
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setConfirmReset(false)}
              style={{
                height: 32,
                padding: "0 12px",
                borderRadius: 9999,
                border: 0,
                background: "var(--qj-bg-surface)",
                color: "var(--qj-text-primary)",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmReset(false);
                void ctrl.resetAllData();
              }}
              style={{
                height: 32,
                padding: "0 14px",
                borderRadius: 9999,
                border: 0,
                background: "var(--qj-status-error)",
                color: "#ffffff",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              确认清空
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmReset(true)}
            style={{
              height: 32,
              padding: "0 14px",
              borderRadius: 9999,
              border: 0,
              background: "var(--qj-bg-surface)",
              color: "var(--qj-status-error)",
              fontSize: 12,
              fontWeight: 550,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            清空重置
          </button>
        )}
      </div>
    </div>
  );
}
