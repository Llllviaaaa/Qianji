/**
 * Frameless 4K Live2D Companion Rig (`BotCharacterRig`).
 *
 * Renders `<Live2DViewport>` floating airily in a soft unboxed ambient aura
 * with silky bottom waist feathering (`framingMode="half-body"` default),
 * honoring user-bound Task-Stage Live2D expressions & motions while preserving
 * 100% backward selector and export parity.
 */
import { useRef, type ReactElement } from "react";
import type { BotAvatarPresetId } from "@qianji/protocol";
import { resolvePlushPrefix } from "./BotAvatarArt";
import {
  ACTION_LABELS,
  applyGazePointerMove,
  applyStageGazeMove,
  EXPRESSION_LABELS,
  resetGazePointer,
  resolveCharacterPresence,
  triggerCharacterPoke,
} from "./botCharacterState";
import { type BotActionId, type BotExpressionId, type BotMoodMode } from "./botUiAtoms";
import type { CompanionTaskPhaseId } from "./live2d/botTaskChoreographer";
import {
  recordLive2DHitBanner,
  reportLive2DCatalog,
  reportLive2DExpression,
  reportLive2DHeadTrackingStatus,
  reportLive2DMotion,
  resolveBoundTaskStagePose,
  useLive2DDirectorState,
} from "./live2d/live2dDirectorStore";
import { Live2DViewport } from "./live2d/Live2DViewport";
import { resolveLive2DPresetMeta, type Live2DFramingMode } from "./live2d/types";

export {
  ACTION_LABELS,
  applyGazePointerMove,
  applyStageGazeMove,
  EXPRESSION_LABELS,
  resetGazePointer,
  resolveCharacterPresence,
  triggerCharacterPoke,
};

export type PlushPoseKey = "calm" | "wave" | "think" | "patrol" | "curious" | "sleepy";

export const ALL_PLUSH_POSES: ReadonlyArray<PlushPoseKey> = [
  "calm",
  "wave",
  "think",
  "patrol",
  "curious",
  "sleepy",
];

export function resolvePlushPoseKey(expression: BotExpressionId, action: BotActionId): PlushPoseKey {
  if (expression === "sleepy") return "sleepy";
  if (action === "wave" || action === "celebrate" || expression === "happy") return "wave";
  if (action === "think" || expression === "focused") return "think";
  if (action === "scan" || expression === "patrol") return "patrol";
  if (expression === "curious" || action === "nod") return "curious";
  return "calm";
}

export function resolvePlushSpriteSrc(
  preset: BotAvatarPresetId,
  customDataUrl: string | undefined,
  poseKey: PlushPoseKey,
): string {
  if (preset === "custom" && customDataUrl) return customDataUrl;
  return `/bot-plush/${resolvePlushPrefix(preset)}-${poseKey}.webp`;
}

export interface BotCharacterRigProps {
  readonly preset: BotAvatarPresetId;
  readonly customDataUrl?: string;
  readonly expression: BotExpressionId;
  readonly action: BotActionId;
  readonly taskPhase?: CompanionTaskPhaseId;
  readonly moodMode?: BotMoodMode;
  readonly size?: number;
  readonly width?: number;
  readonly height?: number;
  readonly stageVariant?: "companion" | "hero" | "card-preview";
  readonly framingMode?: Live2DFramingMode;
  readonly isStreaming?: boolean;
  readonly voiceActive?: boolean;
  readonly speechText?: string | null;
  readonly interactive?: boolean;
  readonly burstNonce?: number;
  readonly onPoke?: () => void;
  readonly className?: string;
}

export function BotCharacterRig({
  preset,
  customDataUrl,
  expression,
  action,
  taskPhase,
  moodMode = "auto",
  size = 220,
  width,
  height,
  stageVariant = "companion",
  framingMode = "half-body",
  isStreaming = false,
  voiceActive = false,
  speechText = null,
  interactive = false,
  burstNonce = 0,
  onPoke,
  className = "",
}: BotCharacterRigProps): ReactElement {
  const director = useLive2DDirectorState();
  const zoneHandledClickRef = useRef(false);
  const stageWidth = width ?? size;
  const stageHeight = height ?? Math.round(stageWidth * 1.08);
  const presetMeta = resolveLive2DPresetMeta(preset);

  const customPhotoUrl =
    preset === "custom" &&
    director.customModelSource === null &&
    typeof customDataUrl === "string" &&
    customDataUrl.length > 0
      ? customDataUrl
      : null;

  const boundPose =
    !director.demoReelActive && moodMode !== "manual" && taskPhase !== undefined
      ? resolveBoundTaskStagePose(taskPhase, director)
      : null;

  const effectiveMotionId = director.demoReelActive
    ? director.selectedMotionId
    : (boundPose?.motionId ?? null);
  const effectiveExpressionId = director.demoReelActive
    ? director.selectedExpressionId
    : (boundPose?.expressionId ?? null);

  const stageBody = (
    <span
      className={`qj-l2d-aura-stage qj-l2d-stage-${stageVariant}`}
      style={{
        width: stageWidth,
        height: stageHeight,
        ["--portal-accent" as string]: presetMeta.accentHex,
        ["--portal-rim" as string]: presetMeta.glowHex,
      }}
      data-burst={burstNonce}
      data-bound-expression={effectiveExpressionId ?? undefined}
      data-bound-motion={effectiveMotionId ?? undefined}
    >
      <Live2DViewport
        preset={preset}
        customModelSource={director.customModelSource}
        customModelUrl={customPhotoUrl}
        expression={expression}
        action={action}
        activeMotionId={effectiveMotionId}
        motionNonce={director.motionNonce + burstNonce}
        activeExpressionId={effectiveExpressionId}
        expressionNonce={director.expressionNonce + burstNonce}
        showcaseStepIndex={director.demoReelActive ? director.demoReelStepIndex : null}
        showcaseStepNonce={director.motionNonce}
        isStreaming={isStreaming}
        voiceActive={voiceActive}
        speechText={speechText}
        stageVariant={stageVariant}
        framingMode={framingMode}
        width={stageWidth}
        height={stageHeight}
        backdropTheme={director.backdropTheme}
        parallaxStrength={director.parallaxStrength}
        headTrackingEnabled={director.headTrackingEnabled}
        interactive={interactive}
        onCatalogReady={reportLive2DCatalog}
        onMotionChange={reportLive2DMotion}
        onExpressionChange={reportLive2DExpression}
        onHitZone={(zone, motion, _exp, combo) => {
          zoneHandledClickRef.current = true;
          recordLive2DHitBanner(zone, motion, combo);
          onPoke?.();
        }}
        onHeadTrackingStatusChange={reportLive2DHeadTrackingStatus}
      />
    </span>
  );

  if (interactive) {
    return (
      <button
        type="button"
        className={`qj-char-rig interactive ${className}`.trim()}
        data-character-preset={preset}
        data-expression={expression}
        data-action={action}
        data-task-phase={taskPhase}
        aria-label={`千机：${EXPRESSION_LABELS[expression]} · ${ACTION_LABELS[action]}，点击互动`}
        title="点击与千机协作互动"
        onClick={() => {
          if (zoneHandledClickRef.current) {
            zoneHandledClickRef.current = false;
            return;
          }
          onPoke?.();
        }}
      >
        {stageBody}
      </button>
    );
  }

  return (
    <span
      className={`qj-char-rig ${className}`.trim()}
      data-character-preset={preset}
      data-expression={expression}
      data-action={action}
      data-task-phase={taskPhase}
    >
      {stageBody}
    </span>
  );
}
