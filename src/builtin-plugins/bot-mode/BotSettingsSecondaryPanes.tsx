/**
 * Secondary panes (`voice` | `browser` | `vault` | `permissions` | `channels` | `data`)
 * for the Bot Settings shell (`src/builtin-plugins/bot-mode/BotSettingsSecondaryPanes.tsx`).
 */
import type { ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  ArrowRight,
  ChevronRight,
  Globe,
  KeyRound,
  MonitorPlay,
  ShieldCheck,
} from "lucide-react";
import { useAppStore } from "@qianji/client";
import type { BotConnectorPolicyTier } from "@qianji/protocol";
import { BotChannelsSettingsPane, BotDataControlSettingsPane } from "./BotChannelsAndDataPanes";
import { getMergedConnectorCatalog, resolveConnectorState } from "./botConnectorCatalog";
import { ConnectorBrandIcon } from "./BotConnectorLogos";
import {
  openBotConnector,
  openBotLiveView,
  patchBotUi,
  useBotSnapshot,
  useBotUiState,
} from "./botStore";
import { Live2DVoiceSettingsSection } from "./live2d/Live2DVoiceSettingsSection";

const POLICY_TIER_LABELS: Readonly<Record<BotConnectorPolicyTier, string>> = {
  "always-ask": "始终询问",
  "read-only-auto": "只读自动",
  "low-risk-auto": "低风险自动",
  "strict-read-only": "仅只读",
};

export function BotSettingsSecondaryPane({
  ctx,
}: {
  readonly ctx?: Context;
  readonly onClose: () => void;
}): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const appSettings = useAppStore((s) => s.settings);

  if (ui.settingsTab === "voice") {
    return <Live2DVoiceSettingsSection ctx={ctx} />;
  }

  if (ui.settingsTab === "channels") {
    return <BotChannelsSettingsPane ctx={ctx} />;
  }

  if (ui.settingsTab === "data") {
    return <BotDataControlSettingsPane ctx={ctx} />;
  }

  const mcpServers = appSettings?.mcpServers ?? [];
  const mergedCatalog = getMergedConnectorCatalog(ui.pluginConnectors);

  if (ui.settingsTab === "browser") {
    const browserEntries = mergedCatalog.filter((c) => c.authMode === "browser");
    return (
      <div className="qj-bset-stack">
        <section className="qj-bset-group">
          <div className="qj-bset-group-head">
            <span className="qj-bset-group-title">Computer Use 独立沙箱与人工接管</span>
          </div>
          <div className="qj-bset-card">
            <div className="qj-bset-row">
              <div className="qj-bset-row-copy">
                <div className="qj-bset-row-title">
                  <Globe size={14.5} className="qj-bset-inline-icon" />
                  <span>独立浏览器会话隔离（仅用于长尾网页操作）</span>
                </div>
                <div className="qj-bset-row-desc">
                  Gmail、GitHub、Notion、Figma 等主流应用均已通过标准 MCP / OAuth 2.1 直连；独立浏览器专用于无公开 API 的网页检索与人工接管，不触碰个人浏览器历史与密码库。
                </div>
              </div>
              <div className="qj-bset-inline-controls">
                <button
                  type="button"
                  className="qj-bset-btn soft sm"
                  onClick={() => patchBotUi({ settingsTab: "connectors", activeConnectorId: null })}
                >
                  <span>MCP 连接器目录</span>
                  <ArrowRight size={12.5} />
                </button>
                <button
                  type="button"
                  className="qj-bset-btn primary sm"
                  onClick={() => openBotLiveView(undefined, { returnToCurrent: true })}
                >
                  <MonitorPlay size={13} />
                  <span>查看实时画面</span>
                </button>
              </div>
            </div>
          </div>
        </section>

        {browserEntries.length > 0 && (
          <section className="qj-bset-group">
            <div className="qj-bset-group-head">
              <span className="qj-bset-group-title">扩展插件网页连接器</span>
            </div>
            <div className="qj-conn-list">
              {browserEntries.slice(0, 8).map((entry) => {
                const st = resolveConnectorState(entry, snapshot, ui.mcpStatus, mcpServers);
                return (
                  <button
                    key={entry.id}
                    type="button"
                    className="qj-conn-row"
                    onClick={() => openBotConnector(entry.id, "browser")}
                  >
                    <ConnectorBrandIcon id={entry.id} icon={entry.icon} iconBg={entry.iconBg} size={34} />
                    <div className="qj-conn-row-copy">
                      <div className="qj-conn-row-name">{entry.name}</div>
                      <div className="qj-conn-row-sub">{entry.tagline}</div>
                    </div>
                    <div className="qj-conn-row-right">
                      <span className={`qj-conn-action-chip${st.connected ? " connected" : ""}`}>
                        {st.connected ? "已授权" : "查看"}
                      </span>
                      <ChevronRight size={14} className="qj-conn-row-chevron" />
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        )}
      </div>
    );
  }

  if (ui.settingsTab === "vault") {
    const cfgs = snapshot.connectorConfigs;
    const vaultRows: ReadonlyArray<{
      readonly label: string;
      readonly status: string;
      readonly active: boolean;
      readonly actionLabel: string;
      readonly onJump: () => void;
    }> = [
      {
        label: "远端虚拟服务器 SSH 凭据",
        status: snapshot.virtualServer.remote.hasStoredSecret ? "已加密存入保险箱" : "走系统 ssh-agent / 未存密码",
        active: Boolean(snapshot.virtualServer.remote.hasStoredSecret),
        actionLabel: "虚拟服务器",
        onJump: () => patchBotUi({ settingsTab: "server" }),
      },
      {
        label: "IMAP 邮箱授权码",
        status: cfgs.email.hasPassword ? `已加密托管 (${cfgs.email.emailAddress || "邮箱"})` : "尚未保存授权码",
        active: Boolean(cfgs.email.hasPassword),
        actionLabel: "配置邮箱",
        onJump: () => openBotConnector("imap_email", "vault"),
      },
      {
        label: "飞书 / Telegram 渠道密钥",
        status:
          cfgs.meetingsIm.hasFeishuWebhook || cfgs.meetingsIm.hasTelegramToken
            ? "Webhook / Bot Token 已加密"
            : "尚未绑定即时通讯密钥",
        active: Boolean(cfgs.meetingsIm.hasFeishuWebhook || cfgs.meetingsIm.hasTelegramToken),
        actionLabel: "消息渠道",
        onJump: () => patchBotUi({ settingsTab: "channels" }),
      },
      {
        label: "GitHub / 自定义 Webhook 令牌",
        status: cfgs.github?.hasToken || cfgs.customWebhook?.enabled ? "访问令牌已加密托管" : "按需在连接器中授权",
        active: Boolean(cfgs.github?.hasToken || cfgs.customWebhook?.enabled),
        actionLabel: "连接器",
        onJump: () => patchBotUi({ settingsTab: "connectors", activeConnectorId: null }),
      },
    ];

    return (
      <div className="qj-bset-stack">
        <section className="qj-bset-group">
          <div className="qj-bset-group-head">
            <span className="qj-bset-group-title">系统级加密凭据底座</span>
          </div>
          <div className="qj-bset-card">
            <div className="qj-bset-row">
              <div className="qj-bset-row-copy">
                <div className="qj-bset-row-title">
                  <KeyRound size={14.5} className="qj-bset-inline-icon" />
                  <span>OS Keychain 硬件级密钥保险箱</span>
                </div>
                <div className="qj-bset-row-desc">
                  所有模型供应商 API Key 与外部凭据均由千机桌面底座统一加密存储，分身对话、SOUL.md 与记忆账本中绝不明文落盘。
                </div>
              </div>
              <button
                type="button"
                className="qj-bset-btn primary sm"
                onClick={() => patchBotUi({ settingsTab: "models" })}
              >
                <span>管理模型供应商与密钥</span>
                <ArrowRight size={13} />
              </button>
            </div>
          </div>
        </section>

        <section className="qj-bset-group">
          <div className="qj-bset-group-head">
            <span className="qj-bset-group-title">分身凭据托管概览</span>
          </div>
          <div className="qj-bset-card">
            {vaultRows.map((item) => (
              <div key={item.label} className="qj-bset-row">
                <div className="qj-bset-row-copy">
                  <div className="qj-bset-row-title">
                    <span className="qj-bset-status-dot" data-tone={item.active ? "success" : "muted"} />
                    <span>{item.label}</span>
                  </div>
                  <div className="qj-bset-row-desc">{item.status}</div>
                </div>
                <button type="button" className="qj-bset-btn soft xs" onClick={item.onJump}>
                  <span>{item.actionLabel}</span>
                  <ArrowRight size={12} />
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>
    );
  }

  const connectedApps = mergedCatalog.map((entry) => ({
    entry,
    state: resolveConnectorState(entry, snapshot, ui.mcpStatus, mcpServers),
  })).filter((x) => x.state.connected);

  return (
    <div className="qj-bset-stack">
      <section className="qj-bset-group">
        <div className="qj-bset-group-head">
          <span className="qj-bset-group-title">对外动作强制审批边界</span>
        </div>
        <div className="qj-bset-card">
          <div className="qj-bset-row">
            <div className="qj-bset-row-copy">
              <div className="qj-bset-row-title">本地只读检索与笔记沉淀</div>
              <div className="qj-bset-row-desc">受控工作区 `/workspace` 内的分析、整理与草稿撰写自动执行不打断</div>
            </div>
            <span className="qj-conn-cap-badge allow">自动放行</span>
          </div>
          <div className="qj-bset-row">
            <div className="qj-bset-row-copy">
              <div className="qj-bset-row-title">对外发信、推送代码与高敏命令</div>
              <div className="qj-bset-row-desc">
                任何邮件发送、IM 群发、Git 推送、删除外部文件均自动拦截并排入右侧「批准」栏
              </div>
            </div>
            <span className="qj-conn-cap-badge ask">强制审批</span>
          </div>
          <div className="qj-bset-subbar between">
            <span className="qj-bset-muted-label">
              当前共有 <strong>{snapshot.pendingApprovals.length}</strong> 项外部动作等待你的审批确认
            </span>
            <button
              type="button"
              className="qj-bset-btn primary sm"
              onClick={() =>
                patchBotUi({ activeView: "chat", modal: null, rightPanelOpen: true, rightTab: "approvals" })
              }
            >
              <ShieldCheck size={13.5} />
              <span>查看当前待批准项 ({snapshot.pendingApprovals.length})</span>
            </button>
          </div>
        </div>
      </section>

      <section className="qj-bset-group">
        <div className="qj-bset-group-head">
          <span className="qj-bset-group-title">已连接应用权限策略</span>
          <button
            type="button"
            className="qj-bset-text-link"
            onClick={() => patchBotUi({ settingsTab: "connectors", activeConnectorId: null })}
          >
            <span>连接器目录</span>
            <ArrowRight size={12.5} />
          </button>
        </div>
        {connectedApps.length === 0 ? (
          <div className="qj-bset-card qj-bset-empty-card">
            <span>暂未连接外部应用，授权后可在此逐个检视与调整读写权限。</span>
            <button
              type="button"
              className="qj-bset-btn soft sm"
              onClick={() => patchBotUi({ settingsTab: "connectors", activeConnectorId: null })}
            >
              前往连接器
            </button>
          </div>
        ) : (
          <div className="qj-conn-list">
            {connectedApps.map(({ entry, state }) => (
              <button
                key={entry.id}
                type="button"
                className="qj-conn-row"
                onClick={() => openBotConnector(entry.id, "permissions")}
              >
                <ConnectorBrandIcon id={entry.id} icon={entry.icon} iconBg={entry.iconBg} size={34} />
                <div className="qj-conn-row-copy">
                  <div className="qj-conn-row-name">{entry.name}</div>
                  <div className="qj-conn-row-sub">{state.accountLabel || entry.tagline}</div>
                </div>
                <div className="qj-conn-row-right">
                  <span className="qj-conn-action-chip">{POLICY_TIER_LABELS[state.policyTier]}</span>
                  <ChevronRight size={14} className="qj-conn-row-chevron" />
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
