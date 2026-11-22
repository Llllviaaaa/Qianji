import { useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { BotIcon } from "./BotAvatarArt";
import { openBotModal, useBotController, useBotSnapshot } from "./botStore";

export function BotCompanionIdentityTab({ ctx }: { readonly ctx?: Context }): ReactElement {
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  return (
    <div className="qj-animate-page-in" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ padding: 16, borderRadius: 20, background: "var(--muse-soft-fill)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        {editingName ? (
          <>
            <input
              autoFocus
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void ctrl.updateProfile({ displayName: nameDraft.trim() || "千机" });
                  setEditingName(false);
                }
              }}
              style={{
                flex: 1,
                background: "transparent",
                border: 0,
                borderBottom: "1px solid var(--qj-text-primary)",
                outline: "none",
                fontSize: 15.5,
                fontWeight: 500,
                color: "var(--qj-text-primary)",
              }}
            />
            <button
              type="button"
              className="qj-primary-pill-btn"
              style={{ height: 32, padding: "0 14px", fontSize: 12, fontWeight: 500 }}
              onClick={() => {
                void ctrl.updateProfile({ displayName: nameDraft.trim() || "千机" });
                setEditingName(false);
              }}
            >
              保存
            </button>
          </>
        ) : (
          <>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15.5, fontWeight: 500 }}>{snapshot.profile.displayName}</div>
              <div style={{ fontSize: 12, color: "var(--qj-text-secondary)", marginTop: 2 }}>个人专属常驻数字分身</div>
            </div>
            <button
              type="button"
              className="qj-soft-btn"
              style={{ height: 32, padding: "0 14px", fontSize: 13, fontWeight: 500, background: "var(--qj-bg-surface)" }}
              onClick={() => {
                setNameDraft(snapshot.profile.displayName);
                setEditingName(true);
              }}
            >
              编辑
            </button>
          </>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <button
          type="button"
          onClick={() => openBotModal("soul")}
          style={{
            padding: 16,
            borderRadius: 20,
            height: 138,
            border: 0,
            background: "var(--muse-soft-fill)",
            color: "var(--qj-text-primary)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            textAlign: "left",
            cursor: "pointer",
          }}
        >
          <div>
            <div style={{ fontSize: 15.5, fontWeight: 600 }}>SOUL</div>
            <div style={{ fontSize: 12, color: "var(--qj-text-secondary)", marginTop: 4 }}>请谨慎访问</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
            <span style={{ fontSize: 13, color: "var(--qj-text-secondary)" }}>{snapshot.soulUpdatedAt}</span>
            <span style={{ fontSize: 12, color: "var(--qj-text-muted)" }}>↗</span>
          </div>
        </button>

        <button
          type="button"
          onClick={() => openBotModal("memory")}
          style={{
            padding: 16,
            borderRadius: 20,
            height: 138,
            border: 0,
            background: "var(--muse-soft-fill)",
            color: "var(--qj-text-primary)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            textAlign: "left",
            cursor: "pointer",
          }}
        >
          <div>
            <div style={{ fontSize: 15.5, fontWeight: 600 }}>记忆</div>
            <div style={{ fontSize: 12, color: "var(--qj-text-secondary)", marginTop: 4 }}>请谨慎访问</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
            <span style={{ fontSize: 13, color: "var(--qj-text-secondary)" }}>{snapshot.memoryUpdatedAt}</span>
            <span style={{ fontSize: 12, color: "var(--qj-text-muted)" }}>↗</span>
          </div>
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: "var(--qj-text-muted)" }}>最近习得的偏好</div>
        <div style={{ padding: 14, borderRadius: 16, background: "var(--muse-soft-fill)", color: "var(--qj-text-secondary)", fontSize: 12.5, lineHeight: 1.65 }}>
          {snapshot.learnedPreferences.length === 0 ? (
            <span>暂未记录偏好 · 在「记忆」中写入 `- ` 列表或在对话中告诉{snapshot.profile.displayName}你的习惯即可自动呈现。</span>
          ) : (
            snapshot.learnedPreferences.map((pref, i) => <div key={i}>• {pref}</div>)
          )}
        </div>
      </div>
    </div>
  );
}

export function BotCompanionInboxTab({ ctx }: { readonly ctx?: Context }): ReactElement {
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const hasRealMail = snapshot.connectorConfigs.email.enabled;

  return (
    <div className="qj-animate-page-in" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 15.5, fontWeight: 600 }}>收件箱</span>
        <div style={{ display: "flex", gap: 6 }}>
          {hasRealMail && (
            <button
              type="button"
              className="qj-soft-btn"
              style={{ height: 26, padding: "0 10px", fontSize: 11.5 }}
              onClick={() => void ctrl.testConnector("email")}
            >
              刷新收信
            </button>
          )}
          <button
            type="button"
            className="qj-soft-btn"
            style={{ height: 26, padding: "0 10px", fontSize: 11.5 }}
            onClick={() => openBotModal("settings", "connectors")}
          >
            连接配置
          </button>
        </div>
      </div>

      {!snapshot.inboxEnabled && !hasRealMail && snapshot.inboxItems.length === 0 ? (
        <div style={{ padding: "36px 16px", borderRadius: 22, background: "var(--muse-soft-fill)", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 12 }}>
          <div style={{ width: 44, height: 44, borderRadius: "9999px", background: "var(--qj-bg-surface)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <BotIcon name="tabMail" />
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 500 }}>接入你的常用邮箱与消息</div>
            <div style={{ fontSize: 13, color: "var(--qj-text-secondary)", marginTop: 4 }}>
              连接后，{snapshot.profile.displayName}会定时帮你查看新邮件、提炼重点并提前拟好回信草稿
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="qj-primary-pill-btn"
              style={{ height: 34, padding: "0 16px", fontSize: 13, fontWeight: 500 }}
              onClick={() => openBotModal("settings", "connectors")}
            >
              配置真实邮箱 / IM
            </button>
            <button
              type="button"
              className="qj-soft-btn"
              style={{ height: 34, padding: "0 14px", fontSize: 13, background: "var(--qj-bg-surface)" }}
              onClick={() => void ctrl.enableInbox()}
            >
              启用本地信箱
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {snapshot.connectorConfigs.email.emailAddress && (
            <div style={{ padding: 10, borderRadius: 14, background: "var(--muse-soft-fill)", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12 }}>
              <span style={{ fontFamily: "var(--qj-font-mono)", fontWeight: 500 }}>{snapshot.connectorConfigs.email.emailAddress}</span>
              <span style={{ color: "var(--qj-status-success)" }}>{hasRealMail ? "IMAP 已接入" : "未开启自动拉取"}</span>
            </div>
          )}
          {snapshot.inboxItems.length === 0 ? (
            <div style={{ padding: "28px 12px", textAlign: "center", color: "var(--qj-text-secondary)", fontSize: 13 }}>
              收件箱已就绪 · 暂无新消息（可点右上「刷新收信」）
            </div>
          ) : (
            snapshot.inboxItems.map((mail) => (
              <div
                key={mail.id}
                onClick={() =>
                  ctrl.jumpToChatWithPrompt(
                    `帮我梳理来自「${mail.sender}」的${mail.source === "telegram" ? "消息" : "邮件"}《${mail.subject}》，给出重点与回复建议：\n${mail.fullBody ?? mail.preview}`,
                  )
                }
                style={{ padding: 13, borderRadius: 16, background: "var(--muse-soft-fill)", cursor: "pointer", display: "flex", flexDirection: "column", gap: 4 }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: "var(--qj-text-muted)" }}>
                  <span>{mail.source === "telegram" ? "Telegram" : "邮件"} · {mail.sender}</span>
                  <span>{mail.timeLabel}</span>
                </div>
                <div style={{ fontSize: 13.5, fontWeight: 550 }}>{mail.subject}</div>
                <div style={{ fontSize: 12, color: "var(--qj-text-secondary)", lineHeight: 1.45 }}>{mail.preview}</div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
