/**
 * Frameless 4K Live2D Transparent Portrait & Exhibition Viewport (`Live2DViewport.tsx`).
 *
 * Benchmarked against Blue Archive Lobby + Reverse: 1999 Exhibition + Project AIRI:
 * - Zero rectangular boxes, borders, or hard thigh chops.
 * - Whisper-soft `AmbientCharacterAura` + delicate `drop-shadow` + silky bottom waist
 *   feather mask (`linear-gradient(to bottom, #000 0%, #000 76%, transparent 100%)`)
 *   in `"half-body"` (default) and `"bust-breakout"` (`特写近景`) modes, or grounded
 *   elliptical floor contact shadow in `"full-art"` (`全身立绘`) mode.
 */
import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import type { BotAvatarPresetId } from "@qianji/protocol";
import type { BotActionId, BotExpressionId } from "../botUiAtoms";
import { Live2DCompanionController } from "./live2dController";
import { loadLive2DModelInstance } from "./live2dLoader";
import {
  clampUnit,
  createLive2DStageRuntime,
  type GazeInputState,
  type Live2DStageRuntime,
  type Live2DStageVariant,
} from "./live2dStageRuntime";
import { AmbientCharacterAura, prefersReducedMotion } from "./parallaxBackdrop";
import {
  resolveLive2DPresetMeta,
  type HeadTrackingStatus,
  type Live2DBackdropThemeId,
  type Live2DExpressionItem,
  type Live2DFramingMode,
  type Live2DHitZone,
  type Live2DMotionItem,
} from "./types";
import { startWebcamHeadTracker } from "./webcamTracker";

export type { Live2DStageVariant };

export interface Live2DViewportProps {
  readonly preset: BotAvatarPresetId;
  readonly customModelSource?: string | null;
  readonly customModelUrl?: string | null;
  readonly expression: BotExpressionId;
  readonly action: BotActionId;
  readonly activeMotionId?: string | null;
  readonly motionNonce?: number;
  readonly activeExpressionId?: string | null;
  readonly expressionNonce?: number;
  readonly showcaseStepIndex?: number | null;
  readonly showcaseStepNonce?: number;
  readonly isStreaming?: boolean;
  readonly voiceActive?: boolean;
  readonly speechText?: string | null;
  readonly stageVariant: Live2DStageVariant;
  readonly framingMode?: Live2DFramingMode;
  readonly width: number;
  readonly height: number;
  readonly backdropTheme?: Live2DBackdropThemeId;
  readonly parallaxStrength?: number;
  readonly headTrackingEnabled?: boolean;
  readonly interactive?: boolean;
  readonly onCatalogReady?: (catalog: {
    readonly motions: readonly Live2DMotionItem[];
    readonly expressions: readonly Live2DExpressionItem[];
  }) => void;
  readonly onMotionChange?: (motion: Live2DMotionItem | null) => void;
  readonly onExpressionChange?: (expression: Live2DExpressionItem | null) => void;
  readonly onHitZone?: (
    zone: Live2DHitZone,
    motion: Live2DMotionItem | null,
    expression: Live2DExpressionItem | null,
    combo: number,
  ) => void;
  readonly onHeadTrackingStatusChange?: (status: HeadTrackingStatus) => void;
  readonly className?: string;
}

const WAIST_FEATHER_MASK =
  "linear-gradient(to bottom, #000000 0%, #000000 76%, rgba(0, 0, 0, 0) 100%)";

export function Live2DViewport(props: Live2DViewportProps): ReactElement {
  const {
    preset,
    customModelSource = null,
    customModelUrl = null,
    expression,
    action,
    activeMotionId = null,
    motionNonce = 0,
    activeExpressionId = null,
    expressionNonce = 0,
    showcaseStepIndex = null,
    showcaseStepNonce = 0,
    isStreaming = false,
    voiceActive = false,
    speechText = null,
    stageVariant,
    framingMode = "half-body",
    width,
    height,
    backdropTheme,
    parallaxStrength = 1,
    headTrackingEnabled = false,
    interactive = true,
    onCatalogReady,
    onMotionChange,
    onExpressionChange,
    onHitZone,
    onHeadTrackingStatusChange,
    className = "",
  } = props;

  const safeWidth = Math.max(64, Math.round(width));
  const safeHeight = Math.max(64, Math.round(height));
  const presetMeta = resolveLive2DPresetMeta(preset);
  const effectiveBackdrop = backdropTheme ?? presetMeta.defaultBackdrop;
  const effectiveCustomSource = customModelSource ?? customModelUrl;
  const isCustomRasterImage =
    preset === "custom" &&
    typeof effectiveCustomSource === "string" &&
    /^data:image\//i.test(effectiveCustomSource.trim());

  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<Live2DStageRuntime | null>(null);
  const gazeInputRef = useRef<GazeInputState>({
    pointerX: 0,
    pointerY: 0,
    webcamX: 0,
    webcamY: 0,
    webcamActive: false,
  });

  const livePropsRef = useRef({
    framingMode,
    stageVariant,
    parallaxStrength,
    expression,
    action,
    isStreaming,
    voiceActive,
    speechText,
    activeMotionId,
    activeExpressionId,
    onCatalogReady,
    onMotionChange,
    onExpressionChange,
    onHitZone,
    onHeadTrackingStatusChange,
  });

  useEffect(() => {
    const effectiveParallax = prefersReducedMotion() ? 0 : parallaxStrength;
    livePropsRef.current = {
      framingMode,
      stageVariant,
      parallaxStrength: effectiveParallax,
      expression,
      action,
      isStreaming,
      voiceActive,
      speechText,
      activeMotionId,
      activeExpressionId,
      onCatalogReady,
      onMotionChange,
      onExpressionChange,
      onHitZone,
      onHeadTrackingStatusChange,
    };
  }, [
    framingMode,
    stageVariant,
    parallaxStrength,
    expression,
    action,
    isStreaming,
    voiceActive,
    speechText,
    activeMotionId,
    activeExpressionId,
    onCatalogReady,
    onMotionChange,
    onExpressionChange,
    onHitZone,
    onHeadTrackingStatusChange,
  ]);

  // 1. Mount Fresh `<canvas>` + Shared-WebGL 2x Supersampled Stage Runtime
  useEffect(() => {
    if (typeof window === "undefined" || isCustomRasterImage) return undefined;
    const hostEl = canvasHostRef.current;
    if (hostEl === null) return undefined;

    const runtime = createLive2DStageRuntime({
      hostEl,
      getRootEl: () => rootRef.current,
      safeWidth,
      safeHeight,
      canvasWidth: safeWidth,
      canvasHeight: safeHeight,
      stageVariant,
      getLiveConfig: () => livePropsRef.current,
      gazeInput: gazeInputRef.current,
    });
    runtimeRef.current = runtime;

    return () => {
      runtime?.dispose();
      runtimeRef.current = null;
    };
  }, [safeWidth, safeHeight, stageVariant, isCustomRasterImage]);

  // 2. Load / Hot-Swap 4K Built-In or `.zip` Custom Live2D Model
  useEffect(() => {
    const rt = runtimeRef.current;
    if (rt === null || isCustomRasterImage) return undefined;

    const abortController = new AbortController();
    void loadLive2DModelInstance({
      preset,
      customModelSource: effectiveCustomSource,
      signal: abortController.signal,
    })
      .then((loadedInstance) => {
        if (abortController.signal.aborted || runtimeRef.current !== rt) {
          loadedInstance.dispose();
          return;
        }
        const cur = livePropsRef.current;
        const nextCtrl = new Live2DCompanionController(loadedInstance);
        nextCtrl.setPresenceState({
          expression: cur.expression,
          action: cur.action,
          isStreaming: cur.isStreaming,
          voiceActive: cur.voiceActive,
          speechText: cur.speechText,
        });
        if (cur.activeExpressionId !== null && cur.activeExpressionId !== "") {
          void nextCtrl.setExpression(cur.activeExpressionId);
        }
        if (cur.activeMotionId !== null && cur.activeMotionId !== "") {
          void nextCtrl.playMotion(cur.activeMotionId);
        }
        rt.mountLoadedModel(loadedInstance, nextCtrl);
        cur.onCatalogReady?.(nextCtrl.getCatalog());
        cur.onMotionChange?.(nextCtrl.getActiveMotion());
        cur.onExpressionChange?.(nextCtrl.getActiveExpression());
      })
      .catch((err: unknown) => {
        if (abortController.signal.aborted || (err as { readonly name?: string })?.name === "AbortError") {
          return;
        }
        console.warn("[Live2DViewport] Failed to load Live2D model:", err);
      });

    return () => {
      abortController.abort();
    };
  }, [preset, effectiveCustomSource, isCustomRasterImage, safeWidth, safeHeight, stageVariant]);

  // 3. Sync Presence State -> Expressions & Streaming Lip-Sync
  useEffect(() => {
    runtimeRef.current?.getController()?.setPresenceState({
      expression,
      action,
      isStreaming,
      voiceActive,
      speechText,
    });
  }, [expression, action, isStreaming, voiceActive, speechText]);

  // 4. Sync Explicit Motion, Expression & Showcase Step
  useEffect(() => {
    const ctrl = runtimeRef.current?.getController();
    if (!ctrl || activeMotionId === null || activeMotionId === "") return;
    void ctrl.playMotion(activeMotionId).then((m) => livePropsRef.current.onMotionChange?.(m));
  }, [activeMotionId, motionNonce]);

  useEffect(() => {
    const ctrl = runtimeRef.current?.getController();
    if (!ctrl || activeExpressionId === null || activeExpressionId === "") return;
    void ctrl.setExpression(activeExpressionId).then((exp) => livePropsRef.current.onExpressionChange?.(exp));
  }, [activeExpressionId, expressionNonce]);

  useEffect(() => {
    const ctrl = runtimeRef.current?.getController();
    if (!ctrl || showcaseStepIndex === null) return;
    void ctrl.playShowcaseStep(showcaseStepIndex).then((res) => {
      if (res !== null) {
        livePropsRef.current.onMotionChange?.(res.motion);
        livePropsRef.current.onExpressionChange?.(res.expression);
      }
    });
  }, [showcaseStepIndex, showcaseStepNonce]);

  // 5. Opt-In Local 20fps Webcam Head Tracker
  useEffect(() => {
    const gazeState = gazeInputRef.current;
    if (!headTrackingEnabled) {
      gazeState.webcamActive = false;
      livePropsRef.current.onHeadTrackingStatusChange?.("off");
      return undefined;
    }

    const tracker = startWebcamHeadTracker({
      onHeadMove: (nx, ny) => {
        gazeState.webcamX = nx;
        gazeState.webcamY = ny;
      },
      onStatusChange: (status) => {
        gazeState.webcamActive = status === "active";
        livePropsRef.current.onHeadTrackingStatusChange?.(status);
      },
    });

    return () => {
      tracker.stop();
      gazeState.webcamActive = false;
    };
  }, [headTrackingEnabled]);

  const handleStagePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    gazeInputRef.current.pointerX = clampUnit(((event.clientX - rect.left) / rect.width) * 2 - 1);
    gazeInputRef.current.pointerY = clampUnit(-(((event.clientY - rect.top) / rect.height) * 2 - 1));
  };

  const handleInteractiveClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const res = runtimeRef.current?.handleClientTap(event.clientX, event.clientY) ?? null;
    if (res === null) {
      livePropsRef.current.onHitZone?.("head", null, null, 1);
      return;
    }
    livePropsRef.current.onMotionChange?.(res.motion);
    livePropsRef.current.onExpressionChange?.(res.expression);
    livePropsRef.current.onHitZone?.(res.zone, res.motion, res.expression, res.combo);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const res = runtimeRef.current?.getController()?.triggerHitZone("head");
      if (res !== undefined) {
        livePropsRef.current.onHitZone?.(res.zone, res.motion, res.expression, res.combo);
      }
    }
  };

  const isCardPreview = stageVariant === "card-preview";
  const applyWaistFeather = framingMode !== "full-art";

  return (
    <div
      ref={rootRef}
      className={`qj-l2d-viewport qj-l2d-${stageVariant}${className ? ` ${className}` : ""}`}
      data-testid={`live2d-viewport-${stageVariant}`}
      data-stage-variant={stageVariant}
      data-framing={framingMode}
      data-preset={preset}
      data-backdrop={effectiveBackdrop}
      data-expression={expression}
      data-action={action}
      style={{
        position: "relative",
        width: safeWidth,
        height: safeHeight,
        display: "inline-block",
        overflow: "visible",
        userSelect: "none",
      }}
    >
      <AmbientCharacterAura
        accentHex={presetMeta.accentHex}
        glowHex={presetMeta.glowHex}
        showFloorShadow={framingMode === "full-art"}
        isCardPreview={isCardPreview}
      />

      <div
        className="qj-l2d-character-layer"
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 6,
          pointerEvents: "none",
          maskImage: applyWaistFeather ? WAIST_FEATHER_MASK : undefined,
          WebkitMaskImage: applyWaistFeather ? WAIST_FEATHER_MASK : undefined,
        }}
      >
        {isCustomRasterImage && effectiveCustomSource !== null ? (
          <img
            src={effectiveCustomSource}
            alt={presetMeta.nameZh}
            draggable={false}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              objectPosition: "bottom center",
            }}
          />
        ) : (
          <div
            ref={canvasHostRef}
            className="qj-l2d-canvas-host"
            style={{
              position: "absolute",
              inset: 0,
              width: safeWidth,
              height: safeHeight,
              pointerEvents: "none",
            }}
          />
        )}
      </div>

      {interactive && (
        <div
          className="qj-l2d-hit-stage"
          role="button"
          tabIndex={0}
          aria-label={`${presetMeta.nameZh} Live2D 角色立绘，点击互动`}
          onPointerMove={handleStagePointerMove}
          onPointerLeave={() => {
            gazeInputRef.current.pointerX = 0;
            gazeInputRef.current.pointerY = 0;
          }}
          onClick={handleInteractiveClick}
          onKeyDown={handleKeyDown}
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 10,
            cursor: "pointer",
            background: "transparent",
          }}
        />
      )}
    </div>
  );
}
