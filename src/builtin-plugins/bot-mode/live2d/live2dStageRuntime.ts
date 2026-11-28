/**
 * Frameless 2x Supersampled PixiJS v7 Stage Runtime & Unclipped Framing Solver
 * (`src/builtin-plugins/bot-mode/live2d/live2dStageRuntime.ts`).
 *
 * - `bleedFactor = 1.0` across all variants (100% frameless transparent illustration).
 * - Shares a single lazy `PIXI.Renderer` across all active `<Live2DViewport>`
 *   instances so `CubismShader_WebGL` renders multiple simultaneous viewports
 *   with zero cross-context WebGL shader errors.
 * - Calibrates generous top & side margins (`14.5%` top margin on `Mao` so even
 *   her raised magic wand & pink heart in `魔法星心` stay 100% unclipped inside
 *   the canvas!).
 */
import { Live2DCompanionController, type Live2DTouchResult } from "./live2dController";
import type { LoadedLive2DInstance } from "./live2dLoader";
import { ensurePixiCspRuntime, PIXI } from "./pixiCspRuntime";
import type { Live2DFramingMode, Live2DPresetMeta } from "./types";

export type Live2DStageVariant = "companion" | "hero" | "showcase" | "card-preview";

export interface IntrinsicBounds {
  readonly top: number;
  readonly centerX: number;
  readonly width: number;
  readonly height: number;
}

export interface FramingTarget {
  readonly scale: number;
  readonly pivotX: number;
  readonly pivotY: number;
  readonly topCanvasY: number;
  readonly visibleHeightPx: number;
}

export interface GazeInputState {
  pointerX: number;
  pointerY: number;
  webcamX: number;
  webcamY: number;
  webcamActive: boolean;
}

export interface LiveStageConfig {
  readonly framingMode: Live2DFramingMode;
  readonly stageVariant: Live2DStageVariant;
  readonly parallaxStrength: number;
}

export interface Live2DStageRuntime {
  readonly getController: () => Live2DCompanionController | null;
  readonly mountLoadedModel: (
    loaded: LoadedLive2DInstance,
    nextCtrl: Live2DCompanionController,
  ) => void;
  readonly clearLoadedModel: () => void;
  readonly handleClientTap: (clientX: number, clientY: number) => Live2DTouchResult | null;
  readonly dispose: () => void;
}

interface VisibleArtCropRatio {
  readonly cx: number;
  readonly w: number;
  readonly top: number;
  readonly h: number;
}

const BUILTIN_VISIBLE_CROPS: Readonly<
  Record<Live2DPresetMeta["characterId"], VisibleArtCropRatio>
> = {
  mao: { cx: 0.435, w: 0.56, top: 0.085, h: 0.891 },
  hiyori: { cx: 0.508, w: 0.4, top: 0.074, h: 0.9 },
  rice: { cx: 0.658, w: 0.28, top: 0.139, h: 0.805 },
};

const CUSTOM_VISIBLE_CROP: VisibleArtCropRatio = {
  cx: 0.5,
  w: 0.65,
  top: 0.06,
  h: 0.9,
};

let sharedWebGLRenderer: PIXI.Renderer | null = null;
let cachedSoftwareWebGL: boolean | undefined;

const SOFTWARE_GL_RE = /SwiftShader|Basic Render Driver|Software|llvmpipe|Subzero|Warp/i;

export function isSoftwareWebGL(): boolean {
  if (cachedSoftwareWebGL !== undefined) return cachedSoftwareWebGL;
  if (typeof document === "undefined") {
    cachedSoftwareWebGL = true;
    return true;
  }
  try {
    const probeCanvas = document.createElement("canvas");
    probeCanvas.width = 1;
    probeCanvas.height = 1;
    const gl =
      probeCanvas.getContext("webgl2", { failIfMajorPerformanceCaveat: false }) ??
      probeCanvas.getContext("webgl", { failIfMajorPerformanceCaveat: false });
    if (gl === null) {
      cachedSoftwareWebGL = true;
      return true;
    }
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const unmasked = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? "") : "";
    const generic = String(gl.getParameter(gl.RENDERER) ?? "");
    const loseExt = gl.getExtension("WEBGL_lose_context");
    loseExt?.loseContext();
    cachedSoftwareWebGL = SOFTWARE_GL_RE.test(`${unmasked} ${generic}`);
    return cachedSoftwareWebGL;
  } catch {
    cachedSoftwareWebGL = true;
    return true;
  }
}

function getSharedWebGLRenderer(): PIXI.Renderer | null {
  if (sharedWebGLRenderer !== null) {
    if (!sharedWebGLRenderer.gl.isContextLost()) {
      return sharedWebGLRenderer;
    }
    sharedWebGLRenderer = null;
  }
  if (typeof document === "undefined") return null;
  ensurePixiCspRuntime();
  try {
    const renderer = new PIXI.Renderer({
      width: 800,
      height: 800,
      backgroundAlpha: 0,
      antialias: true,
      resolution: 1,
      clearBeforeRender: true,
      powerPreference: "high-performance",
    });
    const canvas = renderer.view as HTMLCanvasElement;
    canvas.addEventListener(
      "webglcontextlost",
      () => {
        if (sharedWebGLRenderer === renderer) {
          sharedWebGLRenderer = null;
        }
      },
      { once: true },
    );
    sharedWebGLRenderer = renderer;
    return sharedWebGLRenderer;
  } catch (err) {
    console.error("[Live2DStageRuntime] Failed to initialize WebGL renderer:", err);
    return null;
  }
}

export function clampUnit(v: number, min = -1, max = 1): number {
  return Math.max(min, Math.min(max, v));
}

export function resolveStageStyleMetrics(variant: Live2DStageVariant): {
  readonly bleedFactor: number;
  readonly borderRadiusPx: number;
} {
  if (variant === "card-preview") return { bleedFactor: 1, borderRadiusPx: 12 };
  if (variant === "companion") return { bleedFactor: 1, borderRadiusPx: 22 };
  if (variant === "hero") return { bleedFactor: 1, borderRadiusPx: 24 };
  return { bleedFactor: 1, borderRadiusPx: 0 };
}

export function measureModelIntrinsicBounds(loaded: LoadedLive2DInstance): IntrinsicBounds {
  const model = loaded.model;
  model.scale.set(1);
  model.pivot.set(0, 0);
  model.position.set(0, 0);
  const internalW = model.internalModel?.width || model.internalModel?.originalWidth || 2048;
  const internalH = model.internalModel?.height || model.internalModel?.originalHeight || 2800;
  const crop = loaded.isCustomPackage
    ? CUSTOM_VISIBLE_CROP
    : BUILTIN_VISIBLE_CROPS[loaded.presetMeta.characterId];

  try {
    const lb = model.getLocalBounds();
    if (Number.isFinite(lb.width) && Number.isFinite(lb.height) && lb.width > 8 && lb.height > 8) {
      return {
        top: lb.y + lb.height * crop.top,
        centerX: lb.x + lb.width * crop.cx,
        width: Math.max(8, lb.width * crop.w),
        height: Math.max(8, lb.height * crop.h),
      };
    }
  } catch {
    // Fallback to internal layout canvas dimensions if local bounds unavailable pre-draw.
  }
  return {
    top: internalH * crop.top,
    centerX: internalW * crop.cx,
    width: Math.max(8, internalW * crop.w),
    height: Math.max(8, internalH * crop.h),
  };
}

export function computeFramingTarget(params: {
  readonly bounds: IntrinsicBounds;
  readonly meta: Live2DPresetMeta;
  readonly framingMode: Live2DFramingMode;
  readonly stageVariant: Live2DStageVariant;
  readonly portalWidth: number;
  readonly portalHeight: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}): FramingTarget {
  const {
    bounds,
    meta,
    framingMode,
    stageVariant,
    canvasWidth,
    canvasHeight,
  } = params;
  const isCard = stageVariant === "card-preview";
  const isMao = meta.characterId === "mao";
  const centerY = canvasHeight * 0.5;
  const safeSideRatio = isMao ? 0.78 : meta.characterId === "rice" ? 0.8 : 0.84;
  const maxSafeWidthScale = (canvasWidth * safeSideRatio) / bounds.width;

  if (framingMode === "full-art") {
    const fit = Math.min((canvasWidth * 0.82) / bounds.width, (canvasHeight * 0.85) / bounds.height);
    const scale = fit * meta.framing.fullScaleMultiplier;
    const pivotY = bounds.top + bounds.height * 0.51;
    const topCanvasY = centerY - (pivotY - bounds.top) * scale;
    return { scale, pivotX: bounds.centerX, pivotY, topCanvasY, visibleHeightPx: bounds.height * scale };
  }

  if (framingMode === "bust-breakout") {
    // `特写近景` (Close-Up): chest/collarbone up to hat/ahoge tip cleanly inside [6.5%..100%] height
    const topMarginFrac = isCard ? 0.06 : isMao ? 0.13 : 0.07;
    const sliceFrac = isMao ? 0.52 : meta.characterId === "rice" ? 0.5 : 0.44;
    const rawScale = (canvasHeight * (1 - topMarginFrac)) / (bounds.height * sliceFrac);
    const scale = Math.min(rawScale, maxSafeWidthScale * 1.06);
    const topCanvasY = Math.round(canvasHeight * topMarginFrac);
    const pivotY = bounds.top + (centerY - topCanvasY) / scale;
    return { scale, pivotX: bounds.centerX, pivotY, topCanvasY, visibleHeightPx: canvasHeight - topCanvasY };
  }

  // `"half-body"` (`半身立绘`, default): mid-thigh/hips up to hat/crown tip inside [8.5%..100%] height
  const topMarginFrac = isCard ? 0.07 : isMao ? 0.145 : 0.085;
  const sliceFrac = isMao ? 0.69 : meta.characterId === "rice" ? 0.67 : 0.62;
  const rawScale = (canvasHeight * (1 - topMarginFrac)) / (bounds.height * sliceFrac);
  const scale = Math.min(rawScale, maxSafeWidthScale);
  const topCanvasY = Math.round(canvasHeight * topMarginFrac);
  const pivotY = bounds.top + (centerY - topCanvasY) / scale;
  return { scale, pivotX: bounds.centerX, pivotY, topCanvasY, visibleHeightPx: canvasHeight - topCanvasY };
}

export function createLive2DStageRuntime(params: {
  readonly hostEl: HTMLDivElement;
  readonly getRootEl: () => HTMLDivElement | null;
  readonly safeWidth: number;
  readonly safeHeight: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly stageVariant: Live2DStageVariant;
  readonly getLiveConfig: () => LiveStageConfig;
  readonly gazeInput: GazeInputState;
}): Live2DStageRuntime | null {
  const {
    hostEl,
    getRootEl,
    safeWidth,
    safeHeight,
    canvasWidth,
    canvasHeight,
    stageVariant,
    getLiveConfig,
    gazeInput,
  } = params;

  const renderer = getSharedWebGLRenderer();
  if (renderer === null || typeof document === "undefined") return null;

  const resolution =
    stageVariant === "card-preview"
      ? Math.min(Math.max(window.devicePixelRatio || 1, 1.5), 2)
      : Math.min(Math.max(window.devicePixelRatio || 1, 2), 2.5);

  const renderW = Math.max(64, Math.round(canvasWidth * resolution));
  const renderH = Math.max(64, Math.round(canvasHeight * resolution));

  const viewCanvas = document.createElement("canvas");
  viewCanvas.width = renderW;
  viewCanvas.height = renderH;
  viewCanvas.style.cssText = "width:100%;height:100%;display:block;pointer-events:none;";
  const ctx2d = viewCanvas.getContext("2d");
  if (ctx2d === null) return null;
  hostEl.replaceChildren(viewCanvas);

  const stage = new PIXI.Container();
  stage.scale.set(resolution);

  let activeLoaded: LoadedLive2DInstance | null = null;
  let activeCtrl: Live2DCompanionController | null = null;
  let activeBounds: IntrinsicBounds | null = null;
  let currentScale = 1;
  let currentPivotY = 0;
  let lastTopCanvasY = canvasHeight * 0.08;
  let lastVisibleHeightPx = canvasHeight * 0.92;

  const onWindowPointerMove = (ev: PointerEvent): void => {
    if (window.innerWidth <= 0 || window.innerHeight <= 0) return;
    const rect = viewCanvas.getBoundingClientRect();
    const cx = rect.left + rect.width * 0.5;
    const cy = rect.top + rect.height * 0.5;
    gazeInput.pointerX = clampUnit((ev.clientX - cx) / Math.max(260, window.innerWidth * 0.42));
    gazeInput.pointerY = clampUnit(-((ev.clientY - cy) / Math.max(240, window.innerHeight * 0.42)));
  };
  if (stageVariant !== "card-preview") {
    window.addEventListener("pointermove", onWindowPointerMove, { passive: true });
  }

  let smoothPx = 0;
  let smoothPy = 0;
  const centerX = canvasWidth * 0.5;
  const centerY = canvasHeight * 0.5;

  const onTick = (): void => {
    const cfg = getLiveConfig();
    const rawNx = gazeInput.webcamActive ? gazeInput.webcamX : gazeInput.pointerX;
    const rawNy = gazeInput.webcamActive ? gazeInput.webcamY : gazeInput.pointerY;

    smoothPx += (rawNx * cfg.parallaxStrength - smoothPx) * 0.14;
    smoothPy += (rawNy * cfg.parallaxStrength - smoothPy) * 0.14;

    const rootEl = getRootEl();
    if (rootEl !== null) {
      rootEl.style.setProperty("--l2d-px", smoothPx.toFixed(4));
      rootEl.style.setProperty("--l2d-py", (-smoothPy).toFixed(4));
    }

    if (
      activeLoaded !== null &&
      activeCtrl !== null &&
      activeBounds !== null &&
      viewCanvas.isConnected &&
      (typeof document === "undefined" || !document.hidden) &&
      (rootEl === null || rootEl.closest('.app-shell:not([data-shell-mode="bot"])') === null)
    ) {
      activeCtrl.setLookAtTarget(rawNx, rawNy);
      const target = computeFramingTarget({
        bounds: activeBounds,
        meta: activeLoaded.presetMeta,
        framingMode: cfg.framingMode,
        stageVariant: cfg.stageVariant,
        portalWidth: safeWidth,
        portalHeight: safeHeight,
        canvasWidth,
        canvasHeight,
      });

      currentScale += (target.scale - currentScale) * 0.16;
      currentPivotY += (target.pivotY - currentPivotY) * 0.16;
      lastTopCanvasY = target.topCanvasY;
      lastVisibleHeightPx = target.visibleHeightPx;

      const m = activeLoaded.model;
      m.scale.set(currentScale);
      m.pivot.set(target.pivotX, currentPivotY);
      const fgShiftX = cfg.stageVariant === "card-preview" ? 0 : smoothPx * 5;
      const fgShiftY = cfg.stageVariant === "card-preview" ? 0 : -smoothPy * 3;
      m.position.set(centerX + fgShiftX, centerY + fgShiftY);

      if (renderer.width < renderW || renderer.height < renderH) {
        renderer.resize(Math.max(renderer.width, renderW), Math.max(renderer.height, renderH));
      }
      renderer.render(stage);
      ctx2d.clearRect(0, 0, renderW, renderH);
      ctx2d.drawImage(renderer.view as HTMLCanvasElement, 0, 0, renderW, renderH, 0, 0, renderW, renderH);
    }
  };

  PIXI.Ticker.shared.add(onTick);

  const clearLoadedModel = (): void => {
    activeCtrl?.dispose();
    activeCtrl = null;
    if (activeLoaded !== null) {
      stage.removeChild(activeLoaded.model);
      activeLoaded.dispose();
      activeLoaded = null;
    }
    activeBounds = null;
  };

  return {
    getController: () => activeCtrl,
    mountLoadedModel: (loaded, nextCtrl) => {
      const prevCtrl = activeCtrl;
      const prevLoaded = activeLoaded;
      if (prevLoaded !== null) stage.removeChild(prevLoaded.model);

      const bounds = measureModelIntrinsicBounds(loaded);
      const cfg = getLiveConfig();
      const initialTarget = computeFramingTarget({
        bounds,
        meta: loaded.presetMeta,
        framingMode: cfg.framingMode,
        stageVariant: cfg.stageVariant,
        portalWidth: safeWidth,
        portalHeight: safeHeight,
        canvasWidth,
        canvasHeight,
      });

      activeBounds = bounds;
      currentScale = initialTarget.scale;
      currentPivotY = initialTarget.pivotY;
      lastTopCanvasY = initialTarget.topCanvasY;
      lastVisibleHeightPx = initialTarget.visibleHeightPx;

      loaded.model.scale.set(initialTarget.scale);
      loaded.model.pivot.set(initialTarget.pivotX, initialTarget.pivotY);
      loaded.model.position.set(centerX, centerY);
      stage.addChild(loaded.model);

      activeLoaded = loaded;
      activeCtrl = nextCtrl;
      prevCtrl?.dispose();
      prevLoaded?.dispose();
    },
    clearLoadedModel,
    handleClientTap: (clientX, clientY) => {
      if (activeCtrl === null) return null;
      const cRect = viewCanvas.getBoundingClientRect();
      if (cRect.width <= 0 || cRect.height <= 0) return null;
      const canvasX = ((clientX - cRect.left) / cRect.width) * canvasWidth;
      const canvasY = ((clientY - cRect.top) / cRect.height) * canvasHeight;
      const normY = clampUnit((canvasY - lastTopCanvasY) / Math.max(40, lastVisibleHeightPx), 0, 1);
      const normX = clampUnit((canvasX - centerX) / Math.max(40, safeWidth * 0.5), -1, 1);
      return activeCtrl.handlePointerTap({
        canvasX: canvasX * resolution,
        canvasY: canvasY * resolution,
        normX,
        normY,
      });
    },
    dispose: () => {
      window.removeEventListener("pointermove", onWindowPointerMove);
      PIXI.Ticker.shared.remove(onTick);
      clearLoadedModel();
      stage.destroy({ children: false });
      hostEl.replaceChildren();
    },
  };
}
