/**
 * 1:1 Meta Muse Identity (`身份`) & Inbox (`邮箱`) companion panel tabs.
 */
import { useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { Heart, Mail, Pencil } from "lucide-react";
import { openBotModal, useBotController, useBotSnapshot } from "./botStore";

export function BotCompanionIdentityTab({ ctx }: { readonly ctx?: Context }): ReactElement {
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  return (
    <div className="qj-animate-page-in qj-sheet-pane">
      <div className="qj-muse-identity-card">
        {editingName ? (
          <div className="qj-sheet-name-edit">
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
              className="qj-sheet-inline-input"
            />
            <button
              type="button"
              className="qj-primary-pill-btn qj-sheet-pill-sm"
              onClick={() => {
                void ctrl.updateProfile({ displayName: nameDraft.trim() || "千机" });
                setEditingName(false);
              }}
            >
              保存
            </button>
          </div>
        ) : (
          <>
            <div className="qj-muse-identity-name">{snapshot.profile.displayName}</div>
            <button
              type="button"
              className="qj-muse-identity-edit-btn"
              onClick={() => {
                setNameDraft(snapshot.profile.displayName);
                setEditingName(true);
              }}
            >
              <Pencil size={13.5} strokeWidth={1.85} />
              <span>编辑</span>
            </button>
          </>
        )}
      </div>

      <div className="qj-sheet-contract-grid">
        <button
          type="button"
          className="qj-muse-contract-card soul"
          onClick={() => openBotModal("soul")}
        >
          <div>
            <div className="qj-muse-contract-title">SOUL</div>
            <div className="qj-muse-contract-sub">请谨慎访问</div>
          </div>
          <div className="qj-muse-contract-foot">
            <span>{snapshot.soulUpdatedAt}</span>
            <Heart size={14} strokeWidth={1.8} />
          </div>
        </button>

        <button
          type="button"
          className="qj-muse-contract-card memory"
          onClick={() => openBotModal("memory")}
        >
          <div>
            <div className="qj-muse-contract-title">记忆</div>
            <div className="qj-muse-contract-sub">请谨慎访问</div>
          </div>
          <div className="qj-muse-contract-foot">
            <span>{snapshot.memoryUpdatedAt}</span>
            <Heart size={14} strokeWidth={1.8} />
          </div>
        </button>
      </div>

      {snapshot.learnedPreferences.length > 0 && (
        <div className="qj-sheet-recent-block">
          <div className="qj-sheet-day-title">最近习得的偏好</div>
          <div className="qj-soft-card qj-sheet-pref-card">
            {snapshot.learnedPreferences.map((pref, i) => (
              <div key={i}>• {pref}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function BotCompanionInboxTab({ ctx }: { readonly ctx?: Context }): ReactElement {
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const hasRealMail = snapshot.connectorConfigs.email.enabled;

  return (
    <div className="qj-animate-page-in qj-sheet-pane qj-sheet-pane-fill">
      <div className="qj-sheet-pane-head">
        <span className="qj-sheet-pane-title">收件箱</span>
        {(snapshot.inboxEnabled || hasRealMail || snapshot.inboxItems.length > 0) && (
          <div className="qj-sheet-inline-actions">
            {hasRealMail && (
              <button
                type="button"
                className="qj-soft-btn qj-sheet-pill-xs"
                onClick={() => void ctrl.testConnector("email")}
              >
                刷新收信
              </button>
            )}
            <button
              type="button"
              className="qj-soft-btn qj-sheet-pill-xs"
              onClick={() => openBotModal("settings", "channels")}
            >
              通道与邮箱配置
            </button>
          </div>
        )}
      </div>

      {!snapshot.inboxEnabled && !hasRealMail && snapshot.inboxItems.length === 0 ? (
        <div className="qj-muse-panel-center-empty">
          <div className="qj-muse-inbox-icon">
            <Mail size={20} strokeWidth={1.8} />
          </div>
          <div className="qj-soft-empty-title">为{snapshot.profile.displayName}提供邮箱</div>
          <div className="qj-soft-empty-desc">{snapshot.profile.displayName}还没有邮箱</div>
          <button
            type="button"
            className="qj-muse-blue-pill-btn"
            onClick={() => openBotModal("settings", "channels")}
          >
            创建邮箱
          </button>
        </div>
      ) : (
        <div className="qj-sheet-pane">
          {snapshot.connectorConfigs.email.emailAddress && (
            <div className="qj-soft-card qj-sheet-mail-account">
              <span className="qj-sheet-mono">{snapshot.connectorConfigs.email.emailAddress}</span>
              <span className="qj-sheet-status-ok">
                {hasRealMail ? "IMAP 已接入" : "未开启自动拉取"}
              </span>
            </div>
          )}
          {snapshot.inboxItems.length === 0 ? (
            <div className="qj-soft-empty">收件箱暂无新消息</div>
          ) : (
            snapshot.inboxItems.map((mail) => (
              <div
                key={mail.id}
                onClick={() =>
                  ctrl.jumpToChatWithPrompt(
                    `帮我梳理来自「${mail.sender}」的${mail.source === "telegram" ? "消息" : "邮件"}《${mail.subject}》，给出重点与回复建议：\n${mail.fullBody ?? mail.preview}`,
                  )
                }
                className="qj-soft-card qj-sheet-mail-row"
              >
                <div className="qj-sheet-mail-meta">
                  <span>
                    {mail.source === "telegram"
                      ? "Telegram"
                      : mail.source === "github"
                        ? "GitHub"
                        : mail.source === "notion"
                          ? "Notion"
                          : mail.source === "meeting"
                            ? "会议"
                            : "邮件"}{" "}
                    · {mail.sender}
                  </span>
                  <span>{mail.timeLabel}</span>
                </div>
                <div className="qj-sheet-card-title">{mail.subject}</div>
                <div className="qj-sheet-card-sub">{mail.preview}</div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
