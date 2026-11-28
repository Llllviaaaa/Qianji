/**
 * Task-Aware Frameless Live2D Companion Header (`BotCharacterStage`, `220px × 236px`
 * in the right companion sheet), Shared Task Presence Hook (`useCompanionTaskRuntime`),
 * & Empty Chat Hero (`BotChatHeroStage`, `290px × 310px` when right panel is collapsed).
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { Pencil, Sparkles } from "lucide-react";
import {
  openSettingsPage,
  useFrontendService,
  useRpcState,
  useSessionHandle,
  useSessionState,
  useWorkspaceState,
  type SessionHandle,
} from "@qianji/client";
import {
  applyGazePointerMove,
  BotCharacterRig,
  resetGazePointer,
  triggerCharacterPoke,
} from "./BotCharacterRig";
import { BotHeroTaskDeck } from "./BotHeroTaskDeck";
import {
  openBotModal,
  patchBotUi,
  useBotController,
  useBotSnapshot,
  useBotUiState,
} from "./botStore";
import {
  CO_PILOT_TASK_PROMPTS,
  extractLiveSessionToolActivity,
  resolveTaskCompanionPresence,
  useHoveredHeroTaskPreview,
  type LiveSessionMessageLike,
  type ResolvedTaskCompanionPresence,
  type TaskQuickActionChip,
} from "./live2d/botTaskChoreographer";
import {
  openLive2DShowcase,
  useLive2DDirectorState,
} from "./live2d/live2dDirectorStore";

function resolveActiveTargetSessionFile(targetSessionId: string): string {
  if (targetSessionId === "") return "";
  return targetSessionId.startsWith("harness:") ? targetSessionId : `harness:${targetSessionId}`;
}

const AUTO_VISIBLE_BUBBLE_PHASES: ReadonlySet<string> = new Set([
  "awaiting-approval",
  "task-error",
]);

export interface CompanionTaskRuntimeSnapshot {
  readonly taskPresence: ResolvedTaskCompanionPresence;
  readonly isStreaming: boolean;
  readonly retainedHandle: SessionHandle | null;
  readonly hostConnected: boolean;
}

export function useCompanionTaskRuntime(
  ctx?: Context,
  options?: { readonly hoveringStage?: boolean; readonly trackIdleLook?: boolean },
): CompanionTaskRuntimeSnapshot {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const sessionSnap = useSessionState(ctx);
  const workspaceSnap = useWorkspaceState(ctx);
  const rpcSnap = useRpcState(ctx);
  const hoveredPreview = useHoveredHeroTaskPreview();

  const targetSessionId = ui.activeSessionId ?? snapshot.mainSessionId;
  const targetSessionFile = resolveActiveTargetSessionFile(targetSessionId);
  const effectiveCwd = snapshot.botCwd || workspaceSnap?.cwd || "";
  const canAttach = targetSessionFile !== "" && effectiveCwd !== "";

  const retained = useSessionHandle(
    canAttach ? targetSessionFile : null,
    canAttach ? { isolated: false, autoStart: false, cwd: effectiveCwd } : undefined,
    ctx,
  );

  const isStreaming =
    retained.snapshot?.isStreaming === true ||
    (targetSessionFile !== "" &&
      (sessionSnap?.runningSessionFiles?.includes(targetSessionFile) ?? false));

  const retainedMessages = retained.snapshot?.messages;
  const serviceMessages = sessionSnap?.messages;
  const serviceSessionFile = sessionSnap?.sessionFile;

  const toolActivity = useMemo(() => {
    const msgs =
      retainedMessages && retainedMessages.length > 0
        ? retainedMessages
        : targetSessionFile !== "" && serviceSessionFile === targetSessionFile
          ? (serviceMessages ?? [])
          : [];
    return extractLiveSessionToolActivity(msgs as unknown as readonly LiveSessionMessageLike[]);
  }, [retainedMessages, serviceMessages, serviceSessionFile, targetSessionFile]);

  const runningWorkbenchCount =
    sessionSnap?.runningSessionFiles?.filter((f) => f !== targetSessionFile).length ?? 0;

  const prevStreamingRef = useRef(isStreaming);
  const [justReplied, setJustReplied] = useState(false);
  const [idleLookAround, setIdleLookAround] = useState(false);
  const shouldTrackIdle = options?.trackIdleLook === true;

  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;
    if (typeof window === "undefined") return undefined;
    if (isStreaming || ui.modal === "settings") {
      const clearTimer = window.setTimeout(() => setJustReplied(false), 0);
      return () => window.clearTimeout(clearTimer);
    }
    if (wasStreaming && !isStreaming) {
      const enterTimer = window.setTimeout(() => setJustReplied(true), 0);
      const exitTimer = window.setTimeout(() => setJustReplied(false), 8000);
      return () => {
        window.clearTimeout(enterTimer);
        window.clearTimeout(exitTimer);
      };
    }
    return undefined;
  }, [isStreaming, ui.modal]);

  useEffect(() => {
    if (!shouldTrackIdle || typeof window === "undefined" || typeof document === "undefined") {
      return undefined;
    }
    let hideTimer: number | null = null;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      setIdleLookAround(true);
      if (hideTimer !== null) window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => setIdleLookAround(false), 2600);
    }, 22000);
    return () => {
      window.clearInterval(timer);
      if (hideTimer !== null) window.clearTimeout(hideTimer);
    };
  }, [shouldTrackIdle]);

  const taskPresence = resolveTaskCompanionPresence({
    ui,
    snapshot,
    isStreaming,
    justReplied,
    idleLookAround,
    hoveringStage: options?.hoveringStage === true,
    toolActivity,
    hoveredPreview,
    runtimeError: retained.snapshot?.error ?? null,
    runningWorkbenchCount,
  });

  return {
    taskPresence,
    isStreaming,
    retainedHandle: retained.handle,
    hostConnected: rpcSnap?.hostStatus === "connected",
  };
}

export function BotCharacterStage({ ctx }: { readonly ctx?: Context }): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const director = useLive2DDirectorState();
  const navigationService = useFrontendService("navigationService", ctx);
  const hoveredPreview = useHoveredHeroTaskPreview();
  const [hoveringStage, setHoveringStage] = useState(false);

  const { taskPresence, isStreaming, retainedHandle, hostConnected } = useCompanionTaskRuntime(
    ctx,
    { hoveringStage, trackIdleLook: true },
  );

  useEffect(() => {
    if (ui.characterMoodMode !== "manual" || typeof window === "undefined") return undefined;
    const timer = window.setTimeout(() => {
      patchBotUi({ characterMoodMode: "auto", characterSpeech: null });
    }, 3600);
    return () => window.clearTimeout(timer);
  }, [ui.characterMoodMode, ui.characterBurstNonce]);

  const effectiveExpression =
    hoveredPreview === null && ui.characterMoodMode === "manual"
      ? (ui.characterExpression || taskPresence.expression)
      : taskPresence.expression;
  const effectiveAction =
    hoveredPreview === null && ui.characterMoodMode === "manual"
      ? (ui.characterAction || taskPresence.action)
      : taskPresence.action;

  const activePreset = snapshot.profile.avatarPreset;
  const showBubble =
    (director.demoReelActive && director.demoReelCaption !== null) ||
    AUTO_VISIBLE_BUBBLE_PHASES.has(taskPresence.phase);

  const bubbleText =
    director.demoReelActive && director.demoReelCaption !== null
      ? director.demoReelCaption
      : taskPresence.speechText;

  const visibleQuickActions =
    director.demoReelActive || hoveredPreview !== null ? [] : taskPresence.quickActions;

  const dispatchPrompt = (promptText: string) => {
    patchBotUi({ characterMoodMode: "auto", characterSpeech: null });
    if (retainedHandle !== null && hostConnected) {
      void retainedHandle.sendMessage(promptText, []).catch(() => {
        patchBotUi({ activeView: "chat", composerDraft: promptText });
      });
      return;
    }
    patchBotUi({ activeView: "chat", composerDraft: promptText });
  };

  const handleQuickAction = (chip: TaskQuickActionChip) => {
    switch (chip.id) {
      case "approve-first": {
        const targetId = chip.approvalId ?? snapshot.pendingApprovals[0]?.id;
        patchBotUi({ characterMoodMode: "auto", characterSpeech: null });
        if (targetId !== undefined) void ctrl.resolveApproval(targetId, "approved");
        return;
      }
      case "open-approvals":
        patchBotUi({
          rightPanelOpen: true,
          rightTab: "approvals",
          characterMoodMode: "auto",
          characterSpeech: null,
        });
        return;
      case "run-patrol":
        patchBotUi({ characterMoodMode: "auto", characterSpeech: null });
        void ctrl.runPatrolNow();
        return;
      case "wake-server":
        patchBotUi({ characterMoodMode: "auto", characterSpeech: null });
        void ctrl.runServerAction("start");
        return;
      case "switch-workbench":
        patchBotUi({ characterMoodMode: "auto", characterSpeech: null });
        navigationService?.setShellMode("agent");
        return;
      case "open-providers":
        patchBotUi({ characterMoodMode: "auto", characterSpeech: null });
        if (navigationService !== undefined) {
          navigationService.setShellMode("agent");
          navigationService.openSettings("providers");
        } else {
          openSettingsPage("providers");
        }
        return;
      case "plan-today-goals":
        dispatchPrompt(chip.promptText ?? CO_PILOT_TASK_PROMPTS.planGoals);
        return;
      case "summarize-briefing":
        dispatchPrompt(chip.promptText ?? CO_PILOT_TASK_PROMPTS.summarizeBriefing);
        return;
      case "audit-workspace":
        dispatchPrompt(chip.promptText ?? CO_PILOT_TASK_PROMPTS.auditWorkspace);
        return;
    }
  };

  return (
    <div
      className="qj-muse-avatar-hero"
      data-testid="bot-character-stage"
      data-preset={activePreset}
      data-expression={effectiveExpression}
      data-action={effectiveAction}
      data-task-phase={taskPresence.phase}
      onPointerEnter={() => setHoveringStage(true)}
      onPointerMove={applyGazePointerMove}
      onPointerLeave={(event) => {
        setHoveringStage(false);
        resetGazePointer(event);
      }}
    >
      <div className="qj-companion-portal-anchor">
        {showBubble && bubbleText !== "" && (
          <div
            className={`qj-portal-speech-bubble${visibleQuickActions.length > 0 ? " interactive" : ""}`}
            data-testid="bot-companion-speech-bubble"
            role="status"
          >
            <span>{bubbleText}</span>
            {visibleQuickActions.length > 0 && (
              <div className="qj-bubble-quick-actions" data-testid="bot-companion-quick-actions">
                {visibleQuickActions.map((chip) => {
                  const toneClass =
                    chip.tone === "primary"
                      ? " primary"
                      : chip.tone === "warning"
                        ? " warning"
                        : "";
                  return (
                    <button
                      key={chip.id}
                      type="button"
                      data-testid={`companion-action-${chip.id}`}
                      className={`qj-bubble-action-pill${toneClass}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleQuickAction(chip);
                      }}
                    >
                      {chip.labelZh}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <BotCharacterRig
          preset={snapshot.profile.avatarPreset}
          customDataUrl={snapshot.profile.customAvatarDataUrl}
          expression={effectiveExpression}
          action={effectiveAction}
          taskPhase={taskPresence.phase}
          moodMode={ui.characterMoodMode}
          width={220}
          height={236}
          stageVariant="companion"
          framingMode="half-body"
          isStreaming={isStreaming}
          voiceActive={ui.voiceCallActive}
          speechText={isStreaming ? taskPresence.speechText : null}
          interactive
          burstNonce={ui.characterBurstNonce}
          onPoke={() => triggerCharacterPoke(ui.characterBurstNonce)}
        />

        <div className="qj-portal-action-dock">
          <button
            type="button"
            data-testid="btn-open-live2d-showcase"
            className="qj-muse-avatar-icon-btn"
            title="打开角色与任务工坊"
            aria-label="打开角色与任务工坊"
            onClick={() => openLive2DShowcase()}
          >
            <Sparkles size={13.5} strokeWidth={1.9} />
          </button>

          <button
            id="btn-edit-avatar"
            type="button"
            className="qj-muse-avatar-edit-btn"
            title="自定义声音和虚拟形象"
            aria-label="自定义声音和虚拟形象"
            onClick={() => openBotModal("settings", "voice")}
          >
            <Pencil size={13} strokeWidth={1.9} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function BotChatHeroStage({
  isMain,
  topTitle,
  isStreaming,
}: {
  readonly isMain: boolean;
  readonly topTitle: string;
  readonly isStreaming: boolean;
}): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const hoveredPreview = useHoveredHeroTaskPreview();
  const taskPresence = resolveTaskCompanionPresence({
    ui,
    snapshot,
    isStreaming,
    hoveredPreview,
  });

  return (
    <div
      className="qj-sanctuary-empty"
      onPointerMove={applyGazePointerMove}
      onPointerLeave={resetGazePointer}
    >
      {!ui.rightPanelOpen && (
        <div
          className="qj-hero-portrait-wrap"
          data-testid="bot-hero-character"
          data-expression={taskPresence.expression}
          data-action={taskPresence.action}
          data-task-phase={taskPresence.phase}
        >
          <BotCharacterRig
            preset={snapshot.profile.avatarPreset}
            customDataUrl={snapshot.profile.customAvatarDataUrl}
            expression={taskPresence.expression}
            action={taskPresence.action}
            taskPhase={taskPresence.phase}
            moodMode={ui.characterMoodMode}
            width={290}
            height={310}
            stageVariant="hero"
            framingMode="half-body"
            isStreaming={isStreaming}
            voiceActive={ui.voiceCallActive}
            speechText={isStreaming ? taskPresence.speechText : null}
            interactive
            burstNonce={ui.characterBurstNonce}
            onPoke={() => triggerCharacterPoke(ui.characterBurstNonce)}
          />
        </div>
      )}

      <h1
        className="qj-sanctuary-greeting"
        data-testid={ui.rightPanelOpen ? "bot-hero-orb" : undefined}
      >
        {isMain ? `你好，我是${snapshot.profile.displayName}` : topTitle}
      </h1>

      <BotHeroTaskDeck />
    </div>
  );
}
