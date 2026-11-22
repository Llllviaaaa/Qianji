/**
 * Real Connected Apps Console (`连接器` tab) in Bot Settings
 * (`src/builtin-plugins/bot-mode/BotConnectorsConsole.tsx`).
 */
import { useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { useFrontendService } from "@qianji/client";
import { Switch } from "@qianji/client-primitives";
import type { BotEmailPreset } from "@qianji/protocol";
import { useBotController, useBotSnapshot, useBotUiState } from "./botStore";

const EMAIL_PRESETS: ReadonlyArray<{ readonly id: BotEmailPreset; readonly label: string; readonly imapHost: string; readonly imapPort: number; readonly imapTls: boolean; readonly smtpHost: string; readonly smtpPort: number; readonly smtpTls: boolean }> = [
  { id: "qq", label: "QQ 邮箱", imapHost: "imap.qq.com", imapPort: 993, imapTls: true, smtpHost: "smtp.qq.com", smtpPort: 465, smtpTls: true },
  { id: "163", label: "网易 163 邮箱", imapHost: "imap.163.com", imapPort: 993, imapTls: true, smtpHost: "smtp.163.com", smtpPort: 465, smtpTls: true },
  { id: "gmail", label: "Gmail", imapHost: "imap.gmail.com", imapPort: 993, imapTls: true, smtpHost: "smtp.gmail.com", smtpPort: 465, smtpTls: true },
  { id: "outlook", label: "Outlook / 365", imapHost: "outlook.office365.com", imapPort: 993, imapTls: true, smtpHost: "smtp.office365.com", smtpPort: 587, smtpTls: false },
  { id: "custom", label: "自定义 IMAP/SMTP", imapHost: "", imapPort: 993, imapTls: true, smtpHost: "", smtpPort: 465, smtpTls: true },
];

const inputStyle = {
  width: "100%",
  padding: "7px 10px",
  borderRadius: 10,
  border: "1px solid var(--qj-border-default)",
  background: "var(--qj-bg-surface)",
  color: "var(--qj-text-primary)",
  fontSize: 12,
  outline: "none",
} as const;

export function BotConnectorsConsole({ ctx }: { readonly ctx?: Context }): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const workspaceService = useFrontendService("workspaceService", ctx);
  const cfgs = snapshot.connectorConfigs;

  const [emailPreset, setEmailPreset] = useState<BotEmailPreset>(cfgs.email.preset);
  const [emailAddr, setEmailAddr] = useState(cfgs.email.emailAddress);
  const [emailPass, setEmailPass] = useState("");
  const [imapHost, setImapHost] = useState(cfgs.email.imapHost);
  const [imapPort, setImapPort] = useState(String(cfgs.email.imapPort));
  const [imapTls, setImapTls] = useState(cfgs.email.imapTls);
  const [smtpHost, setSmtpHost] = useState(cfgs.email.smtpHost);
  const [smtpPort, setSmtpPort] = useState(String(cfgs.email.smtpPort));
  const [smtpTls, setSmtpTls] = useState(cfgs.email.smtpTls);

  const [icsUrl, setIcsUrl] = useState(cfgs.calendar.icsUrl);
  const [localIcs, setLocalIcs] = useState(cfgs.calendar.localIcsPath);
  const [leadMinutes, setLeadMinutes] = useState(String(cfgs.calendar.leadMinutes));

  const [procInput, setProcInput] = useState("");
  const [notesDir, setNotesDir] = useState(cfgs.meetingsIm.meetingNotesDir);
  const [tgChatId, setTgChatId] = useState(cfgs.meetingsIm.telegramChatId);
  const [tgToken, setTgToken] = useState("");
  const [feishuUrl, setFeishuUrl] = useState("");

  const handlePresetChange = (next: BotEmailPreset) => {
    setEmailPreset(next);
    const meta = EMAIL_PRESETS.find((p) => p.id === next);
    if (meta && next !== "custom") {
      setImapHost(meta.imapHost);
      setImapPort(String(meta.imapPort));
      setImapTls(meta.imapTls);
      setSmtpHost(meta.smtpHost);
      setSmtpPort(String(meta.smtpPort));
      setSmtpTls(meta.smtpTls);
    }
  };

  const saveAndTestEmail = async () => {
    await ctrl.configureBot({
      email: {
        enabled: true,
        preset: emailPreset,
        emailAddress: emailAddr.trim(),
        imapHost: imapHost.trim(),
        imapPort: Number(imapPort) || 993,
        imapTls,
        smtpHost: smtpHost.trim(),
        smtpPort: Number(smtpPort) || 465,
        smtpTls,
        ...(emailPass !== "" ? { password: emailPass } : {}),
      },
    });
    setEmailPass("");
    await ctrl.testConnector("email");
  };

  const saveAndTestCalendar = async () => {
    await ctrl.configureBot({
      calendar: {
        enabled: true,
        icsUrl: icsUrl.trim(),
        localIcsPath: localIcs.trim(),
        leadMinutes: Number(leadMinutes) || 15,
      },
    });
    await ctrl.testConnector("calendar");
  };

  const addWatchedProcess = async () => {
    const clean = procInput.trim();
    if (clean === "") return;
    setProcInput("");
    await ctrl.configureBot({
      processSensor: {
        watchedProcesses: [...cfgs.processSensor.watchedProcesses, clean],
      },
    });
  };

  const saveAndTestMeetingsIm = async () => {
    await ctrl.configureBot({
      meetingsIm: {
        meetingNotesEnabled: notesDir.trim() !== "",
        meetingNotesDir: notesDir.trim(),
        telegramEnabled: tgChatId.trim() !== "" || Boolean(cfgs.meetingsIm.hasTelegramToken) || tgToken !== "",
        telegramChatId: tgChatId.trim(),
        ...(tgToken !== "" ? { telegramToken: tgToken } : {}),
        ...(feishuUrl !== "" ? { feishuEnabled: true, feishuWebhook: feishuUrl } : {}),
      },
    });
    setTgToken("");
    setFeishuUrl("");
    await ctrl.testConnector("meetings_im");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 12 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>日常应用与状态连接器</h3>
        <p style={{ margin: "4px 0 0", color: "var(--qj-text-secondary)" }}>
          配置后，分身将按你的节奏定时检查邮箱、日程、长任务与会议记录，提前做好规划与回信草稿。
        </p>
      </div>

      {ui.serverFeedback && (
        <div style={{ padding: "8px 12px", borderRadius: 12, background: "var(--muse-soft-fill)", color: "var(--qj-text-primary)" }}>
          {ui.serverFeedback}
        </div>
      )}

      {/* 1. Email IMAP/SMTP */}
      <section style={{ padding: 14, borderRadius: 16, background: "var(--muse-soft-fill)", display: "flex", flexDirection: "column", gap: 9 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>邮箱贴身管家（IMAP 收信 / SMTP 草稿投递）</div>
            <div style={{ color: "var(--qj-text-secondary)", marginTop: 2 }}>
              密码或授权码仅写入系统加密保险箱 · 对外发信前必经「批准」栏确认
            </div>
          </div>
          <Switch
            checked={cfgs.email.enabled}
            onCheckedChange={(checked) => void ctrl.configureBot({ email: { enabled: checked } })}
            aria-label="启用邮箱连接器"
          />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "140px 1fr 1fr", gap: 8 }}>
          <select aria-label="邮箱服务商" value={emailPreset} onChange={(e) => handlePresetChange(e.target.value as BotEmailPreset)} style={inputStyle}>
            {EMAIL_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
          <input type="email" aria-label="邮箱地址" placeholder="you@qq.com / 公司邮箱" value={emailAddr} onChange={(e) => setEmailAddr(e.target.value)} style={inputStyle} />
          <input type="password" aria-label="邮箱授权码或密码" placeholder={cfgs.email.hasPassword ? "••••••（已加密保存，留空沿用）" : "输入授权码或登录密码"} value={emailPass} onChange={(e) => setEmailPass(e.target.value)} style={inputStyle} />
        </div>
        {emailPreset === "custom" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 76px 1fr 76px", gap: 8 }}>
              <input type="text" aria-label="IMAP 主机" placeholder="IMAP 主机" value={imapHost} onChange={(e) => setImapHost(e.target.value)} style={inputStyle} />
              <input type="number" aria-label="IMAP 端口" value={imapPort} onChange={(e) => setImapPort(e.target.value)} style={inputStyle} />
              <input type="text" aria-label="SMTP 主机" placeholder="SMTP 主机" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} style={inputStyle} />
              <input type="number" aria-label="SMTP 端口" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} style={inputStyle} />
            </div>
            <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--qj-text-secondary)" }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input type="checkbox" aria-label="IMAP TLS" checked={imapTls} onChange={(e) => setImapTls(e.target.checked)} />
                <span>IMAP 启用 SSL/TLS</span>
              </label>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input type="checkbox" aria-label="SMTP TLS" checked={smtpTls} onChange={(e) => setSmtpTls(e.target.checked)} />
                <span>SMTP 启用 SSL/TLS</span>
              </label>
            </div>
          </>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <span style={{ color: cfgs.email.lastError ? "var(--qj-status-error)" : "var(--qj-text-secondary)" }}>
            {cfgs.email.lastError
              ? cfgs.email.lastError
              : cfgs.email.lastSyncAt
                ? `最近同步：${new Date(cfgs.email.lastSyncAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
                : "填写授权码后点击右侧按钮测试收信"}
          </span>
          <button type="button" data-testid="test-email-connector" disabled={ui.serverBusy} className="qj-primary-pill-btn" style={{ height: 30, padding: "0 14px", fontSize: 12 }} onClick={() => void saveAndTestEmail()}>
            测试并收信
          </button>
        </div>
      </section>

      {/* 2. Calendar & Meetings */}
      <section style={{ padding: 14, borderRadius: 16, background: "var(--muse-soft-fill)", display: "flex", flexDirection: "column", gap: 9 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>日历与会议参谋（ICS 订阅 / 本地日程）</div>
            <div style={{ color: "var(--qj-text-secondary)", marginTop: 2 }}>
              今日已同步 {snapshot.awareness.todayEvents.length} 项日程 · 冲突 {snapshot.awareness.conflictCount} 处
            </div>
          </div>
          <Switch
            checked={cfgs.calendar.enabled}
            onCheckedChange={(checked) => void ctrl.configureBot({ calendar: { enabled: checked } })}
            aria-label="启用日历连接器"
          />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 110px", gap: 8 }}>
          <input type="text" aria-label="ICS 订阅地址" placeholder="https:// 或 webcal:// 日历订阅链接" value={icsUrl} onChange={(e) => setIcsUrl(e.target.value)} style={inputStyle} />
          <input type="text" aria-label="本地 ICS 路径" placeholder="或填写本地 .ics 文件/目录路径" value={localIcs} onChange={(e) => setLocalIcs(e.target.value)} style={inputStyle} />
          <select aria-label="会前提前提醒" value={leadMinutes} onChange={(e) => setLeadMinutes(e.target.value)} style={inputStyle}>
            <option value="5">会前 5 分钟</option>
            <option value="15">会前 15 分钟</option>
            <option value="30">会前 30 分钟</option>
          </select>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" data-testid="test-calendar-connector" disabled={ui.serverBusy} className="qj-soft-btn" style={{ height: 30, padding: "0 14px", fontSize: 12, background: "var(--qj-bg-surface)" }} onClick={() => void saveAndTestCalendar()}>
            保存并同步日程
          </button>
        </div>
      </section>

      {/* 3. Process & Focus Sensor */}
      <section style={{ padding: 14, borderRadius: 16, background: "var(--muse-soft-fill)", display: "flex", flexDirection: "column", gap: 9 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>电脑进程与专注状态感知</div>
            <div style={{ color: "var(--qj-text-secondary)", marginTop: 2 }}>
              开会/专注自动防打扰 · 实时感知状态：{snapshot.awareness.busyState}
            </div>
          </div>
          <Switch
            checked={cfgs.processSensor.enabled}
            onCheckedChange={(checked) => void ctrl.configureBot({ processSensor: { enabled: checked } })}
            aria-label="启用进程与状态感知"
          />
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ color: "var(--qj-text-secondary)" }}>长任务盯守进程：</span>
          {cfgs.processSensor.watchedProcesses.map((proc) => (
            <span key={proc} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 9999, background: "var(--qj-bg-surface)" }}>
              <span>{proc}</span>
              <button
                type="button"
                onClick={() => void ctrl.configureBot({ processSensor: { watchedProcesses: cfgs.processSensor.watchedProcesses.filter((p) => p !== proc) } })}
                style={{ border: 0, background: "transparent", cursor: "pointer", padding: 0, color: "var(--qj-text-muted)" }}
              >
                ×
              </button>
            </span>
          ))}
          <input
            type="text"
            aria-label="添加盯守进程名"
            placeholder="如 cargo / ffmpeg / python"
            value={procInput}
            onChange={(e) => setProcInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void addWatchedProcess(); }}
            style={{ ...inputStyle, width: 170, padding: "4px 10px" }}
          />
          <button type="button" onClick={() => void addWatchedProcess()} style={{ height: 28, padding: "0 10px", borderRadius: 9999, border: 0, background: "var(--qj-bg-surface)", cursor: "pointer" }}>
            + 盯守
          </button>
          <button type="button" onClick={() => void ctrl.testConnector("processes")} style={{ marginLeft: "auto", height: 28, padding: "0 10px", borderRadius: 9999, border: 0, background: "var(--qj-bg-surface)", cursor: "pointer" }}>
            立即检测状态
          </button>
        </div>
      </section>

      {/* 4. Meeting Notes & External IM */}
      <section style={{ padding: 14, borderRadius: 16, background: "var(--muse-soft-fill)", display: "flex", flexDirection: "column", gap: 9 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>会议纪要目录与外部消息（Telegram / 飞书 Webhook）</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input type="text" aria-label="会议纪要文件夹" placeholder="会议纪要文件夹路径（支持 .md / .txt / .srt / .vtt）" value={notesDir} onChange={(e) => setNotesDir(e.target.value)} style={inputStyle} />
          <button
            type="button"
            onClick={async () => {
              const picked = await workspaceService?.pickFolder().catch(() => null);
              if (picked) setNotesDir(picked);
            }}
            style={{ height: 32, padding: "0 12px", borderRadius: 10, border: 0, background: "var(--qj-bg-surface)", cursor: "pointer", flexShrink: 0 }}
          >
            选择目录
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          <input type="text" aria-label="Telegram Chat ID" placeholder="Telegram Chat ID（可选）" value={tgChatId} onChange={(e) => setTgChatId(e.target.value)} style={inputStyle} />
          <input type="password" aria-label="Telegram Bot Token" placeholder={cfgs.meetingsIm.hasTelegramToken ? "已保存 Token（留空沿用）" : "Telegram Bot Token"} value={tgToken} onChange={(e) => setTgToken(e.target.value)} style={inputStyle} />
          <input type="password" aria-label="飞书 Webhook 地址" placeholder={cfgs.meetingsIm.hasFeishuWebhook ? "已保存飞书 Webhook" : "飞书自定义机器人 Webhook"} value={feishuUrl} onChange={(e) => setFeishuUrl(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" data-testid="test-meetings-im-connector" disabled={ui.serverBusy} className="qj-soft-btn" style={{ height: 30, padding: "0 14px", fontSize: 12, background: "var(--qj-bg-surface)" }} onClick={() => void saveAndTestMeetingsIm()}>
            同步纪要与消息渠道
          </button>
        </div>
      </section>
    </div>
  );
}