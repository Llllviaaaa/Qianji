/**
 * Channels (`消息渠道`) and Data Control (`数据控制`) panes for Bot Settings
 * (`src/builtin-plugins/bot-mode/BotChannelsAndDataPanes.tsx`).
 */
import { useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { ArrowRight, ChevronRight, Download, FilePenLine, Trash2 } from "lucide-react";
import { ConnectorBrandIcon } from "./BotConnectorLogos";
import {
  openBotConnector,
  openBotModal,
  patchBotUi,
  useBotController,
  useBotSnapshot,
  useBotUiState,
} from "./botStore";

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

export function BotChannelsSettingsPane({ ctx }: { readonly ctx?: Context }): ReactElement {
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const [editingChannel, setEditingChannel] = useState<"feishu" | "telegram" | null>(null);
  const [feishuUrl, setFeishuUrl] = useState("");
  const [tgChatId, setTgChatId] = useState(snapshot.connectorConfigs.meetingsIm.telegramChatId);
  const [tgToken, setTgToken] = useState("");

  const im = snapshot.connectorConfigs.meetingsIm;
  const feishuConnected = im.feishuEnabled && Boolean(im.hasFeishuWebhook);
  const tgConnected = im.telegramEnabled && Boolean(im.hasTelegramToken);
  const mailCfg = snapshot.connectorConfigs.email;
  const gmailPol = snapshot.connectorConfigs.appPolicies?.gmail;
  const gmailConnected = Boolean(gmailPol?.connected);
  const anyMailConnected = mailCfg.enabled || gmailConnected;

  return (
    <div className="qj-bset-stack">
      <section className="qj-bset-group">
        <div className="qj-bset-group-head">
          <span className="qj-bset-group-title">分身聚合收件箱</span>
        </div>
        <div className="qj-bset-card">
          <div className="qj-bset-row">
            <div className="qj-bset-row-copy">
              <div className="qj-bset-row-title">
                <span className="qj-bset-status-dot" data-tone={snapshot.inboxEnabled ? "success" : "muted"} />
                <span>分身专属收件箱</span>
              </div>
              <div className="qj-bset-row-desc">
                {snapshot.inboxEnabled
                  ? `专属收件通道已启用（${snapshot.inboxAddress || "local-inbox"}），所有来源摘要集中呈现在右侧「邮箱」标签。`
                  : "启用专属收件通道，或绑定下方即时通讯与外部邮箱，随时远程派发任务与接收简报。"}
              </div>
            </div>
            {snapshot.inboxEnabled ? (
              <button
                type="button"
                className="qj-bset-btn soft sm"
                onClick={() =>
                  patchBotUi({ activeView: "chat", modal: null, rightPanelOpen: true, rightTab: "inbox" })
                }
              >
                <span>打开收件箱</span>
                <ArrowRight size={12.5} />
              </button>
            ) : (
              <button type="button" className="qj-bset-btn primary sm" onClick={() => void ctrl.enableInbox()}>
                启用专属收件箱
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="qj-bset-group">
        <div className="qj-bset-group-head">
          <span className="qj-bset-group-title">即时通讯与邮箱绑定</span>
        </div>
        <div className="qj-conn-list">
          <div className="qj-conn-section-card">
            <div className="qj-bset-row-top">
              <div className="qj-bset-channel-meta">
                <ConnectorBrandIcon id="feishu" size={36} />
                <div>
                  <div className="qj-conn-row-name">飞书机器人</div>
                  <div className="qj-conn-row-sub">通过群机器人同步日报并在「批准」后向团队发送消息</div>
                </div>
              </div>
              <button
                type="button"
                className="qj-bset-btn soft sm"
                onClick={() => setEditingChannel((c) => (c === "feishu" ? null : "feishu"))}
              >
                {feishuConnected ? "已绑定 · 修改" : "绑定"}
              </button>
            </div>
            {editingChannel === "feishu" && (
              <div className="qj-conn-form-foot">
                <input
                  type="password"
                  aria-label="飞书 Webhook 地址"
                  placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
                  value={feishuUrl}
                  onChange={(e) => setFeishuUrl(e.target.value)}
                  className="qj-conn-input mono"
                />
                <button
                  type="button"
                  data-testid="test-feishu-connector"
                  className="qj-bset-btn primary sm"
                  onClick={async () => {
                    await ctrl.configureBot({
                      meetingsIm: { feishuEnabled: true, ...(feishuUrl !== "" ? { feishuWebhook: feishuUrl } : {}) },
                    });
                    setFeishuUrl("");
                    await ctrl.testConnector("feishu");
                  }}
                >
                  保存并校验
                </button>
              </div>
            )}
          </div>

          <div className="qj-conn-section-card">
            <div className="qj-bset-row-top">
              <div className="qj-bset-channel-meta">
                <ConnectorBrandIcon id="telegram" size={36} />
                <div>
                  <div className="qj-conn-row-name">Telegram Bot</div>
                  <div className="qj-conn-row-sub">
                    {im.telegramChatId
                      ? `已绑定 Chat ID: ${im.telegramChatId}`
                      : "移动端随时向分身派发任务与接收提醒"}
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="qj-bset-btn soft sm"
                onClick={() => setEditingChannel((c) => (c === "telegram" ? null : "telegram"))}
              >
                {tgConnected ? "已连接 · 管理" : "绑定"}
              </button>
            </div>
            {editingChannel === "telegram" && (
              <div className="qj-bset-stack-sm">
                <div className="qj-conn-grid-2">
                  <input
                    type="text"
                    aria-label="Telegram Chat ID"
                    placeholder="Chat ID（可选）"
                    value={tgChatId}
                    onChange={(e) => setTgChatId(e.target.value)}
                    className="qj-conn-input mono"
                  />
                  <input
                    type="password"
                    aria-label="Telegram Bot Token"
                    placeholder={im.hasTelegramToken ? "••••••（已加密保存）" : "BotFather Bot Token"}
                    value={tgToken}
                    onChange={(e) => setTgToken(e.target.value)}
                    className="qj-conn-input"
                  />
                </div>
                <div className="qj-bset-end-actions">
                  <button
                    type="button"
                    data-testid="test-telegram-connector"
                    className="qj-bset-btn primary sm"
                    onClick={async () => {
                      await ctrl.configureBot({
                        meetingsIm: {
                          telegramEnabled: true,
                          telegramChatId: tgChatId.trim(),
                          ...(tgToken !== "" ? { telegramToken: tgToken } : {}),
                        },
                      });
                      setTgToken("");
                      await ctrl.testConnector("telegram");
                    }}
                  >
                    连接并校验
                  </button>
                </div>
              </div>
            )}
          </div>

          <button type="button" className="qj-conn-row" onClick={() => openBotConnector("slack", "channels")}>
            <ConnectorBrandIcon id="slack" size={36} />
            <div className="qj-conn-row-copy">
              <div className="qj-conn-row-name">Slack 工作区</div>
              <div className="qj-conn-row-sub">一键网页授权并细粒度控制频道写入权限</div>
            </div>
            <div className="qj-conn-row-right">
              <span className="qj-conn-action-chip">打开连接器</span>
              <ChevronRight size={14} className="qj-conn-row-chevron" />
            </div>
          </button>

          <button
            type="button"
            className="qj-conn-row"
            onClick={() =>
              openBotConnector(
                gmailConnected ? "gmail" : mailCfg.enabled ? (mailCfg.preset === "outlook" ? "outlook" : "imap_email") : "gmail",
                "channels",
              )
            }
          >
            <ConnectorBrandIcon id="gmail" size={36} />
            <div className="qj-conn-row-copy">
              <div className="qj-conn-row-name">外部电子邮箱 (Gmail MCP / Outlook / IMAP)</div>
              <div className="qj-conn-row-sub">
                {gmailConnected
                  ? `已连接 Gmail MCP：${gmailPol?.accountLabel || "自动同步已开启"}`
                  : mailCfg.enabled && mailCfg.emailAddress
                    ? `已接入邮箱：${mailCfg.emailAddress}`
                    : "通过标准 Gmail MCP 或 ImapFlow 接入邮箱，开启来信同步与草拟回复"}
              </div>
            </div>
            <div className="qj-conn-row-right">
              <span className={`qj-conn-action-chip${anyMailConnected ? " connected" : ""}`}>
                {anyMailConnected ? "已连接" : "去配置"}
              </span>
              <ChevronRight size={14} className="qj-conn-row-chevron" />
            </div>
          </button>
        </div>
      </section>
    </div>
  );
}

export function BotDataControlSettingsPane({ ctx }: { readonly ctx?: Context }): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <div className="qj-bset-stack">
      <section className="qj-bset-group">
        <div className="qj-bset-group-head">
          <span className="qj-bset-group-title">透明契约与长期记忆档案</span>
        </div>
        <div className="qj-bset-grid-2">
          <div className="qj-bset-doc-card">
            <div>
              <div className="qj-bset-row-title">SOUL.md · 灵魂契约</div>
              <div className="qj-bset-row-desc">
                定义分身的性格底色、沟通语气与行事准则（更新于 {snapshot.soulUpdatedAt}）
              </div>
            </div>
            <div className="qj-bset-inline-controls">
              <button
                type="button"
                className="qj-bset-btn primary xs"
                onClick={() => openBotModal("soul", undefined, { returnToCurrent: true })}
              >
                <FilePenLine size={12} />
                <span>在线编辑</span>
              </button>
              <button
                type="button"
                className="qj-bset-btn soft xs"
                onClick={() => downloadMarkdownFile("SOUL.md", snapshot.soulContent)}
              >
                <Download size={12} />
                <span>导出 SOUL.md</span>
              </button>
            </div>
          </div>

          <div className="qj-bset-doc-card">
            <div>
              <div className="qj-bset-row-title">MEMORY.md · 长期记忆</div>
              <div className="qj-bset-row-desc">
                记录你的偏好、长期目标与关键协作上下文（更新于 {snapshot.memoryUpdatedAt}）
              </div>
            </div>
            <div className="qj-bset-inline-controls">
              <button
                type="button"
                className="qj-bset-btn primary xs"
                onClick={() => openBotModal("memory", undefined, { returnToCurrent: true })}
              >
                <FilePenLine size={12} />
                <span>在线编辑</span>
              </button>
              <button
                type="button"
                className="qj-bset-btn soft xs"
                onClick={() => downloadMarkdownFile("MEMORY.md", ui.memoryContent || "# MEMORY.md\n")}
              >
                <Download size={12} />
                <span>导出 MEMORY.md</span>
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="qj-bset-group">
        <div className="qj-bset-group-head">
          <span className="qj-bset-group-title">重置与清理</span>
        </div>
        <div className="qj-bset-card danger">
          <div className="qj-bset-row">
            <div className="qj-bset-row-copy">
              <div className="qj-bset-row-title">清空 Bot 对话与状态数据</div>
              <div className="qj-bset-row-desc">
                重置主聊天、旁聊、空间、目标与动态记录，恢复全新初始状态（操作不可撤销）
              </div>
            </div>
            {confirmReset ? (
              <div className="qj-bset-inline-controls">
                <button type="button" className="qj-bset-btn soft sm" onClick={() => setConfirmReset(false)}>
                  取消
                </button>
                <button
                  type="button"
                  className="qj-bset-btn danger sm"
                  onClick={() => {
                    setConfirmReset(false);
                    void ctrl.resetAllData();
                  }}
                >
                  确认清空
                </button>
              </div>
            ) : (
              <button type="button" className="qj-bset-btn danger-outline sm" onClick={() => setConfirmReset(true)}>
                <Trash2 size={13} />
                <span>清空重置</span>
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
