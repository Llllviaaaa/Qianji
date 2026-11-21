/**
 * Modal overlays for Qianji Bot Mode:
 * - Global Search (`Ctrl+K`)
 * - `SOUL.md` & `MEMORY.md` editors
 * - Keyboard Shortcuts cheat-sheet
 * - Live View / Manual Takeover window
 * - 2-column Bot Settings Drawer
 */
import { useEffect, useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { Search, Shield, X } from "lucide-react";
import { useFrontendService } from "@qianji/client";
import { Switch } from "@qianji/client-primitives";
import { VirtualServerConsole } from "./BotVirtualServerConsole";
import {
  openBotModal,
  patchBotUi,
  useBotController,
  useBotSnapshot,
  useBotUiState,
  type BotSettingsTab,
} from "./botStore";

function MarkdownContractEditor({
  title,
  subtitle,
  initialValue,
  onSave,
  onClose,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly initialValue: string;
  readonly onSave: (next: string) => void;
  readonly onClose: () => void;
}): ReactElement {
  const [draft, setDraft] = useState(initialValue);

  return (
    <div className="qj-bot-modal compact" onClick={(e) => e.stopPropagation()}>
      <div className="qj-bot-settings-pane">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <strong style={{ fontSize: 16 }}>{title}</strong>
            <div style={{ fontSize: 12.5, color: "var(--qj-text-secondary)" }}>{subtitle}</div>
          </div>
          <button type="button" className="qj-bot-icon-btn" aria-label="关闭弹窗" onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <textarea
          className="qj-bot-textarea"
          style={{ minHeight: 260, fontFamily: "var(--qj-font-mono)" }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="qj-bot-pill-btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="qj-bot-task-handoff-btn" onClick={() => onSave(draft)}>
            保存更改
          </button>
        </div>
      </div>
    </div>
  );
}

export function BotModals({ ctx }: { readonly ctx?: Context }): ReactElement | null {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const rpcService = useFrontendService("rpcService", ctx);
  const navigationService = useFrontendService("navigationService", ctx);

  const [searchQuery, setSearchQuery] = useState("");

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

  if (ui.modal === "soul") {
    return (
      <div className="qj-bot-modal-backdrop" onClick={closeModal}>
        <MarkdownContractEditor
          key={`soul-${ui.modalNonce}`}
          title="SOUL.md · 灵魂与边界契约"
          subtitle="仅作用于 Bot 主聊天与旁聊，不污染 Agent 编程工作台系统提示词"
          initialValue={snapshot.soulContent}
          onClose={closeModal}
          onSave={(next) => {
            void ctrl.saveSoul(next);
            closeModal();
          }}
        />
      </div>
    );
  }

  if (ui.modal === "memory") {
    return (
      <div className="qj-bot-modal-backdrop" onClick={closeModal}>
        <MarkdownContractEditor
          key={`mem-${ui.modalNonce}`}
          title="MEMORY.md · 长期记忆账本"
          subtitle="随时审阅、增删或修正千机记住的偏好与事实"
          initialValue={ui.memoryDraftContent}
          onClose={closeModal}
          onSave={(next) => {
            patchBotUi({ memoryDraftContent: next, modal: null });
            void rpcService?.call("memory.save", { content: next }).catch(() => undefined);
            navigationService?.showToast("已更新长期记忆账本", "info");
          }}
        />
      </div>
    );
  }

  if (ui.modal === "search") {
    const q = searchQuery.trim().toLowerCase();
    const matchedSpaces = snapshot.spaces.filter(
      (s) => q === "" || s.title.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
    const matchedDocs = snapshot.documents.filter(
      (d) => q === "" || d.name.toLowerCase().includes(q) || d.content.toLowerCase().includes(q),
    );

    return (
      <div className="qj-bot-modal-backdrop" onClick={closeModal}>
        <div className="qj-bot-modal compact" onClick={(e) => e.stopPropagation()}>
          <div className="qj-bot-settings-pane">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Search size={17} />
              <input
                autoFocus
                className="qj-bot-composer-input"
                placeholder="搜索主聊天、旁聊、专题空间与沉淀文档…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <button type="button" className="qj-bot-icon-btn" aria-label="关闭搜索" onClick={closeModal}>
                <X size={15} />
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 340, overflowY: "auto" }}>
              {matchedSpaces.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="qj-bot-soft-card interactive"
                  style={{ border: 0, textAlign: "left", padding: "11px 14px" }}
                  onClick={() => patchBotUi({ modal: null, activeView: "library", libSection: "spaces" })}
                >
                  <strong style={{ fontSize: 13.5 }}>空间 · {s.title}</strong>
                  <span style={{ fontSize: 12, color: "var(--qj-text-secondary)" }}>{s.description}</span>
                </button>
              ))}
              {matchedDocs.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className="qj-bot-soft-card interactive"
                  style={{ border: 0, textAlign: "left", padding: "11px 14px" }}
                  onClick={() => patchBotUi({ modal: null, activeView: "library", libSection: "docs" })}
                >
                  <strong style={{ fontSize: 13.5 }}>文档 · {d.name}</strong>
                  <span style={{ fontSize: 12, color: "var(--qj-text-secondary)" }}>{d.updatedLabel}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (ui.modal === "shortcuts") {
    const rows: ReadonlyArray<readonly [string, string]> = [
      ["切换 Agent / Bot 形态", "Ctrl + Shift + M"],
      ["Bot 全局搜索", "Ctrl + K"],
      ["展开 / 收起旁聊抽屉", "Ctrl + J"],
      ["打开设置", "Ctrl + ,"],
      ["紧急安全模式（暂停外部插件）", "Ctrl + Shift + Alt + R"],
    ];
    return (
      <div className="qj-bot-modal-backdrop" onClick={closeModal}>
        <div className="qj-bot-modal compact" onClick={(e) => e.stopPropagation()}>
          <div className="qj-bot-settings-pane">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ fontSize: 16 }}>键盘快捷键</strong>
              <button type="button" className="qj-bot-icon-btn" aria-label="关闭快捷键" onClick={closeModal}>
                <X size={15} />
              </button>
            </div>
            {rows.map(([label, chord]) => (
              <div
                key={label}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "8px 10px",
                  borderRadius: 10,
                  background: "var(--qj-bot-soft)",
                  fontSize: 13,
                }}
              >
                <span>{label}</span>
                <code>{chord}</code>
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
        <div className="qj-bot-modal compact" onClick={(e) => e.stopPropagation()}>
          <div className="qj-bot-settings-pane">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ fontSize: 16 }}>虚拟服务器实时画面 · 受控沙箱桌面</strong>
              <button type="button" className="qj-bot-icon-btn" aria-label="关闭画面" onClick={closeModal}>
                <X size={15} />
              </button>
            </div>
            <div
              className="qj-bot-soft-card"
              style={{ minHeight: 210, alignItems: "center", justifyContent: "center", textAlign: "center" }}
            >
              <Shield size={26} />
              <strong>当前受控运行环境处于安全待命状态</strong>
              <span style={{ fontSize: 12.5, color: "var(--qj-text-secondary)", maxWidth: 380 }}>
                当分身在虚拟服务器中执行页面浏览遇到登录授权或人机验证时，将在此窗口请求人工接管，绝不私自绕过验证。
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                className="qj-bot-pill-btn"
                onClick={() => openBotModal("settings", "vserver")}
              >
                返回虚拟服务器设置
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Bot Settings 2-Column Modal
  const navTabs: ReadonlyArray<{ readonly id: BotSettingsTab; readonly label: string }> = [
    { id: "profile", label: "形象与档案" },
    { id: "vserver", label: "虚拟服务器" },
    { id: "heartbeat", label: "主动心跳与提醒" },
    { id: "connectors", label: "外部工具与连接" },
    { id: "privacy", label: "隐私与安全边界" },
  ];

  return (
    <div className="qj-bot-modal-backdrop" onClick={closeModal} data-testid="bot-settings-modal">
      <div className="qj-bot-modal" onClick={(e) => e.stopPropagation()}>
        <nav className="qj-bot-settings-nav" aria-label="Bot 设置分类">
          <div style={{ padding: "2px 10px 10px", fontSize: 14, fontWeight: 640 }}>Bot 设置</div>
          {navTabs.map((t) => (
            <button
              key={t.id}
              type="button"
              data-bot-settings-tab={t.id}
              className={ui.settingsTab === t.id ? "active" : undefined}
              onClick={() => patchBotUi({ settingsTab: t.id, serverFeedback: null })}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="qj-bot-settings-pane">
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="button" className="qj-bot-icon-btn" aria-label="关闭设置" onClick={closeModal}>
              <X size={15} />
            </button>
          </div>

          {ui.settingsTab === "vserver" && <VirtualServerConsole ctx={ctx} />}

          {ui.settingsTab === "profile" && (
            <>
              <strong style={{ fontSize: 16 }}>数字分身形象与称呼</strong>
              <div className="qj-bot-field">
                <label>分身显示名称</label>
                <input
                  className="qj-bot-input"
                  value={snapshot.profile.displayName}
                  onChange={(e) => void ctrl.updateProfile({ displayName: e.target.value })}
                />
              </div>
              <div className="qj-bot-field">
                <label>毛毡陪伴外观预设</label>
                <div style={{ display: "flex", gap: 8 }}>
                  {(
                    [
                      ["alabaster-felt", "云白毛毡"],
                      ["warm-felt", "暖杏毛毡"],
                      ["plush-ears", "垂耳绒感"],
                    ] as const
                  ).map(([presetId, label]) => (
                    <button
                      key={presetId}
                      type="button"
                      className={`qj-bot-pill-btn${snapshot.profile.avatarPreset === presetId ? " active" : ""}`}
                      onClick={() => void ctrl.updateProfile({ avatarPreset: presetId })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {ui.settingsTab === "heartbeat" && (
            <>
              <strong style={{ fontSize: 16 }}>主动心跳与托盘常驻</strong>
              <div
                className="qj-bot-soft-card"
                style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
              >
                <div>
                  <strong style={{ fontSize: 13.5 }}>启用后台主动心跳</strong>
                  <div style={{ fontSize: 12, color: "var(--qj-text-secondary)" }}>
                    开启后点击窗口关闭按钮将最小化至系统托盘继续守护待办
                  </div>
                </div>
                <Switch
                  checked={ui.heartbeatEnabled}
                  onCheckedChange={(checked) => patchBotUi({ heartbeatEnabled: checked })}
                  aria-label="后台主动心跳开关"
                />
              </div>
            </>
          )}

          {ui.settingsTab === "connectors" && (
            <>
              <strong style={{ fontSize: 16 }}>外部工具与受控连接</strong>
              {snapshot.connectors.map((c) => (
                <div
                  key={c.id}
                  className="qj-bot-soft-card"
                  style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
                >
                  <div>
                    <strong style={{ fontSize: 13.5 }}>{c.name}</strong>
                    <div style={{ fontSize: 12, color: "var(--qj-text-secondary)" }}>{c.description}</div>
                  </div>
                  <Switch
                    checked={c.enabled}
                    onCheckedChange={() => void ctrl.toggleConnector(c.id)}
                    aria-label={c.name}
                  />
                </div>
              ))}
            </>
          )}

          {ui.settingsTab === "privacy" && (
            <>
              <strong style={{ fontSize: 16 }}>隐私透明与安全红线</strong>
              <div className="qj-bot-soft-card">
                <span style={{ fontSize: 13, color: "var(--qj-text-secondary)", lineHeight: 1.6 }}>
                  • 本地数据透明存储于应用数据目录，SOUL.md 与 MEMORY.md 随时可查看与编辑。
                  <br />• 所有对外发送邮件、评论或推送代码的动作默认拦截并排入右侧「批准」栏等待确认。
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
