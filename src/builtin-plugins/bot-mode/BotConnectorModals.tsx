/**
 * Clean modal wizards (`BotConnectorModals.tsx`) for protocol-based connectors
 * (QQ / 163 / Custom IMAP, Zapier Webhook, and optional GitHub / Calendar sync).
 * Keeps the main Connector Detail page 100% free of inline input clutter.
 */
import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { X } from "lucide-react";
import type { BotEmailPreset } from "@qianji/protocol";
import { useBotController, useBotSnapshot, useBotUiState } from "./botStore";

export type ConnectorModalKind = "imap" | "webhook" | "github-sync" | "calendar-sync" | null;

const MAIL_PRESETS: Readonly<Record<BotEmailPreset, { label: string; imapHost: string; imapPort: number; imapTls: boolean; smtpHost: string; smtpPort: number; smtpTls: boolean }>> = {
  qq: { label: "QQ 邮箱 (imap.qq.com)", imapHost: "imap.qq.com", imapPort: 993, imapTls: true, smtpHost: "smtp.qq.com", smtpPort: 465, smtpTls: true },
  "163": { label: "网易 163 邮箱", imapHost: "imap.163.com", imapPort: 993, imapTls: true, smtpHost: "smtp.163.com", smtpPort: 465, smtpTls: true },
  gmail: { label: "Gmail (IMAP 应用密码)", imapHost: "imap.gmail.com", imapPort: 993, imapTls: true, smtpHost: "smtp.gmail.com", smtpPort: 465, smtpTls: true },
  outlook: { label: "Outlook / 365", imapHost: "outlook.office365.com", imapPort: 993, imapTls: true, smtpHost: "smtp.office365.com", smtpPort: 587, smtpTls: false },
  custom: { label: "自定义公司 IMAP/SMTP", imapHost: "", imapPort: 993, imapTls: true, smtpHost: "", smtpPort: 465, smtpTls: true },
};

export function BotConnectorModal({
  kind,
  defaultEmailPreset,
  ctx,
  onClose,
}: {
  readonly kind: ConnectorModalKind;
  readonly defaultEmailPreset?: BotEmailPreset;
  readonly ctx?: Context;
  readonly onClose: () => void;
}): ReactElement | null {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const cfgs = snapshot.connectorConfigs;

  const [preset, setPreset] = useState<BotEmailPreset>(defaultEmailPreset ?? (cfgs.email.preset === "gmail" || cfgs.email.preset === "outlook" ? "qq" : cfgs.email.preset));
  const [emailAddr, setEmailAddr] = useState(cfgs.email.emailAddress);
  const [emailPass, setEmailPass] = useState("");
  const [imapHost, setImapHost] = useState(MAIL_PRESETS[preset].imapHost);
  const [smtpHost, setSmtpHost] = useState(MAIL_PRESETS[preset].smtpHost);

  const [whLabel, setWhLabel] = useState(cfgs.customWebhook?.label ?? "Zapier / Webhook");
  const [whUrl, setWhUrl] = useState(cfgs.customWebhook?.endpointUrl ?? "");
  const [whSecret, setWhSecret] = useState("");

  const [ghToken, setGhToken] = useState("");
  const [icsUrl, setIcsUrl] = useState(cfgs.calendar.icsUrl);

  useEffect(() => {
    if (!kind || typeof window === "undefined") return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [kind, onClose]);

  if (!kind) return null;

  const submitImap = async (e: FormEvent) => {
    e.preventDefault();
    const m = MAIL_PRESETS[preset];
    await ctrl.configureBot({
      email: {
        enabled: true,
        preset,
        emailAddress: emailAddr.trim(),
        imapHost: imapHost.trim() || m.imapHost,
        imapPort: m.imapPort,
        imapTls: m.imapTls,
        smtpHost: smtpHost.trim() || m.smtpHost,
        smtpPort: m.smtpPort,
        smtpTls: m.smtpTls,
        ...(emailPass !== "" ? { password: emailPass } : {}),
      },
      appPolicies: {
        ...(preset === "gmail" || preset === "outlook"
          ? { [preset]: { connected: true, authKind: "api", accountLabel: emailAddr.trim(), connectedAt: Date.now(), policy: "low-risk-auto", backgroundSync: true } }
          : { imap_email: { connected: true, authKind: "api", accountLabel: emailAddr.trim(), connectedAt: Date.now(), policy: "low-risk-auto", backgroundSync: true } }),
      },
    });
    await ctrl.testConnector("email");
    onClose();
  };

  return (
    <div className="qj-bot-modal-backdrop" data-escape-layer="" onClick={onClose} style={{ zIndex: 380 }}>
      <div className="qj-bot-dialog qj-muse-compact-modal" onClick={(e) => e.stopPropagation()}>
        <div className="qj-muse-modal-head">
          <span className="qj-muse-modal-title">
            {kind === "imap"
              ? "配置 IMAP / 授权码邮箱"
              : kind === "webhook"
                ? "配置 Zapier / Webhook"
                : kind === "github-sync"
                  ? "连接 GitHub Token（自动同步仓库）"
                  : "连接日历订阅 (ICS)"}
          </span>
          <button type="button" aria-label="关闭弹窗" className="qj-muse-modal-close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {kind === "imap" && (
          <form onSubmit={(e) => void submitImap(e)} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <select
              aria-label="邮箱类型"
              value={preset}
              onChange={(e) => {
                const next = e.target.value as BotEmailPreset;
                setPreset(next);
                setImapHost(MAIL_PRESETS[next].imapHost);
                setSmtpHost(MAIL_PRESETS[next].smtpHost);
              }}
              className="qj-conn-input"
            >
              {Object.entries(MAIL_PRESETS).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
            <input type="email" required aria-label="邮箱地址" placeholder="you@qq.com" value={emailAddr} onChange={(e) => setEmailAddr(e.target.value)} className="qj-conn-input" />
            <input type="password" aria-label="邮箱授权码或密码" placeholder={cfgs.email.hasPassword ? "••••••（已加密保存）" : "16 位邮箱授权码"} value={emailPass} onChange={(e) => setEmailPass(e.target.value)} className="qj-conn-input" />
            {preset === "custom" && (
              <div className="qj-conn-grid-2">
                <input type="text" required placeholder="imap.company.com" value={imapHost} onChange={(e) => setImapHost(e.target.value)} className="qj-conn-input mono" />
                <input type="text" required placeholder="smtp.company.com" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} className="qj-conn-input mono" />
              </div>
            )}
            <div className="qj-muse-modal-foot">
              <button type="button" className="qj-soft-btn qj-conn-pill-btn" onClick={onClose}>取消</button>
              <button type="submit" disabled={ui.serverBusy} className="qj-primary-pill-btn qj-conn-pill-btn">保存并连接</button>
            </div>
          </form>
        )}

        {kind === "webhook" && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await ctrl.configureBot({
                customWebhook: { enabled: true, label: whLabel.trim() || "Webhook", endpointUrl: whUrl.trim(), ...(whSecret !== "" ? { bearerToken: whSecret } : {}) },
                appPolicies: { custom_webhook: { connected: true, authKind: "api", accountLabel: whUrl.trim(), connectedAt: Date.now(), policy: "low-risk-auto" } },
              });
              await ctrl.testConnector("custom_webhook");
              onClose();
            }}
            style={{ display: "flex", flexDirection: "column", gap: 10 }}
          >
            <input type="text" required aria-label="Webhook 名称" placeholder="连接名称" value={whLabel} onChange={(e) => setWhLabel(e.target.value)} className="qj-conn-input" />
            <input type="url" required aria-label="Webhook URL" placeholder="https://hooks.zapier.com/..." value={whUrl} onChange={(e) => setWhUrl(e.target.value)} className="qj-conn-input mono" />
            <input type="password" aria-label="Bearer Token" placeholder="Bearer Token（可选）" value={whSecret} onChange={(e) => setWhSecret(e.target.value)} className="qj-conn-input" />
            <div className="qj-muse-modal-foot">
              <button type="button" className="qj-soft-btn qj-conn-pill-btn" onClick={onClose}>取消</button>
              <button type="submit" disabled={ui.serverBusy} className="qj-primary-pill-btn qj-conn-pill-btn">保存并校验</button>
            </div>
          </form>
        )}

        {kind === "github-sync" && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await ctrl.configureBot({
                github: { enabled: true, ...(ghToken !== "" ? { token: ghToken } : {}) },
                appPolicies: { github: { connected: true, authKind: "api", connectedAt: Date.now(), policy: "low-risk-auto", backgroundSync: true } },
              });
              await ctrl.testConnector("github");
              onClose();
            }}
            style={{ display: "flex", flexDirection: "column", gap: 10 }}
          >
            <p className="qj-conn-hint">填入 GitHub Personal Access Token，系统将自动读取并同步你最近活跃的仓库、Issue 与 PR，无需手动逐个填写仓库名。</p>
            <input type="password" aria-label="GitHub PAT" placeholder={cfgs.github?.hasToken ? "••••••（Token 已加密保存）" : "github_pat_... 或 ghp_..."} value={ghToken} onChange={(e) => setGhToken(e.target.value)} className="qj-conn-input mono" />
            <div className="qj-muse-modal-foot">
              <button type="button" className="qj-soft-btn qj-conn-pill-btn" onClick={onClose}>取消</button>
              <button type="submit" disabled={ui.serverBusy} className="qj-primary-pill-btn qj-conn-pill-btn">自动发现并同步</button>
            </div>
          </form>
        )}

        {kind === "calendar-sync" && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await ctrl.configureBot({
                calendar: { enabled: true, icsUrl: icsUrl.trim() },
                appPolicies: { calendar: { connected: true, authKind: "api", accountLabel: "ICS 日历订阅", connectedAt: Date.now(), policy: "read-only-auto", backgroundSync: true } },
              });
              await ctrl.testConnector("calendar");
              onClose();
            }}
            style={{ display: "flex", flexDirection: "column", gap: 10 }}
          >
            <p className="qj-conn-hint">粘贴你的 Google / Apple / Feishu 私有 `.ics` 订阅地址，开启后台自动冲突检测与会前提醒。</p>
            <input type="url" required aria-label="ICS 订阅地址" placeholder="https://calendar.google.com/calendar/ical/..." value={icsUrl} onChange={(e) => setIcsUrl(e.target.value)} className="qj-conn-input mono" />
            <div className="qj-muse-modal-foot">
              <button type="button" className="qj-soft-btn qj-conn-pill-btn" onClick={onClose}>取消</button>
              <button type="submit" disabled={ui.serverBusy} className="qj-primary-pill-btn qj-conn-pill-btn">保存并同步</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
