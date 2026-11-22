import { useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { useFrontendService } from "@qianji/client";
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
  const navigationService = useFrontendService("navigationService", ctx);

  return (
    <div className="qj-animate-page-in" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ fontSize: 15.5, fontWeight: 600 }}>收件箱</div>
      {!snapshot.inboxEnabled ? (
        <div style={{ padding: "40px 16px", borderRadius: 22, background: "var(--muse-soft-fill)", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 12 }}>
          <div style={{ width: 44, height: 44, borderRadius: "9999px", background: "var(--qj-bg-surface)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <BotIcon name="tabMail" />
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 500 }}>为 {snapshot.profile.displayName} 提供邮箱</div>
            <div style={{ fontSize: 13, color: "var(--qj-text-secondary)", marginTop: 4 }}>
              {snapshot.profile.displayName}还没有专属收件箱
            </div>
          </div>
          <button
            type="button"
            className="qj-primary-pill-btn"
            style={{ height: 36, padding: "0 20px", fontSize: 13.5, fontWeight: 500, marginTop: 4 }}
            onClick={() => void ctrl.enableInbox()}
          >
            创建邮箱
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ padding: 12, borderRadius: 16, background: "var(--muse-soft-fill)", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12 }}>
            <span style={{ fontFamily: "var(--qj-font-mono)", fontWeight: 500 }}>{snapshot.inboxAddress}</span>
            <button
              type="button"
              className="qj-soft-btn"
              style={{ padding: "4px 10px", fontSize: 12, background: "var(--qj-bg-surface)" }}
              onClick={() => {
                void navigator.clipboard?.writeText(snapshot.inboxAddress);
                navigationService?.showToast("已复制邮箱地址", "info");
              }}
            >
              复制
            </button>
          </div>
          {snapshot.inboxItems.length === 0 ? (
            <div style={{ padding: "28px 12px", textAlign: "center", color: "var(--qj-text-secondary)", fontSize: 13 }}>
              收件箱已就绪 · 暂无新邮件
            </div>
          ) : (
            snapshot.inboxItems.map((mail) => (
              <div
                key={mail.id}
                onClick={() => ctrl.jumpToChatWithPrompt(`帮我处理收件箱邮件：${mail.subject}`)}
                style={{ padding: 14, borderRadius: 16, background: "var(--muse-soft-fill)", cursor: "pointer" }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--qj-text-muted)" }}>
                  <span>{mail.sender}</span>
                  <span>{mail.timeLabel}</span>
                </div>
                <div style={{ fontSize: 13.5, fontWeight: 500, marginTop: 4 }}>{mail.subject}</div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
