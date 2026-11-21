/**
 * Right `356px` Digital Companion Panel for Qianji Bot Mode:
 * - Interactive 3D felt companion avatar + inline editable display name
 * - Clickable Virtual Server status pill (`本地虚拟服务器` / `远端虚拟服务器`)
 * - 4-tab sliding capsule: `动态 (Activity)`, `批准 (Approvals)`, `身份 (Identity)`, `邮箱 (Inbox)`
 */
import { useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { ArrowUpRight, Check, Edit3, Mail, Server, ShieldCheck, X } from "lucide-react";
import { Switch } from "@qianji/client-primitives";
import type { BotAvatarPresetId } from "@qianji/protocol";
import { BotCompanionAvatar } from "./BotAvatarArt";
import {
  openBotModal,
  patchBotUi,
  useBotController,
  useBotSnapshot,
  useBotUiState,
  type BotCompanionTab,
} from "./botStore";

const PRESET_CYCLE: readonly BotAvatarPresetId[] = ["alabaster-felt", "warm-felt", "plush-ears"];

export function BotCompanionPanel({ ctx }: { readonly ctx?: Context }): ReactElement | null {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  if (!ui.rightPanelOpen) {
    return null;
  }

  const vs = snapshot.virtualServer;
  const serverModeLabel = vs.mode === "remote" ? "远端虚拟服务器" : "本地虚拟服务器";
  const lifecycleLabel =
    vs.lifecycle === "running"
      ? vs.mode === "remote"
        ? "云端守护"
        : "运行中"
      : vs.lifecycle === "sleeping"
        ? "休眠待命"
        : vs.lifecycle === "connecting"
          ? "连接中"
          : "未连接";
  const dotClass =
    vs.lifecycle === "running" ? "" : vs.lifecycle === "sleeping" || vs.lifecycle === "connecting" ? " sleeping" : " error";

  const cycleAvatarPreset = () => {
    const idx = PRESET_CYCLE.indexOf(snapshot.profile.avatarPreset);
    const next = PRESET_CYCLE[(idx + 1) % PRESET_CYCLE.length] ?? "alabaster-felt";
    void ctrl.updateProfile({ avatarPreset: next });
  };

  const commitName = () => {
    setEditingName(false);
    const trimmed = nameDraft.trim();
    if (trimmed !== "" && trimmed !== snapshot.profile.displayName) {
      void ctrl.updateProfile({ displayName: trimmed });
    }
  };

  const pendingCount = snapshot.pendingApprovals.length;

  return (
    <aside className="qj-bot-companion" aria-label="数字分身伴侣面板" data-testid="bot-companion-panel">
      <div className="qj-bot-companion-hero">
        <button
          type="button"
          className="qj-bot-avatar-stage"
          style={{ border: 0 }}
          title="点击切换毛毡分身外观"
          aria-label="切换分身外观"
          onClick={cycleAvatarPreset}
        >
          <BotCompanionAvatar
            preset={snapshot.profile.avatarPreset}
            customDataUrl={snapshot.profile.customAvatarDataUrl}
            size={88}
          />
        </button>

        {editingName ? (
          <input
            autoFocus
            className="qj-bot-input"
            style={{ width: 148, textAlign: "center", padding: "4px 8px" }}
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setEditingName(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="qj-bot-name-btn"
            title="点击修改分身昵称"
            onClick={() => {
              setNameDraft(snapshot.profile.displayName);
              setEditingName(true);
            }}
          >
            <span>{snapshot.profile.displayName}</span>
            <Edit3 size={12} style={{ opacity: 0.55 }} />
          </button>
        )}

        <button
          type="button"
          data-testid="bot-vserver-pill"
          className="qj-bot-server-pill"
          title="点击配置本地或远端虚拟服务器"
          onClick={() => openBotModal("settings", "vserver")}
        >
          <span className={`qj-bot-server-dot${dotClass}`} aria-hidden="true" />
          <span>
            {lifecycleLabel} · {serverModeLabel}
          </span>
          <Server size={12} style={{ opacity: 0.65 }} />
        </button>
      </div>

      {/* 4-Tab Sliding Capsule */}
      <div className="qj-bot-seg" role="tablist" aria-label="分身详情页签">
        {(
          [
            { id: "activity", label: "动态" },
            { id: "approvals", label: pendingCount > 0 ? `批准 (${pendingCount})` : "批准" },
            { id: "identity", label: "身份" },
            { id: "inbox", label: "邮箱" },
          ] as ReadonlyArray<{ readonly id: BotCompanionTab; readonly label: string }>
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            data-companion-tab={tab.id}
            aria-selected={ui.rightTab === tab.id}
            className={ui.rightTab === tab.id ? "active" : undefined}
            onClick={() => patchBotUi({ rightTab: tab.id })}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Body */}
      <div className="qj-bot-companion-body">
        {ui.rightTab === "activity" && (
          <>
            <div
              className="qj-bot-soft-card"
              style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: "12px 14px" }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <strong style={{ fontSize: 13 }}>主动心跳守护</strong>
                <span style={{ fontSize: 11.5, color: "var(--qj-text-secondary)" }}>
                  定时巡检待办、目标与简报
                </span>
              </div>
              <Switch
                checked={ui.heartbeatEnabled}
                onCheckedChange={(checked) => patchBotUi({ heartbeatEnabled: checked })}
                aria-label="切换主动心跳守护"
              />
            </div>

            {snapshot.activityGroups.map((group) => (
              <div key={group.date} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--qj-text-muted)", padding: "2px 4px" }}>
                  {group.date}
                </span>
                {group.items.map((item) => {
                  const handoff = item.handoff;
                  return (
                  <div key={item.id} className="qj-bot-soft-card" style={{ padding: "12px 14px", gap: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <strong style={{ fontSize: 13 }}>{item.title}</strong>
                      <span style={{ fontSize: 11, color: "var(--qj-text-muted)", flexShrink: 0 }}>
                        {item.timeLabel}
                      </span>
                    </div>
                    <span style={{ fontSize: 12.5, color: "var(--qj-text-secondary)", lineHeight: 1.5 }}>
                      {item.description}
                    </span>
                    {handoff && (
                      <div>
                        <button
                          type="button"
                          className="qj-bot-pill-btn"
                          style={{ height: 26, fontSize: 11.5, padding: "0 10px" }}
                          onClick={() => ctrl.triggerHandoff(handoff)}
                        >
                          <span>在工作台查看</span>
                          <ArrowUpRight size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
            ))}
          </>
        )}

        {ui.rightTab === "approvals" && (
          <>
            {snapshot.pendingApprovals.length === 0 ? (
              <div className="qj-bot-soft-card" style={{ alignItems: "center", textAlign: "center", padding: "22px 16px" }}>
                <ShieldCheck size={22} />
                <strong style={{ fontSize: 13.5 }}>当前无待批准请求</strong>
                <span style={{ fontSize: 12.5, color: "var(--qj-text-secondary)" }}>
                  当分身需要对外发信、评论或执行敏感变更时，会安静排入此处等你确认。
                </span>
              </div>
            ) : (
              snapshot.pendingApprovals.map((item) => (
                <div key={item.id} className="qj-bot-soft-card" style={{ padding: "13px 14px", gap: 8 }}>
                  <strong style={{ fontSize: 13 }}>{item.title}</strong>
                  <code style={{ fontSize: 11.5, color: "var(--qj-text-muted)" }}>{item.commandSignature}</code>
                  <span style={{ fontSize: 12.5, color: "var(--qj-text-secondary)", lineHeight: 1.5 }}>
                    {item.summary}
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      className="qj-bot-task-handoff-btn"
                      style={{ height: 28, fontSize: 12 }}
                      onClick={() => void ctrl.resolveApproval(item.id, "approved")}
                    >
                      <Check size={13} />
                      <span>允许</span>
                    </button>
                    <button
                      type="button"
                      className="qj-bot-pill-btn"
                      style={{ height: 28, fontSize: 12 }}
                      onClick={() => void ctrl.resolveApproval(item.id, "denied")}
                    >
                      <X size={13} />
                      <span>拒绝</span>
                    </button>
                  </div>
                </div>
              ))
            )}

            {snapshot.recentApprovals.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--qj-text-muted)", padding: "0 4px" }}>
                  最近处理记录
                </span>
                {snapshot.recentApprovals.map((rec) => (
                  <div key={rec.id} className="qj-bot-soft-card" style={{ padding: "10px 12px", gap: 4 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                      <span>{rec.title}</span>
                      <span style={{ color: "var(--qj-text-muted)", fontSize: 11 }}>
                        {rec.decision === "approved" ? "已允许" : rec.decision === "denied" ? "已拒绝" : "受控放行"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {ui.rightTab === "identity" && (
          <>
            <div className="qj-bot-soft-card" style={{ padding: "13px 14px", gap: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong style={{ fontSize: 13.5 }}>灵魂契约 (SOUL.md)</strong>
                <span style={{ fontSize: 11, color: "var(--qj-text-muted)" }}>{snapshot.soulUpdatedAt}</span>
              </div>
              <span style={{ fontSize: 12.5, color: "var(--qj-text-secondary)", lineHeight: 1.5 }}>
                设定性格温度、回答风格与不可逾越的外部行动红线。
              </span>
              <button type="button" className="qj-bot-pill-btn" onClick={() => openBotModal("soul")}>
                查看 / 编辑 SOUL.md
              </button>
            </div>

            <div className="qj-bot-soft-card" style={{ padding: "13px 14px", gap: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong style={{ fontSize: 13.5 }}>长期记忆 (MEMORY.md)</strong>
                <span style={{ fontSize: 11, color: "var(--qj-text-muted)" }}>{snapshot.memoryUpdatedAt}</span>
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--qj-text-secondary)", lineHeight: 1.55 }}>
                {snapshot.learnedPreferences.map((pref, i) => (
                  <li key={i}>{pref}</li>
                ))}
              </ul>
              <button type="button" className="qj-bot-pill-btn" onClick={() => openBotModal("memory")}>
                管理记忆账本
              </button>
            </div>
          </>
        )}

        {ui.rightTab === "inbox" && (
          <>
            {!snapshot.inboxEnabled ? (
              <div className="qj-bot-soft-card" style={{ alignItems: "center", textAlign: "center", padding: "22px 16px" }}>
                <Mail size={22} />
                <strong style={{ fontSize: 13.5 }}>启用千机专属收件箱</strong>
                <span style={{ fontSize: 12.5, color: "var(--qj-text-secondary)", lineHeight: 1.5 }}>
                  将订阅周报、构建通知或行程确认转发给分身，自动为你提炼摘要并跟进待办。
                </span>
                <button
                  type="button"
                  className="qj-bot-task-handoff-btn"
                  onClick={() => void ctrl.enableInbox()}
                >
                  一键开通收件箱
                </button>
              </div>
            ) : (
              <>
                <div className="qj-bot-soft-card" style={{ padding: "10px 12px", gap: 4 }}>
                  <span style={{ fontSize: 11.5, color: "var(--qj-text-muted)" }}>专属投递地址</span>
                  <code style={{ fontSize: 12 }}>{snapshot.inboxAddress}</code>
                </div>
                {snapshot.inboxItems.map((mail) => (
                  <div key={mail.id} className="qj-bot-soft-card" style={{ padding: "12px 14px", gap: 5 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: "var(--qj-text-muted)" }}>
                      <span>{mail.sender}</span>
                      <span>{mail.timeLabel}</span>
                    </div>
                    <strong style={{ fontSize: 13 }}>{mail.subject}</strong>
                    <span style={{ fontSize: 12.5, color: "var(--qj-text-secondary)" }}>{mail.preview}</span>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
