import { useRef, useState, type ChangeEvent, type FormEvent, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { ArrowUp, Paperclip, Square, X } from "lucide-react";
import { useFrontendService, useSessionHandle, useSessionState, type AttachmentPayload } from "@qianji/client";
import { Markdown } from "@qianji/client-primitives";
import { BotCompanionAvatar, BotIcon, CalendarTaskTileIcon } from "./BotAvatarArt";
import { BotSideChatDrawer } from "./BotSideChatDrawer";
import { patchBotUi, useBotController, useBotSnapshot, useBotUiState } from "./botStore";
export { BotSideChatDrawer };

export function BotChatColumn(props: { readonly ctx?: Context; readonly cwd: string; readonly isSplitSpace: boolean }): ReactElement {
  const { ctx, cwd, isSplitSpace } = props;
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const sessionSnap = useSessionState(ctx);
  const navigationService = useFrontendService("navigationService", ctx);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [attachments, setAttachments] = useState<AttachmentPayload[]>([]);
  const [reactedIds, setReactedIds] = useState<Readonly<Record<string, boolean>>>({});
  const [moreMsgId, setMoreMsgId] = useState<string | null>(null);

  const targetSessionId = ui.activeSessionId ?? snapshot.mainSessionId;
  const targetSessionFile =
    targetSessionId !== ""
      ? targetSessionId.startsWith("harness:")
        ? targetSessionId
        : `harness:${targetSessionId}`
      : null;
  const effectiveCwd = snapshot.botCwd || cwd;
  const canAttach = targetSessionFile !== null && effectiveCwd !== "";

  const retained = useSessionHandle(
    canAttach ? targetSessionFile : null,
    canAttach
      ? {
          isolated: false,
          autoStart: true,
          cwd: effectiveCwd,
          permissionMode: "full-access",
          agentMode: "agent",
          ...(sessionSnap?.model ? { model: sessionSnap.model } : {}),
        }
      : undefined,
    ctx,
  );

  const messages = retained.snapshot?.messages ?? [];
  const isStreaming = retained.snapshot?.isStreaming === true;
  const runtimeError = retained.snapshot?.error ?? null;
  const isMain = ui.activeSessionId === null || ui.activeSessionId === snapshot.mainSessionId;
  const activeSide = snapshot.sideThreads.find((t) => t.sessionId === targetSessionId);
  const topTitle = isMain ? "聊天" : (activeSide?.title ?? "旁聊");

  const handleFilesSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    const loaded: AttachmentPayload[] = [];
    for (const file of Array.from(files)) {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] ?? 0);
      const isImg = file.type.startsWith("image/");
      loaded.push({
        path: file.name,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        kind: isImg ? "image" : "text",
        ...(isImg ? { data: btoa(binary) } : { text: await file.text().catch(() => "") }),
      });
    }
    setAttachments((prev) => [...prev, ...loaded]);
    event.target.value = "";
  };

  const handleSubmit = async (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = ui.composerDraft.trim();
    if (trimmed === "" && attachments.length === 0) return;

    if (isSplitSpace && trimmed !== "") {
      patchBotUi({ composerDraft: "" });
      await ctrl.createSpace(trimmed);
      if (retained.handle !== null) {
        void retained.handle.sendMessage(trimmed, attachments).catch(() => false);
      }
      setAttachments([]);
      return;
    }

    const fullText = ui.quotedText ? `> ${ui.quotedText}\n\n${trimmed}` : trimmed;
    const queued = attachments;
    patchBotUi({ composerDraft: "", quotedText: null });
    setAttachments([]);

    if (retained.handle === null) {
      navigationService?.showToast("正在连接后台会话服务，请稍候重试", "warning");
      return;
    }
    await retained.handle.sendMessage(fullText, queued);
  };

  const hasDraft = ui.composerDraft.trim() !== "" || attachments.length > 0;
  const pillStyle = {
    height: 32,
    padding: "0 14px",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13.5,
    fontWeight: 500,
    cursor: "pointer",
  } as const;

  return (
    <div className={`qj-bot-chat-col${isSplitSpace ? " split-left" : ""}`}>
      <header className="qj-bot-topbar" data-tauri-drag-region="">
        <div className="qj-bot-topbar-left">
          <button
            id="btn-toggle-chat-drawer"
            type="button"
            onClick={() => patchBotUi({ chatDrawerOpen: !ui.chatDrawerOpen })}
            className="qj-muse-glass-pill"
            style={pillStyle}
          >
            <BotIcon name="menu" />
            <span>{topTitle}</span>
          </button>
        </div>

        <div className={!isSplitSpace ? "qj-bot-topbar-right" : "qj-bot-topbar-left"}>
          <button
            type="button"
            onClick={() => {
              const next = !ui.voiceCallActive;
              patchBotUi({ voiceCallActive: next });
              navigationService?.showToast(next ? "实时语音模式已开启" : "已结束语音模式", "info");
            }}
            className="qj-muse-glass-pill"
            style={{ ...pillStyle, gap: 6, fontSize: 13 }}
          >
            <BotIcon name="phone" />
            <span>{ui.voiceCallActive ? "通话中" : "通话"}</span>
          </button>

          {!isSplitSpace && (
            <button
              id="btn-toggle-right-panel"
              type="button"
              title={ui.rightPanelOpen ? "收起陪伴面板" : "展开陪伴面板"}
              aria-label="切换右侧陪伴面板"
              onClick={() => patchBotUi({ rightPanelOpen: !ui.rightPanelOpen })}
              className="qj-muse-glass-pill"
              style={{
                width: 32,
                height: 32,
                padding: 0,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                color: ui.rightPanelOpen ? "var(--qj-text-primary)" : "var(--qj-text-secondary)",
                cursor: "pointer",
              }}
            >
              <BotIcon name="panelRight" />
            </button>
          )}
        </div>
      </header>

      <div id="muse-chat-scroll" className="qj-bot-chat-scroll">
        <div className="qj-bot-chat-stream">
          {messages.length === 0 && (
            <div
              style={{
                paddingTop: isSplitSpace ? 48 : 88,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                textAlign: "center",
                gap: 14,
              }}
            >
              <BotCompanionAvatar
                preset={snapshot.profile.avatarPreset}
                customDataUrl={snapshot.profile.customAvatarDataUrl}
                size={76}
              />
              <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.015em" }}>
                {isMain ? `你好，我是${snapshot.profile.displayName}` : topTitle}
              </div>
              <div style={{ fontSize: 14, color: "var(--qj-text-secondary)", maxWidth: 420, lineHeight: 1.6 }}>
                {isSplitSpace
                  ? "在下方输入框描述你想追踪的主题，我会为你创建常驻空间看板。"
                  : isMain
                    ? "随时直接发消息交流，或安排后台巡检、资料整理与工作台协同任务。"
                    : "这是一个独立旁聊分支，适合临时实验或独立提问，不会混入主聊天时间线。"}
              </div>
            </div>
          )}

          {messages.map((msg) => {
            if (msg.role === "user") {
              return (
                <div key={msg.id} style={{ display: "flex", justifyContent: "flex-end" }}>
                  <div className="qj-muse-bubble-user">{msg.content}</div>
                </div>
              );
            }
            const reacted = reactedIds[msg.id] === true;
            return (
              <div key={msg.id} className="qj-msg-row">
                <div className="qj-muse-bubble-bot">
                  {msg.content ? (
                    <Markdown content={msg.content} isStreaming={isStreaming} />
                  ) : (
                    <span style={{ color: "var(--qj-text-muted)", fontSize: 13.5 }}>正在思考…</span>
                  )}
                </div>

                <div className="qj-msg-actions" style={{ position: "relative" }}>
                  <button
                    type="button"
                    className="qj-msg-action-btn"
                    title="留下心情"
                    style={{ color: reacted ? "var(--qj-brand-primary)" : undefined }}
                    onClick={() => setReactedIds((prev) => ({ ...prev, [msg.id]: !reacted }))}
                  >
                    <BotIcon name="smile" />
                  </button>
                  <button
                    type="button"
                    className="qj-msg-action-btn"
                    title="引用回复"
                    onClick={() => patchBotUi({ quotedText: msg.content.slice(0, 100) })}
                  >
                    <BotIcon name="reply" />
                  </button>
                  <button
                    type="button"
                    className="qj-msg-action-btn"
                    title="更多操作"
                    onClick={() => setMoreMsgId((cur) => (cur === msg.id ? null : msg.id))}
                  >
                    <BotIcon name="dots" />
                  </button>

                  {moreMsgId === msg.id && (
                    <div
                      className="qj-bot-more-popover"
                      style={{ bottom: 34, left: 0, width: 176 }}
                      onMouseLeave={() => setMoreMsgId(null)}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setMoreMsgId(null);
                          void navigator.clipboard?.writeText(msg.content);
                          navigationService?.showToast("已复制消息", "info");
                        }}
                      >
                        <span>复制文本</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setMoreMsgId(null);
                          ctrl.triggerHandoff({
                            id: `msg-${msg.id}`,
                            title: msg.content.slice(0, 32) || "对话任务接力",
                            kindLabel: "对话上下文接力",
                            summary: msg.content.slice(0, 180),
                            targetCwd: cwd || effectiveCwd,
                          });
                        }}
                      >
                        <span>在工作台中打开</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {isMain &&
            snapshot.embeddedTasks.map((task) => (
              <div key={task.id} className="qj-msg-row" data-testid="bot-handoff-card">
                <div className="qj-muse-bubble-bot" style={{ width: 348 }}>
                  <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <CalendarTaskTileIcon />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {task.title}
                        </div>
                        <div style={{ fontSize: 12, color: "var(--qj-text-secondary)" }}>{task.kindLabel}</div>
                      </div>
                    </div>
                    <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.45 }}>{task.summary}</p>
                    <button
                      type="button"
                      onClick={() => ctrl.triggerHandoff(task)}
                      style={{
                        width: "100%",
                        height: 36,
                        border: 0,
                        borderRadius: 9999,
                        background: "var(--qj-bg-surface)",
                        color: "var(--qj-text-primary)",
                        fontSize: 13.5,
                        fontWeight: 500,
                        cursor: "pointer",
                        boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
                      }}
                    >
                      在 Agent 工作台中打开
                    </button>
                  </section>
                </div>
              </div>
            ))}

          {runtimeError && (
            <div
              style={{
                padding: "12px 16px",
                borderRadius: 16,
                background: "var(--muse-soft-fill)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                fontSize: 13,
              }}
            >
              <span style={{ color: "var(--qj-text-secondary)" }}>{runtimeError}</span>
              <button
                type="button"
                className="qj-primary-pill-btn"
                style={{ height: 30, padding: "0 14px", fontSize: 12, flexShrink: 0 }}
                onClick={() => navigationService?.openSettings("providers")}
              >
                配置模型服务
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="qj-bot-composer-wrap">
        <form className="qj-muse-glass-pill qj-bot-composer-pill" onSubmit={(e) => void handleSubmit(e)}>
          {ui.quotedText !== null && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "4px 10px",
                borderRadius: 10,
                background: "var(--muse-soft-fill)",
                fontSize: 12,
                color: "var(--qj-text-secondary)",
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                回复：{ui.quotedText}
              </span>
              <button
                type="button"
                className="qj-msg-action-btn"
                style={{ width: 20, height: 20 }}
                onClick={() => patchBotUi({ quotedText: null })}
              >
                <X size={12} />
              </button>
            </div>
          )}

          {attachments.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "2px 4px" }}>
              {attachments.map((att, idx) => (
                <span
                  key={`${att.fileName}-${idx}`}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "2px 8px",
                    borderRadius: 9999,
                    background: "var(--muse-soft-fill)",
                    fontSize: 12,
                  }}
                >
                  <Paperclip size={11} />
                  <span>{att.fileName}</span>
                  <button
                    type="button"
                    style={{ border: 0, background: "transparent", cursor: "pointer", padding: 0, color: "inherit" }}
                    onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== idx))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <input ref={fileInputRef} type="file" multiple hidden onChange={(e) => void handleFilesSelected(e)} />
            <button
              type="button"
              title="添加文件或图片附件"
              aria-label="添加附件"
              className="qj-msg-action-btn"
              style={{ width: 32, height: 32, color: "var(--qj-text-secondary)" }}
              onClick={() => fileInputRef.current?.click()}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>

            <input
              id="muse-msg-input"
              type="text"
              aria-label="消息输入框"
              placeholder="消息"
              value={ui.composerDraft}
              onChange={(e) => patchBotUi({ composerDraft: e.target.value })}
              style={{
                flex: "1 1 auto",
                minWidth: 0,
                border: 0,
                outline: "none",
                background: "transparent",
                color: "var(--qj-text-primary)",
                fontSize: 15,
              }}
            />

            {isStreaming ? (
              <button
                type="button"
                title="停止生成"
                aria-label="停止生成"
                className="qj-primary-pill-btn"
                style={{ width: 32, height: 32, display: "grid", placeItems: "center", flexShrink: 0 }}
                onClick={() => void retained.handle?.abort()}
              >
                <Square size={12} />
              </button>
            ) : hasDraft ? (
              <button
                type="submit"
                title="发送"
                aria-label="发送消息"
                className="qj-primary-pill-btn"
                style={{ width: 32, height: 32, display: "grid", placeItems: "center", flexShrink: 0 }}
              >
                <ArrowUp size={16} />
              </button>
            ) : (
              <button
                type="button"
                title="语音输入"
                aria-label="语音输入"
                className="qj-msg-action-btn"
                style={{ width: 32, height: 32, color: "var(--qj-text-secondary)" }}
                onClick={() => navigationService?.showToast("请开始说话，或直接输入文字消息", "info")}
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="2" width="6" height="12" rx="3" />
                  <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" />
                </svg>
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
