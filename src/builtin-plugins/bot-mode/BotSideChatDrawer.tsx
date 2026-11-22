import type { ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { Trash2 } from "lucide-react";
import { BotIcon } from "./BotAvatarArt";
import { patchBotUi, useBotController, useBotSnapshot, useBotUiState } from "./botStore";

export function BotSideChatDrawer({ ctx }: { readonly ctx?: Context }): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const isMain = ui.activeSessionId === null || ui.activeSessionId === snapshot.mainSessionId;

  return (
    <aside id="bot-drawer-inner" className="qj-bot-drawer-inner" aria-label="主聊天与旁聊列表">
      <div
        style={{
          height: 36,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 8px",
          marginBottom: 8,
          flexShrink: 0,
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 14.5 }}>聊天</span>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button
            type="button"
            title="新建旁聊"
            aria-label="新建旁聊"
            className="qj-msg-action-btn"
            style={{ fontSize: 17, color: "var(--qj-text-primary)" }}
            onClick={() => void ctrl.createSideChat()}
          >
            ＋
          </button>
          <button
            type="button"
            title="收起"
            aria-label="收起抽屉"
            className="qj-msg-action-btn"
            onClick={() => patchBotUi({ chatDrawerOpen: false })}
          >
            <BotIcon name="closeX" />
          </button>
        </div>
      </div>

      <div style={{ flex: "1 1 auto", overflowY: "auto", display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ padding: "0 10px", fontSize: 12, fontWeight: 500, color: "var(--qj-text-muted)" }}>
            主要聊天
          </div>
          <button
            type="button"
            onClick={() => patchBotUi({ activeSessionId: null, activeView: "chat" })}
            style={{
              width: "100%",
              textAlign: "left",
              padding: "8px 12px",
              border: 0,
              borderRadius: 12,
              cursor: "pointer",
              background: isMain ? "var(--muse-soft-fill)" : "transparent",
              fontWeight: isMain ? 550 : 400,
              color: "var(--qj-text-primary)",
              fontSize: 13.5,
            }}
          >
            主聊天
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ padding: "0 10px", fontSize: 12, fontWeight: 500, color: "var(--qj-text-muted)" }}>
            旁聊
          </div>
          {snapshot.sideThreads.length === 0 ? (
            <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--qj-text-muted)", lineHeight: 1.5 }}>
              暂无旁聊 · 点击右上 ＋ 开启独立分支对话，不混入主聊天时间线
            </div>
          ) : (
            snapshot.sideThreads.map((th) => {
              const active = ui.activeSessionId === th.sessionId;
              return (
                <div
                  key={th.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    borderRadius: 12,
                    background: active ? "var(--muse-soft-fill)" : "transparent",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => patchBotUi({ activeSessionId: th.sessionId, activeView: "chat" })}
                    style={{
                      flex: "1 1 auto",
                      minWidth: 0,
                      textAlign: "left",
                      padding: "8px 10px 8px 12px",
                      border: 0,
                      background: "transparent",
                      color: "var(--qj-text-primary)",
                      fontWeight: active ? 550 : 400,
                      fontSize: 13.5,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      cursor: "pointer",
                    }}
                  >
                    {th.title}
                  </button>
                  <button
                    type="button"
                    className="qj-msg-action-btn"
                    title="删除旁聊"
                    aria-label="删除旁聊"
                    onClick={() => void ctrl.deleteSideChat(th.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </aside>
  );
}
