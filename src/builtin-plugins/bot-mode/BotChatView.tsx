/**
 * Evergreen Main Chat + Side-Chat Drawer + Embedded Task Handoff Cards +
 * Floating Capsule Composer for Qianji Bot Mode.
 */
import { useState, type FormEvent, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  ArrowUp,
  ArrowUpRight,
  Mic,
  PanelLeft,
  PanelRight,
  Phone,
  Plus,
  Square,
  X,
} from "lucide-react";
import { useFrontendService, useSessionHandle } from "@qianji/client";
import { Markdown } from "@qianji/client-primitives";
import {
  patchBotUi,
  useBotController,
  useBotSnapshot,
  useBotUiState,
} from "./botStore";

interface LocalFallbackMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
}

const WELCOME_MESSAGES: readonly LocalFallbackMessage[] = [
  {
    id: "welcome-bot-1",
    role: "assistant",
    content:
      "早安，我一直在后台待命。今天我已经为你整理好 `develop` 分支进展与双形态体验走查要点；你可以随时在这里自然聊想法，或者点击下方协同卡片切入 **Agent 工作台**逐行审阅。",
  },
];

export function BotChatView({
  ctx,
  cwd,
}: {
  readonly ctx?: Context;
  readonly cwd: string;
}): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const navigationService = useFrontendService("navigationService", ctx);

  const effectiveSessionId = ui.activeSessionId ?? snapshot.mainSessionId;
  const isMainThread = effectiveSessionId === snapshot.mainSessionId;
  const effectiveCwd = snapshot.botCwd || cwd;

  const retained = useSessionHandle(
    effectiveSessionId,
    { isolated: true, cwd: effectiveCwd },
    ctx,
  );

  const [localRepliesBySession, setLocalRepliesBySession] = useState<
    Readonly<Record<string, readonly LocalFallbackMessage[]>>
  >({});
  const [likedIds, setLikedIds] = useState<Readonly<Record<string, boolean>>>({});

  const liveMessages = retained.snapshot?.messages ?? [];
  const localMessages = localRepliesBySession[effectiveSessionId] ?? [];
  const mergedMessages: ReadonlyArray<{ id: string; role: string; content: string }> =
    liveMessages.length > 0
      ? liveMessages
      : isMainThread
        ? [...WELCOME_MESSAGES, ...localMessages]
        : localMessages;

  const isStreaming = retained.snapshot?.isStreaming === true;
  const activeSideThread = snapshot.sideThreads.find((t) => t.sessionId === effectiveSessionId);
  const headerTitle = isMainThread ? "聊天" : (activeSideThread?.title ?? "旁聊");

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const rawDraft = ui.composerDraft.trim();
    if (rawDraft === "") return;

    const fullPrompt = ui.quotedText
      ? `> ${ui.quotedText}\n\n${rawDraft}`
      : rawDraft;

    patchBotUi({ composerDraft: "", quotedText: null });

    if (retained.handle !== null) {
      const sent = await retained.handle.sendMessage(fullPrompt).catch(() => false);
      if (sent) return;
    }

    // Graceful offline conversational response when Host LLM is not yet connected
    const userMsg: LocalFallbackMessage = {
      id: `local-u-${Date.now()}`,
      role: "user",
      content: fullPrompt,
    };
    const botMsg: LocalFallbackMessage = {
      id: `local-a-${Date.now() + 1}`,
      role: "assistant",
      content: `收到，已记录到${isMainThread ? "常青主对话" : `「${headerTitle}」分支`}。需要深入代码或文件级核验时，随时点击顶栏或协同卡片切入 Agent 工作台。`,
    };
    setLocalRepliesBySession((prev) => ({
      ...prev,
      [effectiveSessionId]: [...(prev[effectiveSessionId] ?? []), userMsg, botMsg],
    }));
  };

  return (
    <div className="qj-bot-center">
      {/* 256px Collapsible Side-Chat Drawer */}
      <aside
        id="bot-drawer-wrap"
        className={`qj-bot-drawer${ui.chatDrawerOpen ? " open" : ""}`}
        aria-label="主聊天与旁聊列表"
      >
        <div className="qj-bot-drawer-inner">
          <div>
            <div className="qj-bot-drawer-sec-head">
              <span>主要聊天</span>
            </div>
            <button
              type="button"
              className={`qj-bot-thread-item${isMainThread ? " active" : ""}`}
              onClick={() => patchBotUi({ activeSessionId: null })}
            >
              <span className="qj-bot-thread-title">{snapshot.profile.displayName} · 常青主线</span>
              <span className="qj-bot-thread-sub">贯穿全局记忆与每日主动进展</span>
            </button>
          </div>

          <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto" }}>
            <div className="qj-bot-drawer-sec-head">
              <span>旁聊 (Ctrl+J)</span>
              <button
                type="button"
                className="qj-bot-icon-btn"
                style={{ width: 24, height: 24 }}
                title="新建独立旁聊"
                aria-label="新建旁聊"
                onClick={() => void ctrl.createSideChat()}
              >
                <Plus size={14} />
              </button>
            </div>
            {snapshot.sideThreads.map((thread) => {
              const active = thread.sessionId === effectiveSessionId;
              return (
                <button
                  key={thread.id}
                  type="button"
                  className={`qj-bot-thread-item${active ? " active" : ""}`}
                  onClick={() => patchBotUi({ activeSessionId: thread.sessionId })}
                >
                  <span className="qj-bot-thread-title">{thread.title}</span>
                  <span className="qj-bot-thread-sub">
                    {thread.snippet ?? "独立分支上下文，不污染主聊天"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </aside>

      {/* Main Chat Column */}
      <section className="qj-bot-main" aria-label="Bot 对话舞台">
        <header className="qj-bot-topbar" data-tauri-drag-region="">
          <div className="qj-bot-topbar-left">
            <button
              id="btn-toggle-chat-drawer"
              type="button"
              className={`qj-bot-pill-btn${ui.chatDrawerOpen ? " active" : ""}`}
              onClick={() => patchBotUi({ chatDrawerOpen: !ui.chatDrawerOpen })}
              title="展开或收起旁聊抽屉 (Ctrl+J)"
            >
              <PanelLeft size={15} />
              <span>{headerTitle}</span>
            </button>
          </div>

          <div className="qj-bot-topbar-right">
            <button
              type="button"
              className={`qj-bot-pill-btn${ui.voiceCallActive ? " active" : ""}`}
              onClick={() => {
                const next = !ui.voiceCallActive;
                patchBotUi({ voiceCallActive: next });
                navigationService?.showToast(
                  next ? "已开启千机实时语音伴聊模式" : "已结束语音通话",
                  "info",
                );
              }}
            >
              <Phone size={14} />
              <span>{ui.voiceCallActive ? "通话中 · 00:18" : "通话"}</span>
            </button>

            <button
              type="button"
              className={`qj-bot-icon-btn${ui.rightPanelOpen ? " active" : ""}`}
              title={ui.rightPanelOpen ? "收起右侧分身面板" : "展开右侧分身面板"}
              aria-label="切换右侧分身面板"
              onClick={() => patchBotUi({ rightPanelOpen: !ui.rightPanelOpen })}
            >
              <PanelRight size={15} />
            </button>
          </div>
        </header>

        <div className="qj-bot-chat-scroll">
          <div className="qj-bot-chat-column">
            {mergedMessages.length === 0 && (
              <div className="qj-bot-soft-card">
                <strong>{headerTitle}</strong>
                <span style={{ color: "var(--qj-text-secondary)", fontSize: 13.5 }}>
                  这是一个独立的旁聊分支，适合临时头脑风暴、敏感议题快问快答，不会干扰主聊天的长期记忆节奏。
                </span>
              </div>
            )}

            {mergedMessages.map((msg) => {
              const isUser = msg.role === "user";
              const liked = likedIds[msg.id] === true;
              return (
                <div key={msg.id} className={`qj-bot-msg-row ${isUser ? "user" : "assistant"}`}>
                  {isUser ? (
                    <div className="qj-bot-bubble-user">{msg.content}</div>
                  ) : (
                    <div className="qj-bot-bubble-bot">
                      <Markdown content={msg.content} />
                    </div>
                  )}

                  <div className="qj-bot-msg-actions">
                    <button
                      type="button"
                      onClick={() => setLikedIds((prev) => ({ ...prev, [msg.id]: !liked }))}
                    >
                      {liked ? "👍 已赞" : "👍"}
                    </button>
                    <button
                      type="button"
                      onClick={() => patchBotUi({ quotedText: msg.content.slice(0, 96) })}
                    >
                      ↩ 引用
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard?.writeText(msg.content);
                        navigationService?.showToast("已复制消息内容", "info");
                      }}
                    >
                      复制
                    </button>
                  </div>
                </div>
              );
            })}

            {/* Embedded Task Handoff Cards in Main Thread */}
            {isMainThread &&
              snapshot.embeddedTasks.map((task) => (
                <div key={task.id} className="qj-bot-task-card" data-testid="bot-handoff-card">
                  <div className="qj-bot-task-card-head">
                    <span className="qj-bot-task-card-title">{task.title}</span>
                    <span className="qj-bot-task-card-meta">
                      <span className="qj-bot-task-diff-add">+148</span>
                      <span className="qj-bot-task-diff-del">−12</span>
                    </span>
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--qj-text-secondary)", lineHeight: 1.5 }}>
                    {task.summary}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ fontSize: 11.5, color: "var(--qj-text-muted)" }}>{task.kindLabel}</span>
                    <button
                      type="button"
                      className="qj-bot-task-handoff-btn"
                      onClick={() => ctrl.triggerHandoff(task)}
                    >
                      <span>在 Agent 工作台中打开</span>
                      <ArrowUpRight size={14} />
                    </button>
                  </div>
                </div>
              ))}
          </div>
        </div>

        {/* Floating Glass Capsule Composer */}
        <div className="qj-bot-composer-dock">
          <form className="qj-bot-composer-capsule" onSubmit={(e) => void handleSubmit(e)}>
            {ui.quotedText !== null && (
              <div className="qj-bot-quote-bar">
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  引用：{ui.quotedText}
                </span>
                <button
                  type="button"
                  className="qj-bot-icon-btn"
                  style={{ width: 20, height: 20 }}
                  aria-label="取消引用"
                  onClick={() => patchBotUi({ quotedText: null })}
                >
                  <X size={12} />
                </button>
              </div>
            )}

            <div className="qj-bot-composer-row">
              <button
                type="button"
                className="qj-bot-icon-btn"
                title="在新建旁聊中提问"
                aria-label="附加或新建旁聊"
                onClick={() => void ctrl.createSideChat()}
              >
                <Plus size={16} />
              </button>

              <input
                type="text"
                className="qj-bot-composer-input"
                aria-label="与千机对话输入框"
                placeholder={`发消息给${snapshot.profile.displayName}…`}
                value={ui.composerDraft}
                onChange={(e) => patchBotUi({ composerDraft: e.target.value })}
              />

              <button
                type="button"
                className="qj-bot-icon-btn"
                title="语音输入"
                aria-label="语音输入"
                onClick={() => navigationService?.showToast("语音听写已就绪", "info")}
              >
                <Mic size={15} />
              </button>

              {isStreaming ? (
                <button
                  type="button"
                  className="qj-bot-send-btn"
                  aria-label="停止回复"
                  onClick={() => void retained.handle?.abort()}
                >
                  <Square size={13} />
                </button>
              ) : (
                <button
                  type="submit"
                  className="qj-bot-send-btn"
                  disabled={ui.composerDraft.trim() === ""}
                  aria-label="发送消息"
                >
                  <ArrowUp size={16} />
                </button>
              )}
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
