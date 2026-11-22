/**
 * 1:1 High-Fidelity Right `356px` Companion Panel matching `qj-v7-1-bot-chat.png`.
 */
import type { ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { useFrontendService } from "@qianji/client";
import type { BotAvatarPresetId } from "@qianji/protocol";
import {
  AVATAR_PRESET_LABELS,
  BotCompanionAvatar,
  BotIcon,
  type BotIconName,
} from "./BotAvatarArt";
import { BotCompanionIdentityTab, BotCompanionInboxTab } from "./BotCompanionIdentityAndInbox";
import {
  openBotModal,
  patchBotUi,
  useBotController,
  useBotSnapshot,
  useBotUiState,
  type BotCompanionTab,
} from "./botStore";

const PRESET_ORDER: ReadonlyArray<Exclude<BotAvatarPresetId, "custom">> = [
  "alabaster-felt",
  "warm-felt",
  "plush-ears",
];

const RIGHT_TABS: ReadonlyArray<{ readonly id: BotCompanionTab; readonly title: string; readonly icon: BotIconName }> = [
  { id: "activity", title: "动态", icon: "tabActivity" },
  { id: "approvals", title: "批准", icon: "tabShield" },
  { id: "identity", title: "身份", icon: "tabIdentity" },
  { id: "inbox", title: "邮箱", icon: "tabMail" },
];

export function BotCompanionPanel({ ctx }: { readonly ctx?: Context }): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const navigationService = useFrontendService("navigationService", ctx);

  const vs = snapshot.virtualServer;
  const serverLabel =
    vs.mode === "local"
      ? vs.local.engine === "wsl2" && vs.local.engineState === "not-installed"
        ? "未初始化 · WSL2 容器"
        : vs.lifecycle === "sleeping" || vs.local.engineState === "stopped"
          ? "休眠待命 · WSL2 容器"
          : vs.local.engine === "wsl2"
            ? "运行中 · WSL2 本地容器"
            : "运行中 · 宿主机隔离目录"
      : vs.lifecycle === "running"
        ? "云端守护 · 远端 SSH 服务器"
        : "未连接 · 远端虚拟服务器";
  const dotColor =
    vs.lifecycle === "running"
      ? "var(--qj-status-success)"
      : vs.lifecycle === "sleeping"
        ? "var(--qj-status-warning)"
        : "var(--qj-status-danger)";

  const tabIdx = Math.max(0, RIGHT_TABS.findIndex((t) => t.id === ui.rightTab));

  const cycleAvatar = () => {
    const cur = snapshot.profile.avatarPreset;
    const idx = cur === "custom" ? -1 : PRESET_ORDER.indexOf(cur);
    const next = PRESET_ORDER[(idx + 1) % PRESET_ORDER.length] ?? "alabaster-felt";
    void ctrl.updateProfile({ avatarPreset: next });
    navigationService?.showToast(`已切换形象：${AVATAR_PRESET_LABELS[next]}`, "info");
  };

  return (
    <aside id="bot-right-inner" className="qj-bot-right-inner" aria-label="数字分身伴侣面板" data-testid="bot-companion-panel">
      <div style={{ height: 42, flexShrink: 0 }} data-tauri-drag-region="" />

      <div style={{ padding: "12px 16px 12px", display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
        <div id="companion-hero-avatar" style={{ position: "relative", width: 124, height: 124 }}>
          <BotCompanionAvatar
            preset={snapshot.profile.avatarPreset}
            customDataUrl={snapshot.profile.customAvatarDataUrl}
            size={124}
          />
          <button
            id="companion-pencil-btn"
            type="button"
            title="切换虚拟形象"
            aria-label="切换虚拟形象"
            onClick={cycleAvatar}
            style={{
              position: "absolute",
              right: -2,
              bottom: 0,
              width: 32,
              height: 32,
              border: 0,
              borderRadius: "9999px",
              background: "var(--muse-soft-fill)",
              color: "var(--qj-text-primary)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <BotIcon name="pencil" />
          </button>
        </div>

        <div style={{ marginTop: 10, fontSize: 21, fontWeight: 500, lineHeight: "28px", letterSpacing: "-0.015em" }}>
          {snapshot.profile.displayName}
        </div>

        <button
          type="button"
          data-testid="bot-vserver-pill"
          title="点击切换本地或远端常驻虚拟服务器"
          onClick={() => openBotModal("settings", "server")}
          style={{
            marginTop: 2,
            padding: "2px 10px",
            border: 0,
            borderRadius: "9999px",
            background: "transparent",
            color: "var(--qj-text-secondary)",
            fontSize: 12.5,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            cursor: "pointer",
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: dotColor }} />
          <span>{serverLabel}</span>
        </button>

        <div
          id="right-tab-pill"
          className="qj-right-tab-pill"
          role="tablist"
          aria-label="陪伴面板分栏"
          style={{ marginTop: 20, ["--tab-idx" as string]: String(tabIdx) }}
        >
          <div id="right-tab-thumb" className="qj-right-tab-thumb" />
          {RIGHT_TABS.map((t) => {
            const active = ui.rightTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                data-companion-tab={t.id}
                aria-selected={active}
                title={t.title}
                aria-label={t.title}
                className={`qj-right-tab-btn${active ? " active" : ""}`}
                onClick={() => patchBotUi({ rightTab: t.id })}
              >
                <BotIcon name={t.icon} />
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "12px 16px 32px" }}>
        {ui.rightTab === "activity" && (
          <div className="qj-animate-page-in" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div>
              <button
                type="button"
                onClick={() => patchBotUi({ scheduledExpanded: !ui.scheduledExpanded })}
                style={{
                  width: "100%",
                  padding: "4px 0",
                  border: 0,
                  background: "transparent",
                  color: "var(--qj-text-primary)",
                  fontSize: 14.5,
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  cursor: "pointer",
                }}
              >
                <span>{ui.scheduledTasks.length} 项预定任务</span>
                <span
                  style={{
                    color: "var(--qj-text-secondary)",
                    transform: ui.scheduledExpanded ? "none" : "rotate(-90deg)",
                    transition: "transform 160ms ease",
                  }}
                >
                  <BotIcon name="chevronDown" />
                </span>
              </button>

              {ui.scheduledExpanded && (
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                  {ui.scheduledTasks.map((task, idx) => (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => {
                        const next = ui.scheduledTasks.map((it, i) =>
                          i === idx ? { ...it, enabled: !it.enabled } : it,
                        );
                        patchBotUi({ scheduledTasks: next });
                        navigationService?.showToast(
                          `${task.name} ${!task.enabled ? "已启用" : "已暂停"}`,
                          "info",
                        );
                      }}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: 6,
                        border: 0,
                        borderRadius: 14,
                        background: "transparent",
                        color: "var(--qj-text-primary)",
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                    >
                      <div
                        style={{
                          width: 40,
                          height: 40,
                          borderRadius: "9999px",
                          background: "var(--muse-soft-fill)",
                          color: "var(--qj-status-danger)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                        }}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
                          <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
                        </svg>
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 500 }}>{task.name}</div>
                        <div style={{ fontSize: 12.5, color: "var(--qj-text-secondary)" }}>
                          {task.cronOrInterval}
                          {task.enabled ? "" : " · 已暂停"}
                        </div>
                      </div>
                    </button>
                  ))}

                  <button
                    type="button"
                    className="qj-soft-btn"
                    style={{ marginTop: 4, width: "100%", height: 36, fontSize: 13, fontWeight: 500, background: "transparent" }}
                    onClick={() => {
                      navigationService?.setShellMode("agent");
                      navigationService?.navigate({ kind: "hub", view: "scheduled" });
                    }}
                  >
                    查看所有预定任务
                  </button>
                </div>
              )}
            </div>

            {snapshot.activityGroups.length === 0 ? (
              <div style={{ padding: "24px 8px", textAlign: "center", color: "var(--qj-text-secondary)", fontSize: 13 }}>
                暂无后台执行记录 · 发起对话或执行任务后，动态将按日期呈现在这里
              </div>
            ) : (
              snapshot.activityGroups.map((g) => (
                <div key={g.date} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 0", fontSize: 14.5, fontWeight: 600 }}>
                    <span>{g.date}</span>
                    <span style={{ color: "var(--qj-text-secondary)" }}>
                      <BotIcon name="chevronDown" />
                    </span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    {g.items.map((it) => {
                      const handoff = it.handoff;
                      return (
                        <div
                          key={it.id}
                          onClick={() => {
                            if (handoff) ctrl.triggerHandoff(handoff);
                          }}
                          style={{
                            display: "flex",
                            alignItems: "flex-start",
                            gap: 12,
                            padding: "8px 6px",
                            borderRadius: 14,
                            cursor: handoff ? "pointer" : "default",
                          }}
                        >
                          <div style={{ width: 36, height: 36, borderRadius: "9999px", background: "var(--muse-soft-fill)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 2 }}>
                            <BotIcon name="checkCircle" />
                          </div>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: 13.5, fontWeight: 500, lineHeight: 1.38 }}>{it.title}</div>
                            <div style={{ fontSize: 12.5, color: "var(--qj-text-secondary)", lineHeight: 1.4 }}>{it.description}</div>
                            <div style={{ fontSize: 12, color: "var(--qj-text-muted)", marginTop: 2 }}>{it.timeLabel}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {ui.rightTab === "approvals" && (
          <div className="qj-animate-page-in" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>审核</span>
              <span style={{ fontSize: 12, color: "var(--qj-text-secondary)" }}>
                {snapshot.pendingApprovals.length > 0 ? `${snapshot.pendingApprovals.length} 项待确认` : "全部已处理"}
              </span>
            </div>

            {snapshot.pendingApprovals.length === 0 ? (
              <div style={{ padding: "40px 12px", textAlign: "center" }}>
                <div style={{ fontSize: 15, fontWeight: 500 }}>审核</div>
                <div style={{ fontSize: 13, color: "var(--qj-text-secondary)", marginTop: 4 }}>暂无待批准记录</div>
              </div>
            ) : (
              snapshot.pendingApprovals.map((apr) => (
                <div key={apr.id} style={{ padding: 16, borderRadius: 20, background: "var(--muse-soft-fill)", display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 36, height: 36, borderRadius: "9999px", background: "var(--qj-bg-surface)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <BotIcon name="tabShield" />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{apr.title}</div>
                      <div style={{ fontSize: 12, color: "var(--qj-text-secondary)" }}>{apr.commandSignature}</div>
                    </div>
                  </div>
                  <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: "var(--qj-text-secondary)" }}>{apr.summary}</p>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      className="qj-primary-pill-btn"
                      style={{ flex: 1, height: 36, fontSize: 13, fontWeight: 500 }}
                      onClick={() => void ctrl.resolveApproval(apr.id, "approved")}
                    >
                      批准
                    </button>
                    <button
                      type="button"
                      className="qj-soft-btn"
                      style={{ flex: 1, height: 36, fontSize: 13, fontWeight: 500, background: "var(--qj-bg-surface)" }}
                      onClick={() => void ctrl.resolveApproval(apr.id, "denied")}
                    >
                      拒绝
                    </button>
                  </div>
                </div>
              ))
            )}

            {snapshot.recentApprovals.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: "var(--qj-text-muted)" }}>最近审核记录</div>
                {snapshot.recentApprovals.map((rec) => (
                  <div key={rec.id} style={{ padding: 12, borderRadius: 16, background: "var(--muse-soft-fill)", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12 }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{rec.title}</div>
                      <div style={{ color: "var(--qj-text-secondary)" }}>{rec.summary}</div>
                    </div>
                    <span style={{ color: "var(--qj-text-secondary)" }}>{rec.timeLabel}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {ui.rightTab === "identity" && <BotCompanionIdentityTab ctx={ctx} />}
        {ui.rightTab === "inbox" && <BotCompanionInboxTab ctx={ctx} />}
      </div>
    </aside>
  );
}
