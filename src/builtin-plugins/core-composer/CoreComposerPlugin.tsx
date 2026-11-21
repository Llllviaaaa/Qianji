/**
 * Built-in default `composer.main` component (ADR 0023 `core-composer`).
 *
 * Preserves Qianji's composer chrome, CSS classes, ARIA labels, workspace
 * breadcrumb, model/thinking switcher, follow-up queue drawer, and delegates
 * child extension points to `composer.banners`, `composer.attachments`,
 * `composer.input`, `composer.toolbar`, and `composer.status`.
 *
 * Designed to survive `overlay: true` chain takeover under `display: none`
 * without unmounting or losing typed draft state.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  CornerUpRight,
  ListOrdered,
  Square,
  Trash2,
} from "lucide-react";
import {
  rewindController,
  useComposerState,
  useFrontendService,
  useSessionHandle,
  useSessionState,
  useThemeState,
  useWorkspaceState,
  type AttachmentPayload,
} from "@qianji/client";
import type {
  ComposerMainSlotProps,
  SlotComponentProps,
} from "@qianji/client-slots";
import {
  buildComposerPlaceholder,
  formatSendShortcutHint,
  parseSubmittedSlashCommand,
  resolveComposerSessionKey,
  STREAMING_BEHAVIOR_OPTIONS,
} from "./composerHelpers";
import { CoreComposerBreadcrumb, CoreComposerModelPicker } from "./CoreComposerControls";

const EMPTY_ATTACHMENTS: readonly AttachmentPayload[] = [];

export function CoreComposerMain({
  cwd: ownerCwd,
  sessionFile: ownerSessionFile,
  variant = "follow-up",
  sessionKey: ownerSessionKey,
  isolated,
  isStreaming: ownerStreaming,
  quickChat = false,
  environment = "local",
  onQuickChat,
  onEnvironmentChange,
  onSend: ownerOnSend,
  sessionId,
  renderSlot,
  renderFactory,
}: SlotComponentProps<ComposerMainSlotProps, "session-maybe">): ReactNode {
  const composerService = useFrontendService("composerService");
  const sessionService = useFrontendService("sessionService");
  const workspaceService = useFrontendService("workspaceService");
  const sessionState = useSessionState();
  const themeState = useThemeState();
  const workspaceState = useWorkspaceState();
  const requireCtrlEnter = themeState?.requireCtrlEnter === true;
  const defaultFollowUpBehavior = themeState?.followUpBehavior ?? "steer";

  const handleOptions = useMemo(
    () => (isolated === true ? { isolated: true, cwd: ownerCwd } : undefined),
    [isolated, ownerCwd],
  );
  const { handle, snapshot: handleSnap } = useSessionHandle(sessionId, handleOptions);

  const resolvedCwd =
    ownerCwd !== undefined
      ? ownerCwd
      : (handleSnap?.cwd ?? sessionState?.cwd ?? workspaceState?.cwd ?? "");
  const resolvedSessionFile =
    ownerSessionFile !== undefined
      ? ownerSessionFile
      : (handleSnap?.sessionFile ?? sessionState?.sessionFile ?? null);
  const resolvedSessionKey = resolveComposerSessionKey(ownerSessionKey, sessionId, resolvedSessionFile);
  const composerSnap = useComposerState(resolvedSessionKey);

  const draft = composerSnap?.draft ?? "";
  const prefill = composerSnap?.prefill ?? null;
  const attachments = composerSnap?.attachments ?? EMPTY_ATTACHMENTS;
  const queuedMessages = composerSnap?.managedFollowUpQueue ?? [];
  const pendingCount =
    queuedMessages.length +
    (composerSnap?.steeringQueue.length ?? 0) +
    (composerSnap?.followUpQueue.length ?? 0);

  const isStreaming =
    ownerStreaming ??
    (handleSnap !== null ? handleSnap.isStreaming : (sessionState?.isStreaming ?? false));
  const isSwitchingModel = sessionState?.isSwitchingModel ?? false;
  const [streamingBehavior, setStreamingBehavior] = useState<"steer" | "followUp">(defaultFollowUpBehavior);
  const [syncedFollowUpDefault, setSyncedFollowUpDefault] = useState(defaultFollowUpBehavior);
  const [streamingMenuOpen, setStreamingMenuOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const streamingWrapRef = useRef<HTMLDivElement>(null);

  if (syncedFollowUpDefault !== defaultFollowUpBehavior) {
    setSyncedFollowUpDefault(defaultFollowUpBehavior);
    setStreamingBehavior(defaultFollowUpBehavior);
  }
  if (!isStreaming && streamingMenuOpen) {
    setStreamingMenuOpen(false);
  }

  useEffect(() => {
    if (!streamingMenuOpen || typeof document === "undefined") return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target !== null && streamingWrapRef.current !== null && streamingWrapRef.current.contains(target)) {
        return;
      }
      setStreamingMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setStreamingMenuOpen(false);
        event.stopPropagation();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [streamingMenuOpen]);

  // Apply external prefill requests cleanly via composerService (no setState in effect)
  useEffect(() => {
    if (prefill === null || composerService === undefined) return;
    composerService.setDraft(prefill, resolvedSessionKey);
    composerService.consumePrefill(resolvedSessionKey);
  }, [prefill, composerService, resolvedSessionKey]);

  const sendDisabled = isSwitchingModel || (draft.trim() === "" && attachments.length === 0);

  const handleSubmit = useCallback(async () => {
    const currentDraft = composerService?.getDraft(resolvedSessionKey) ?? draft;
    const currentAttachments = [...(composerService?.getSnapshot(resolvedSessionKey).attachments ?? attachments)];
    if (isSwitchingModel || (currentDraft.trim() === "" && currentAttachments.length === 0)) {
      return;
    }

    const slash = parseSubmittedSlashCommand(currentDraft);
    if (slash !== null && composerService !== undefined) {
      const intercepted = await composerService.tryHandleSlashCommand(slash.name, slash.rawArgs, {
        cwd: resolvedCwd,
        sessionFile: resolvedSessionFile,
        variant,
      });
      if (intercepted) {
        composerService.setDraft("", resolvedSessionKey);
        return;
      }
    }

    composerService?.setDraft("", resolvedSessionKey);
    composerService?.clearAttachments(resolvedSessionKey);

    let sent = false;
    if (ownerOnSend !== undefined) {
      const result = await ownerOnSend(currentDraft, currentAttachments);
      sent = result !== false;
    } else if (handle !== null) {
      sent = await handle.sendMessage(
        currentDraft,
        currentAttachments,
        isStreaming ? streamingBehavior : undefined,
      );
    } else if (sessionService !== undefined) {
      sent = await sessionService.sendMessage(
        currentDraft,
        currentAttachments,
        isStreaming ? streamingBehavior : undefined,
      );
    }

    if (sent) {
      rewindController.notifyDraftSent();
    } else {
      composerService?.setDraft(currentDraft, resolvedSessionKey);
      if (currentAttachments.length > 0) {
        composerService?.addAttachments(currentAttachments, resolvedSessionKey);
      }
    }
  }, [
    attachments,
    composerService,
    draft,
    handle,
    isStreaming,
    isSwitchingModel,
    ownerOnSend,
    resolvedCwd,
    resolvedSessionFile,
    resolvedSessionKey,
    sessionService,
    streamingBehavior,
    variant,
  ]);

  const handleStop = useCallback(() => {
    if (handle !== null) {
      void handle.abort();
    } else {
      void sessionService?.abort();
    }
  }, [handle, sessionService]);

  const placeholder = buildComposerPlaceholder({
    disabled: false,
    isStreaming,
    streamingBehavior,
    variant,
    requireCtrlEnter,
  });

  const showWorkspaceChips = variant === "task-start";
  const isInlineVariant = variant === "follow-up";
  const branchLabel = workspaceState?.git?.isRepository ? (workspaceState.git.branch ?? "") : "";
  const activeStreaming =
    STREAMING_BEHAVIOR_OPTIONS.find((opt) => opt.value === streamingBehavior) ?? STREAMING_BEHAVIOR_OPTIONS[0];
  const baseChildProps = {
    cwd: resolvedCwd,
    sessionFile: resolvedSessionFile,
    variant,
    sessionKey: resolvedSessionKey,
    ...(isolated === true ? { isolated: true } : {}),
  };

  return (
    <div
      className={`composer-area codex-composer ${showWorkspaceChips ? "task-start-composer" : "follow-up-composer"}`}
      data-slot="composer.main"
      data-testid="core-composer"
      data-composer-variant={isInlineVariant ? "inline" : "hero"}
      data-session-key={resolvedSessionKey}
    >
      {showWorkspaceChips && (
        <CoreComposerBreadcrumb
          workspace={resolvedCwd}
          workspaceOptions={workspaceState?.workspaceOptions ?? []}
          branchLabel={branchLabel}
          quickChat={quickChat}
          environment={environment}
          onSelectWorkspace={(next) => workspaceService?.selectWorkspace(next)}
          onPickWorkspace={() => {
            void workspaceService?.pickFolder();
          }}
          onQuickChat={
            onQuickChat ??
            (() => {
              workspaceService?.clearDraftWorkspace();
            })
          }
          onEnvironmentChange={onEnvironmentChange}
        />
      )}

      <div className="composer-dock-banners">
        {renderSlot("composer.banners", baseChildProps)}
      </div>

      <div
        className={`composer-card unified ${showWorkspaceChips ? "with-chips" : "follow-up"}`}
        data-composer-card=""
        data-composer-variant={isInlineVariant ? "inline" : "hero"}
        data-has-attachments={attachments.length > 0 ? "true" : undefined}
        data-dsh-claude-draft-empty={draft.trim() === "" ? "" : undefined}
      >
        {renderSlot("composer.attachments", {
          ...baseChildProps,
          attachments,
          onRemove: (index) => {
            const target = attachments[index];
            if (target !== undefined) {
              composerService?.removeAttachment(target.path, resolvedSessionKey);
            }
          },
        })}

        {renderSlot("composer.input", {
          ...baseChildProps,
          placeholder,
          disabled: false,
          quickChat,
          onSubmit: () => {
            void handleSubmit();
          },
        })}

        <div className="composer-toolbar">
          <div className="composer-toolbar-left">
            {renderSlot("composer.toolbar", baseChildProps)}

            {isStreaming && (
              <div className="streaming-behavior-wrap permission-context-wrap" ref={streamingWrapRef}>
                <button
                  type="button"
                  className={`chip chip-permission chip-streaming-behavior ${streamingMenuOpen ? "active" : ""}`}
                  aria-label={`运行中发送：${activeStreaming?.label ?? ""}`}
                  aria-haspopup="menu"
                  aria-expanded={streamingMenuOpen}
                  onClick={() => setStreamingMenuOpen((value) => !value)}
                >
                  {streamingBehavior === "steer" ? (
                    <CornerUpRight size={13} strokeWidth={1.75} />
                  ) : (
                    <ListOrdered size={13} strokeWidth={1.75} />
                  )}
                  <span>{activeStreaming?.chip}</span>
                  <ChevronDown size={11} strokeWidth={1.75} />
                </button>
                {streamingMenuOpen && (
                  <div className="permission-menu" role="menu" aria-label="运行中发送">
                    {STREAMING_BEHAVIOR_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={streamingBehavior === option.value}
                        className={streamingBehavior === option.value ? "active" : ""}
                        onClick={() => {
                          setStreamingBehavior(option.value);
                          setStreamingMenuOpen(false);
                        }}
                      >
                        <div className="permission-menu-copy">
                          <strong>{option.label}</strong>
                          <small>{option.description}</small>
                        </div>
                        {streamingBehavior === option.value && <Check size={14} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="composer-toolbar-right">
            {renderSlot("composer.status", { ...baseChildProps, position: "before-model" })}

            {renderFactory(
              "host.composer.modelPicker",
              { handle, sessionId },
              { fallback: <CoreComposerModelPicker handle={handle} sessionId={sessionId} /> },
            )}

            {renderSlot("composer.status", { ...baseChildProps, position: "after-model" })}

            {isStreaming ? (
              <button
                type="button"
                className="stop-button dsh-primary-send"
                aria-label="停止"
                title="停止"
                onClick={handleStop}
              >
                <Square size={11} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                className="send-button dsh-primary-send"
                disabled={sendDisabled}
                aria-label="发送"
                title={`发送 (${formatSendShortcutHint(requireCtrlEnter)})`}
                onClick={() => void handleSubmit()}
              >
                <ArrowUp size={16} strokeWidth={2.25} />
              </button>
            )}
          </div>
        </div>
      </div>

      {pendingCount > 0 && (
        <div className={`composer-queue ${queueOpen ? "open" : ""}`}>
          <button
            type="button"
            className="composer-queue-summary"
            aria-expanded={queuedMessages.length > 0 ? queueOpen : undefined}
            onClick={() => queuedMessages.length > 0 && setQueueOpen((value) => !value)}
          >
            <ListOrdered size={14} />
            <strong>{pendingCount} 条待处理</strong>
            {queuedMessages.length > 0 && (queueOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />)}
          </button>
          {queueOpen && queuedMessages.length > 0 && (
            <ol className="composer-queue-list" aria-label="待处理消息">
              {queuedMessages.map((item, index) => (
                <li key={item.id}>
                  <span className="composer-queue-order">{index + 1}</span>
                  <span className="composer-queue-copy">{item.text}</span>
                  <span className="composer-queue-actions">
                    <button
                      type="button"
                      disabled={index === 0}
                      title="上移"
                      onClick={() => composerService?.moveQueuedMessage(item.id, -1)}
                    >
                      <ChevronUp size={14} />
                    </button>
                    <button
                      type="button"
                      disabled={index === queuedMessages.length - 1}
                      title="下移"
                      onClick={() => composerService?.moveQueuedMessage(item.id, 1)}
                    >
                      <ChevronDown size={14} />
                    </button>
                    <button
                      type="button"
                      title="立即作为调整发送"
                      onClick={() => void composerService?.steerQueuedMessage(item.id)}
                    >
                      <CornerUpRight size={14} />
                    </button>
                    <button
                      type="button"
                      title="删除"
                      onClick={() => composerService?.removeQueuedMessage(item.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
