/**
 *《千机 · 角色与任务工坊》(`Live2DShowcaseModal`).
 *
 * Frameless full-bleed `<ExhibitionBackdrop>` (`1040px × 656px`):
 * - Left 58% open borderless `540px × 540px` Live2D exhibition led directly by
 *   character heading (`<h1>`, zero eyebrow kicker), live Task Stage HUD preview,
 *   and bottom frosted-glass framing & quick-reaction dock.
 * - Right 42% flat frosted-glass inspector (`Live2DShowcaseControls`, zero nested cards).
 */
import { useEffect, useState, type DragEvent, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { FolderArchive, Hand, Heart, Maximize2, Sparkles, User, UserCheck } from "lucide-react";
import type { BotAvatarPresetId } from "@qianji/protocol";
import { resolveCharacterPresence } from "../botCharacterState";
import { useBotController, useBotSnapshot, useBotUiState } from "../botStore";
import { REHEARSABLE_STAGE_BY_ID } from "./botTaskChoreographer";
import { pickExpressionByHint, pickMotionByCategory } from "./live2dCatalog";
import {
  closeLive2DShowcase,
  importCustomLive2DPackage,
  recordLive2DHitBanner,
  reportLive2DCatalog,
  reportLive2DExpression,
  reportLive2DHeadTrackingStatus,
  reportLive2DMotion,
  selectLive2DExpression,
  selectLive2DMotion,
  setLive2DFramingMode,
  useLive2DDirectorState,
} from "./live2dDirectorStore";
import { Live2DShowcaseControls } from "./Live2DShowcaseControls";
import { Live2DViewport } from "./Live2DViewport";
import { ExhibitionBackdrop, useIsLightDocumentTheme } from "./parallaxBackdrop";
import { resolveLive2DPresetMeta } from "./types";

const CHARACTER_EN_NAME: Readonly<Record<Exclude<BotAvatarPresetId, "custom">, string>> = {
  "alabaster-felt": "Mao · Live2D",
  "warm-felt": "Hiyori · Live2D",
  "plush-ears": "Rice · Live2D",
};

export function Live2DShowcaseModal({ ctx }: { readonly ctx?: Context }): ReactElement | null {
  const director = useLive2DDirectorState();
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const isLightDoc = useIsLightDocumentTheme();
  const [draggingFile, setDraggingFile] = useState(false);

  useEffect(() => {
    if (!director.showcaseOpen || typeof window === "undefined") return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeLive2DShowcase();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [director.showcaseOpen]);

  if (!director.showcaseOpen) return null;

  const presence = resolveCharacterPresence({ ui, snapshot });
  const activePreset = snapshot.profile.avatarPreset;
  const presetMeta = resolveLive2DPresetMeta(activePreset);
  const isDarkGallery = !isLightDoc || director.backdropTheme === "velvet-night";

  const rehearsingStage =
    director.rehearsingTaskStageId !== null
      ? (REHEARSABLE_STAGE_BY_ID.get(director.rehearsingTaskStageId) ?? null)
      : null;
  const rehearsingBinding =
    director.rehearsingTaskStageId !== null
      ? director.taskStageBindings[director.rehearsingTaskStageId]
      : undefined;

  const customPhotoUrl =
    activePreset === "custom" &&
    director.customModelSource === null &&
    snapshot.profile.customAvatarDataUrl
      ? snapshot.profile.customAvatarDataUrl
      : null;

  const personaTitle =
    director.customModelFileName !== null
      ? director.customModelFileName.replace(/\.(?:zip|model3\.json|json)$/i, "")
      : presetMeta.nameZh;
  const personaSubtitle =
    director.customModelFileName !== null
      ? "Custom · Live2D"
      : activePreset === "custom"
        ? "Companion · Live2D"
        : CHARACTER_EN_NAME[activePreset];

  const activeExpLabel =
    director.availableExpressions.find(
      (e) => e.id === (director.selectedExpressionId ?? director.liveExpression?.id),
    )?.labelZh ??
    director.liveExpression?.labelZh ??
    "自然神态";
  const activeMotionLabel =
    director.availableMotions.find(
      (m) => m.id === (director.selectedMotionId ?? director.liveMotion?.id),
    )?.labelZh ??
    director.liveMotion?.labelZh ??
    "灵动待机";

  const activeWhisperLabel =
    rehearsingStage !== null
      ? `演练状态 · ${rehearsingStage.labelZh}`
      : director.demoReelActive && director.demoReelCaption !== null
        ? director.demoReelCaption
        : (director.liveMotion?.labelZh ?? director.liveExpression?.labelZh ?? presetMeta.subtitleZh);

  const stageExpression = rehearsingStage ? rehearsingStage.defaultExpression : presence.expression;
  const stageAction = rehearsingStage ? rehearsingStage.defaultAction : presence.action;
  const stageSpeech = rehearsingStage?.speechText ?? null;

  const triggerQuickMoment = (
    expHint: "smile" | "shy" | "sparkle",
    motionCat: "greeting" | "emotion" | "special",
  ) => {
    const exp = pickExpressionByHint(director.availableExpressions, expHint);
    const motion = pickMotionByCategory(
      director.availableMotions,
      motionCat,
      director.motionNonce + 1,
    );
    if (exp !== null) selectLive2DExpression(exp.id);
    if (motion !== null) selectLive2DMotion(motion.id);
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDraggingFile(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    const loadedId = await importCustomLive2DPackage(file);
    if (loadedId !== null) {
      void ctrl.updateProfile({ avatarPreset: "custom" });
    }
  };

  return (
    <div
      className="qj-bot-modal-backdrop qj-showcase-backdrop"
      data-testid="bot-live2d-showcase-modal"
      onClick={() => closeLive2DShowcase()}
      onDragOver={(event) => {
        event.preventDefault();
        if (!draggingFile) setDraggingFile(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) {
          setDraggingFile(false);
        }
      }}
      onDrop={(event) => void handleDrop(event)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${snapshot.profile.displayName} · 角色与任务工坊`}
        className={`qj-bot-dialog qj-l2d-modal${draggingFile ? " is-dragging" : ""}`}
        data-gallery-surface={isDarkGallery ? "dark" : "light"}
        style={{
          ["--portal-accent" as string]: presetMeta.accentHex,
          ["--portal-rim" as string]: presetMeta.glowHex,
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <ExhibitionBackdrop
          theme={director.backdropTheme}
          accentHex={presetMeta.accentHex}
          glowHex={presetMeta.glowHex}
          parallaxStrength={director.parallaxStrength}
        />

        {draggingFile && (
          <div className="qj-showcase-drop-overlay" aria-hidden="true">
            <div className="qj-showcase-drop-card">
              <FolderArchive size={22} />
              <div className="qj-showcase-drop-title">松开鼠标导入 Live2D 模型包</div>
              <div className="qj-showcase-drop-sub">
                支持包含 .model3.json 的 Cubism 4 .zip 压缩包即时渲染
              </div>
            </div>
          </div>
        )}

        <div className="qj-l2d-exhibition-stage">
          <header className="qj-l2d-editorial-anchor">
            <h1 className="qj-l2d-editorial-name">{personaTitle}</h1>
            <div className="qj-l2d-editorial-meta">
              <span>{personaSubtitle}</span>
              <span className="qj-l2d-editorial-sep" aria-hidden="true" />
              <span className="qj-l2d-editorial-whisper">{activeWhisperLabel}</span>
            </div>
          </header>

          {rehearsingStage !== null && (
            <div
              className="qj-l2d-stage-task-hud"
              data-testid="workshop-stage-task-hud"
              data-stage={rehearsingStage.id}
              data-tone={rehearsingStage.statusTone}
              role="status"
            >
              <div className="qj-l2d-task-hud-head">
                <span className="qj-companion-task-dot" aria-hidden="true" />
                <span>{rehearsingStage.sampleToolLabel}</span>
              </div>
              <div className="qj-l2d-task-hud-speech">{rehearsingStage.speechText}</div>
              <div className="qj-l2d-task-hud-meta">
                <span>
                  联动演绎：{activeExpLabel} · {activeMotionLabel}
                  {rehearsingBinding !== undefined ? "（专属绑定）" : "（智能预设）"}
                </span>
              </div>
            </div>
          )}

          <div className="qj-l2d-open-character-well" data-framing={director.framingMode}>
            <Live2DViewport
              preset={activePreset}
              customModelSource={director.customModelSource}
              customModelUrl={customPhotoUrl}
              expression={stageExpression}
              action={stageAction}
              activeMotionId={director.selectedMotionId}
              motionNonce={director.motionNonce}
              activeExpressionId={director.selectedExpressionId}
              expressionNonce={director.expressionNonce}
              showcaseStepIndex={director.demoReelActive ? director.demoReelStepIndex : null}
              showcaseStepNonce={director.motionNonce}
              voiceActive={ui.voiceCallActive}
              speechText={stageSpeech}
              stageVariant="showcase"
              framingMode={director.framingMode}
              width={540}
              height={540}
              backdropTheme={director.backdropTheme}
              parallaxStrength={director.parallaxStrength}
              headTrackingEnabled={director.headTrackingEnabled}
              interactive
              onCatalogReady={reportLive2DCatalog}
              onMotionChange={reportLive2DMotion}
              onExpressionChange={reportLive2DExpression}
              onHitZone={(zone, motion, _exp, combo) => {
                recordLive2DHitBanner(zone, motion, combo);
              }}
              onHeadTrackingStatusChange={reportLive2DHeadTrackingStatus}
            />
          </div>

          <footer className="qj-l2d-dock-wrap">
            <div className="qj-showcase-bottom-dock">
              <div className="qj-showcase-framing-toggle" role="group" aria-label="画幅切换">
                <button
                  type="button"
                  data-testid="showcase-framing-half"
                  className={`qj-showcase-framing-btn${director.framingMode === "half-body" ? " active" : ""}`}
                  onClick={() => setLive2DFramingMode("half-body")}
                >
                  <UserCheck size={12.5} />
                  <span>半身立绘</span>
                </button>
                <button
                  type="button"
                  data-testid="showcase-framing-bust"
                  className={`qj-showcase-framing-btn${director.framingMode === "bust-breakout" ? " active" : ""}`}
                  onClick={() => setLive2DFramingMode("bust-breakout")}
                >
                  <User size={12.5} />
                  <span>特写近景</span>
                </button>
                <button
                  type="button"
                  data-testid="showcase-framing-full"
                  className={`qj-showcase-framing-btn${director.framingMode === "full-art" ? " active" : ""}`}
                  onClick={() => setLive2DFramingMode("full-art")}
                >
                  <Maximize2 size={12} />
                  <span>全身立绘</span>
                </button>
              </div>

              <span className="qj-showcase-dock-divider" aria-hidden="true" />

              <div className="qj-showcase-quick-triggers">
                <button
                  type="button"
                  className="qj-showcase-trigger-chip"
                  onClick={() => triggerQuickMoment("smile", "greeting")}
                >
                  <Hand size={12.5} />
                  <span>热情问候</span>
                </button>
                <button
                  type="button"
                  className="qj-showcase-trigger-chip"
                  onClick={() => triggerQuickMoment("shy", "emotion")}
                >
                  <Heart size={12.5} />
                  <span>温柔互动</span>
                </button>
                <button
                  type="button"
                  className="qj-showcase-trigger-chip"
                  onClick={() => triggerQuickMoment("sparkle", "special")}
                >
                  <Sparkles size={12.5} />
                  <span>招牌动作</span>
                </button>
              </div>
            </div>
          </footer>
        </div>

        <Live2DShowcaseControls
          director={director}
          activePreset={activePreset}
          onSelectPreset={(presetId) => void ctrl.updateProfile({ avatarPreset: presetId })}
          onActivateCustomModel={() => void ctrl.updateProfile({ avatarPreset: "custom" })}
          onClose={() => closeLive2DShowcase()}
        />
      </div>
    </div>
  );
}
