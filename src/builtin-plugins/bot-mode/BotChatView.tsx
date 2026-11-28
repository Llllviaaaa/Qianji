/**
 * Clean 1:1+ Meta Muse Conversational Canvas (`BotChatColumn`).
 *
 * Pairs the slide-out Side-Chat Drawer (`BotSideChatDrawer`), floating top frosted
 * pills (`≡ 聊天`, character badge, `通话`), avatar-free `22px` bubbles with
 * `[[options: ...]]` quick-choice buttons, and the bottom docked pill composer.
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { ArrowDown, ArrowUpRight } from "lucide-react";
import {
  useAppStore,
  useFrontendService,
  useSessionHandle,
  useSessionState,
  type AttachmentPayload,
} from "@qianji/client";
import { CalendarTaskTileIcon } from "./BotAvatarArt";
import { BotChatHeroStage } from "./BotCharacterStage";
import { BotChatComposer } from "./BotChatComposer";
import { getMergedConnectorCatalog, resolveConnectorState } from "./botConnectorCatalog";
import {
  BotAssistantBubbleRow,
  BotChatFloatingTopbar,
  BotHistoryHydratingState,
  BotLiveThinkingRow,
  filterVisibleBotMessages,
  stripBotThinking,
} from "./BotChatThreadWidgets";
import { encodeBotModelKey } from "./BotModelsSettingsPane";
import { BotSideChatDrawer } from "./BotSideChatDrawer";
import {
  openBotConnector,
  openBotModal,
  patchBotUi,
  useBotController,
  useBotSnapshot,
  useBotUiState,
} from "./botStore";
import {
  formatBotDividerTimestamp,
  resolveEffectiveBotModel,
  resolvePendingAutoSend,
  useBotChatScroll,
} from "./useBotChatScroll";

export { resolvePendingAutoSend };

export function BotChatColumn(props: {
  readonly ctx?: Context;
  readonly cwd: string;
  readonly compactSplit?: boolean;
}): ReactElement {
  const { ctx, cwd, compactSplit = false } = props;
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const sessionSnap = useSessionState(ctx);
  const appSettings = useAppStore((s) => s.settings);
  const navigationService = useFrontendService("navigationService", ctx);

  const [reactedIds, setReactedIds] = useState<Readonly<Record<string, boolean>>>({});
  const [moreMsgId, setMoreMsgId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const availableModels = sessionSnap?.availableModels ?? [];
  const resolvedBotModel = resolveEffectiveBotModel({
    modelConfig: snapshot.modelConfig,
    settingsProvider: appSettings?.provider,
    settingsModel: appSettings?.model,
    sessionModel: sessionSnap?.model ?? null,
    availableModels,
  });
  const defaultFallbackModel = resolveEffectiveBotModel({
    modelConfig: {},
    settingsProvider: appSettings?.provider,
    settingsModel: appSettings?.model,
    sessionModel: sessionSnap?.model ?? null,
    availableModels,
  });
  const desiredProvider = resolvedBotModel.provider;
  const desiredModelId = resolvedBotModel.modelId;

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
          thinkingLevel: "off",
          ...(resolvedBotModel.modelInfo ? { model: resolvedBotModel.modelInfo } : {}),
        }
      : undefined,
    ctx,
  );

  const currentProvider = retained.snapshot?.model?.provider ?? "";
  const currentModelId = retained.snapshot?.model?.id ?? "";
  const currentThinkingLevel = retained.snapshot?.thinkingLevel ?? "medium";
  const handlePhase = retained.snapshot?.phase ?? "idle";

  useEffect(() => {
    if (retained.handle === null || handlePhase !== "ready") return;
    if (currentThinkingLevel !== "off") {
      void retained.handle.setThinkingLevel("off").catch(() => undefined);
    }
    if (desiredProvider === "" || desiredModelId === "") return;
    const needsSync =
      currentModelId === "" ||
      currentProvider !== desiredProvider ||
      currentModelId !== desiredModelId;
    if (needsSync) {
      void retained.handle
        .setModel({
          id: desiredModelId,
          name: resolvedBotModel.label || desiredModelId,
          provider: desiredProvider,
        })
        .catch(() => undefined);
    }
  }, [
    retained.handle,
    handlePhase,
    currentThinkingLevel,
    currentProvider,
    currentModelId,
    desiredProvider,
    desiredModelId,
    resolvedBotModel.label,
  ]);

  const messages = retained.snapshot?.messages ?? [];
  const isStreaming = retained.snapshot?.isStreaming === true;
  const runtimeError = retained.snapshot?.error ?? null;
  const visibleMessages = filterVisibleBotMessages(messages, isStreaming);
  const lastVisible = visibleMessages[visibleMessages.length - 1];
  const userMessageCount = visibleMessages.reduce(
    (acc, m) => (m.role === "user" ? acc + 1 : acc),
    0,
  );
  const lastMessageSignature = `${lastVisible?.id ?? "none"}:${lastVisible?.content.length ?? 0}:${isStreaming ? 1 : 0}`;

  const { showScrollToBottom, scrollToBottom, notifyUserSent } = useBotChatScroll({
    scrollRef,
    contentRef,
    sessionKey: targetSessionId || "bot-main",
    messageCount: visibleMessages.length,
    userMessageCount,
    lastMessageSignature,
    isStreaming,
  });

  useEffect(() => {
    const decision = resolvePendingAutoSend({
      pendingPrompt: ui.pendingAutoSendPrompt,
      canAttach,
      hasHandle: retained.handle !== null,
      handlePhase,
      isStreaming,
      desiredProvider,
      desiredModelId,
    });
    const trimmed = ui.pendingAutoSendPrompt?.trim() ?? "";
    if (decision === "clear") {
      patchBotUi({ pendingAutoSendPrompt: null });
    } else if (decision === "send" && retained.handle !== null) {
      patchBotUi({ pendingAutoSendPrompt: null });
      notifyUserSent();
      void retained.handle.sendMessage(trimmed, []);
    } else if (decision === "fallback-draft") {
      patchBotUi({ pendingAutoSendPrompt: null, composerDraft: trimmed });
    }
  }, [
    ui.pendingAutoSendPrompt,
    canAttach,
    retained.handle,
    handlePhase,
    isStreaming,
    desiredProvider,
    desiredModelId,
    notifyUserSent,
  ]);

  const isMain = ui.activeSessionId === null || ui.activeSessionId === snapshot.mainSessionId;
  const activeSide = snapshot.sideThreads.find((t) => t.sessionId === targetSessionId);
  const topTitle = isMain ? "聊天" : (activeSide?.title ?? "旁聊");
  const pendingApprovalsCount = snapshot.pendingApprovals.length;
  const drawerVisible = ui.chatDrawerOpen || ui.chatDrawerPinned;

  const handleDraftChange = (next: string) => {
    patchBotUi({
      composerDraft: next,
      ...(ui.characterMoodMode === "manual" && next.trim().length > 0
        ? { characterMoodMode: "auto", characterSpeech: null }
        : {}),
    });
  };

  const handleSelectQuickOption = (optionText: string) => {
    const trimmed = optionText.trim();
    if (trimmed === "") return;
    if (
      retained.handle !== null &&
      handlePhase === "ready" &&
      !isStreaming &&
      desiredProvider !== "" &&
      desiredModelId !== ""
    ) {
      notifyUserSent();
      void retained.handle.sendMessage(trimmed, []);
      return;
    }
    patchBotUi({ pendingAutoSendPrompt: trimmed });
  };

  const mergedCatalog = getMergedConnectorCatalog(ui.pluginConnectors);
  const composerAvailableApps = mergedCatalog.map((entry) => ({
    id: entry.id,
    name: entry.name,
    connected: resolveConnectorState(entry, snapshot, ui.mcpStatus, appSettings?.mcpServers ?? []).connected,
  }));

  const topModelLabel = resolvedBotModel.label;

  const handleSelectPrimaryModel = async (next: { provider: string; model: string } | null) => {
    await ctrl.configureBot({ modelConfig: { primary: next } });
    const target =
      next ??
      (defaultFallbackModel.provider !== "" && defaultFallbackModel.modelId !== ""
        ? { provider: defaultFallbackModel.provider, model: defaultFallbackModel.modelId }
        : null);
    if (target && retained.handle !== null) {
      const matched = availableModels.find(
        (m) => m.provider === target.provider && m.id === target.model,
      );
      await retained.handle
        .setModel(matched ?? { id: target.model, name: target.model, provider: target.provider })
        .catch(() => undefined);
    }
    navigationService?.showToast(
      next ? `分身主力模型已切换为 ${next.model}` : "已恢复跟随默认模型",
      "info",
    );
  };

  const toggleComposerApp = (appId: string) => {
    const exists = ui.composerApps.includes(appId);
    patchBotUi({
      composerApps: exists ? ui.composerApps.filter((x) => x !== appId) : [...ui.composerApps, appId],
    });
  };

  const handleSubmit = async (queuedAttachments: AttachmentPayload[]) => {
    const trimmed = ui.composerDraft.trim();
    if (trimmed === "" && queuedAttachments.length === 0) return;

    const appLabels = ui.composerApps
      .map((id) => mergedCatalog.find((c) => c.id === id)?.name ?? id)
      .join("、");
    const prefixed = appLabels !== "" ? `[已关联连接器上下文: ${appLabels}]\n${trimmed}` : trimmed;
    const fullText = ui.quotedText ? `> ${ui.quotedText}\n\n${prefixed}` : prefixed;
    patchBotUi({ composerDraft: "", quotedText: null, composerApps: [] });

    if (retained.handle === null) {
      navigationService?.showToast("正在连接后台会话服务，请稍候重试", "warning");
      return;
    }
    notifyUserSent();
    if (
      desiredProvider !== "" &&
      desiredModelId !== "" &&
      (currentProvider !== desiredProvider || currentModelId !== desiredModelId)
    ) {
      await retained.handle
        .setModel({
          id: desiredModelId,
          name: resolvedBotModel.label || desiredModelId,
          provider: desiredProvider,
        })
        .catch(() => undefined);
    }
    await retained.handle.sendMessage(fullText, queuedAttachments);
    notifyUserSent();
  };

  const showTrailingThinking =
    isStreaming && (lastVisible === undefined || lastVisible.role === "user");
  const isHydratingHistory =
    canAttach &&
    (handlePhase === "starting" || (handlePhase === "idle" && retained.handle !== null)) &&
    visibleMessages.length === 0 &&
    !isStreaming;
  const isEmptyChat = !isHydratingHistory && visibleMessages.length === 0 && !isStreaming;

  return (
    <div className={`qj-bot-chat-shell${compactSplit ? " is-compact-split" : ""}`}>
      <BotSideChatDrawer ctx={ctx} isMainStreaming={isMain && isStreaming} />

      <div className="qj-bot-chat-col">
        <BotChatFloatingTopbar
          topTitle={topTitle}
          isMain={isMain}
          drawerVisible={drawerVisible}
          compactSplit={compactSplit}
          rightPanelOpen={ui.rightPanelOpen}
          voiceCallActive={ui.voiceCallActive}
          pendingApprovalsCount={pendingApprovalsCount}
          modelLabel={topModelLabel}
          availableModels={availableModels}
          selectedPrimaryKey={encodeBotModelKey(snapshot.modelConfig.primary)}
          defaultModelLabel={
            defaultFallbackModel.provider !== "" ? defaultFallbackModel.label : undefined
          }
          onSelectPrimaryModel={(next) => void handleSelectPrimaryModel(next)}
          onOpenDrawer={() => patchBotUi({ chatDrawerOpen: true })}
          onOpenModels={() => openBotModal("settings", "models")}
          onOpenApprovals={() =>
            patchBotUi({ activeView: "chat", rightPanelOpen: true, rightTab: "approvals" })
          }
          onToggleVoice={() => {
            const next = !ui.voiceCallActive;
            patchBotUi({ voiceCallActive: next });
            navigationService?.showToast(next ? "实时语音模式已开启" : "已结束语音模式", "info");
          }}
          onOpenRightPanel={() => patchBotUi({ rightPanelOpen: true })}
        />

        <div
          ref={scrollRef}
          id="muse-chat-scroll"
          className={`qj-bot-chat-scroll${isEmptyChat ? " is-empty" : ""}`}
        >
          <div ref={contentRef} className="qj-bot-chat-stream">
            {isHydratingHistory ? (
              <div className="qj-sanctuary-empty-stack">
                <BotHistoryHydratingState />
              </div>
            ) : isEmptyChat ? (
              <div className="qj-sanctuary-empty-stack">
                <BotChatHeroStage
                  isMain={isMain}
                  topTitle={isMain ? "主聊天" : topTitle}
                  isStreaming={isStreaming}
                />
              </div>
            ) : (
              <>
                <div className="qj-muse-date-divider">{formatBotDividerTimestamp()}</div>

                {visibleMessages.map((msg) => {
                  if (msg.role === "user") {
                    return (
                      <div key={msg.id} className="qj-sanctuary-msg-user-row">
                        <div className="qj-sanctuary-bubble-user">{msg.content}</div>
                      </div>
                    );
                  }
                  const cleanContent = stripBotThinking(msg.content);
                  if (cleanContent.trim() === "") {
                    return <BotLiveThinkingRow key={msg.id} />;
                  }
                  const reacted = reactedIds[msg.id] === true;
                  const replyModel =
                    typeof msg.model === "string" && msg.model !== "" && msg.model !== "bot-companion"
                      ? msg.model
                      : undefined;
                  return (
                    <BotAssistantBubbleRow
                      key={msg.id}
                      msgId={msg.id}
                      cleanContent={cleanContent}
                      replyModel={replyModel}
                      isStreaming={isStreaming}
                      reacted={reacted}
                      moreOpen={moreMsgId === msg.id}
                      onToggleReaction={() =>
                        setReactedIds((prev) => ({ ...prev, [msg.id]: !reacted }))
                      }
                      onQuote={(snippet) => patchBotUi({ quotedText: snippet })}
                      onToggleMore={() => setMoreMsgId((cur) => (cur === msg.id ? null : msg.id))}
                      onCloseMore={() => setMoreMsgId(null)}
                      onCopy={(body) => {
                        setMoreMsgId(null);
                        void navigator.clipboard?.writeText(body);
                        navigationService?.showToast("已复制消息", "info");
                      }}
                      onBranchSideChat={(body) => {
                        setMoreMsgId(null);
                        patchBotUi({ quotedText: body.slice(0, 120) });
                        void ctrl.createSideChat(body.replace(/\s+/g, " ").trim().slice(0, 22));
                      }}
                      onOpenInWorkbench={(body) => {
                        setMoreMsgId(null);
                        ctrl.triggerHandoff({
                          id: `msg-${msg.id}`,
                          title: body.slice(0, 32) || "对话任务接力",
                          kindLabel: "对话上下文接力",
                          summary: body.slice(0, 180),
                          targetCwd: cwd || effectiveCwd,
                        });
                      }}
                      onSelectQuickOption={handleSelectQuickOption}
                    />
                  );
                })}

                {showTrailingThinking && <BotLiveThinkingRow />}
              </>
            )}

            {isMain &&
              snapshot.embeddedTasks.map((task) => (
                <div key={task.id} className="qj-msg-row qj-sanctuary-msg-bot-row" data-testid="bot-handoff-card">
                  <div className="qj-sanctuary-handoff-card">
                    <div className="qj-sanctuary-handoff-head">
                      <CalendarTaskTileIcon />
                      <div className="qj-sanctuary-handoff-titles">
                        <div className="qj-sanctuary-handoff-title">{task.title}</div>
                        <div className="qj-sanctuary-handoff-kind">{task.kindLabel}</div>
                      </div>
                    </div>
                    <p className="qj-sanctuary-handoff-summary">{task.summary}</p>
                    <button
                      type="button"
                      className="qj-sanctuary-handoff-btn"
                      onClick={() => ctrl.triggerHandoff(task)}
                    >
                      <span>在 Agent 工作台中打开</span>
                      <ArrowUpRight size={14} />
                    </button>
                  </div>
                </div>
              ))}

            {runtimeError && (
              <div className="qj-sanctuary-error-card">
                <span>{runtimeError}</span>
                <button
                  type="button"
                  className="qj-primary-pill-btn qj-sanctuary-error-btn"
                  onClick={() => openBotModal("settings", "models")}
                >
                  配置模型服务
                </button>
              </div>
            )}
          </div>
        </div>

        {showScrollToBottom && !isEmptyChat && (
          <button
            type="button"
            className={`qj-bot-scroll-bottom-btn${isStreaming ? " is-streaming" : ""}`}
            data-testid="bot-scroll-to-bottom-btn"
            aria-label="滚动到最新消息"
            onClick={() => scrollToBottom("smooth")}
          >
            <ArrowDown size={14} strokeWidth={2} />
            <span>{isStreaming ? "最新回复" : "回到底部"}</span>
          </button>
        )}

        <footer className="qj-bot-docked-footer">
          <BotChatComposer
            draft={ui.composerDraft}
            quotedText={ui.quotedText}
            isStreaming={isStreaming}
            availableApps={composerAvailableApps}
            selectedApps={ui.composerApps}
            onToggleApp={toggleComposerApp}
            onOpenConnectors={() => openBotConnector(null)}
            onDraftChange={handleDraftChange}
            onClearQuote={() => patchBotUi({ quotedText: null })}
            onSubmit={handleSubmit}
            onAbort={() => void retained.handle?.abort()}
            onVoiceHint={() => navigationService?.showToast("请开始说话，或直接输入文字消息", "info")}
          />
        </footer>
      </div>
    </div>
  );
}
