/**
 * Live2D Cubism 4 Companion Runtime Controller (`live2dController.ts`).
 *
 * Drives smooth damped 2.5D cursor/webcam gaze & body follow (`focusController` +
 * `ParamAngleX/Y/Z`, `ParamBodyAngleX`, `ParamEyeBallX/Y`), streaming syllable &
 * 5-vowel (`ParamMouthOpenY` + `ParamA/I/U/E/O`) lip-sync via `beforeModelUpdate`,
 * and `HitArea` (`Head`/`Face`/`Body`) + normalized coordinate touch combo reactions.
 */
import type {
  Cubism4InternalModel,
  Live2DModel as Live2DModelType,
} from "pixi-live2d-display-lipsyncpatch/cubism4";
import type { BotActionId, BotExpressionId } from "../botUiAtoms";
import {
  DEMO_SHOWCASE_STEPS,
  introspectLive2DCatalog,
  pickExpressionByHint,
  pickMotionByCategory,
  resolveLive2DPresenceState,
  resolveTouchReactionTargets,
  type DemoShowcaseStep,
  type Live2DCatalogBundle,
} from "./live2dCatalog";
import type { LoadedLive2DInstance } from "./live2dLoader";
import type {
  Live2DExpressionItem,
  Live2DHitZone,
  Live2DMotionItem,
  Live2DPresetMeta,
} from "./types";

const MOTION_PRIORITY_IDLE = 1;
const MOTION_PRIORITY_NORMAL = 2;
const MOTION_PRIORITY_FORCE = 3;

export type Live2DVowelKey = "A" | "I" | "U" | "E" | "O";

export interface GazeDampingState {
  readonly nx: number;
  readonly ny: number;
  readonly angleX: number;
  readonly angleY: number;
  readonly angleZ: number;
  readonly bodyAngleX: number;
  readonly eyeBallX: number;
  readonly eyeBallY: number;
}

export interface LipSyncFrameSample {
  readonly mouthOpenY: number;
  readonly mouthForm: number;
  readonly vowel: Live2DVowelKey;
  readonly paramA: number;
  readonly paramI: number;
  readonly paramU: number;
  readonly paramE: number;
  readonly paramO: number;
}

export interface Live2DTouchResult {
  readonly zone: Live2DHitZone;
  readonly combo: number;
  readonly motion: Live2DMotionItem | null;
  readonly expression: Live2DExpressionItem | null;
}

interface CoreParameterWriter {
  addParameterValueById(parameterId: string, value: number, weight?: number): void;
  setParameterValueById(parameterId: string, value: number, weight?: number): void;
}

const VOWEL_CYCLE: readonly Live2DVowelKey[] = ["A", "I", "U", "E", "O"];

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

function dampFactor(rate: number, dtSec: number): number {
  const safeDt = Number.isFinite(dtSec) ? clamp(dtSec, 0.001, 0.08) : 0.016;
  return 1 - Math.exp(-rate * safeDt);
}

function resolveVowelForChar(ch: string, stepIndex: number): Live2DVowelKey {
  const lower = ch.toLowerCase();
  if (lower === "a" || lower === "á" || lower === "à") return "A";
  if (lower === "i" || lower === "y" || lower === "í") return "I";
  if (lower === "u" || lower === "w" || lower === "ú") return "U";
  if (lower === "e" || lower === "é" || lower === "è") return "E";
  if (lower === "o" || lower === "ó" || lower === "ò") return "O";
  const code = ch.charCodeAt(0);
  const idx = Number.isFinite(code) ? (code + stepIndex) % VOWEL_CYCLE.length : 0;
  return VOWEL_CYCLE[idx] ?? "A";
}

export function stepGazeDamping(
  current: Pick<GazeDampingState, "nx" | "ny">,
  targetNx: number,
  targetNy: number,
  dtSec: number,
): GazeDampingState {
  const goalX = Number.isFinite(targetNx) ? clamp(targetNx, -1, 1) : 0;
  const goalY = Number.isFinite(targetNy) ? clamp(targetNy, -1, 1) : 0;
  const k = dampFactor(10.5, dtSec);
  const nx = clamp(current.nx + (goalX - current.nx) * k, -1, 1);
  const ny = clamp(current.ny + (goalY - current.ny) * k, -1, 1);

  return {
    nx,
    ny,
    angleX: nx * 24,
    angleY: ny * 20,
    angleZ: -nx * ny * 10 + nx * 3.5,
    bodyAngleX: nx * 8.5,
    eyeBallX: clamp(nx * 0.85, -1, 1),
    eyeBallY: clamp(ny * 0.8, -1, 1),
  };
}

export function computeStreamingLipSyncFrame(params: {
  readonly clockSec: number;
  readonly speaking: boolean;
  readonly speechText?: string;
  readonly currentOpenY: number;
  readonly dtSec: number;
}): LipSyncFrameSample {
  const { clockSec, speaking, speechText = "", currentOpenY, dtSec } = params;
  let goalOpen = 0;
  let vowel: Live2DVowelKey = "A";

  if (speaking) {
    const syllableWave =
      0.5 +
      0.34 * Math.sin(clockSec * 14.2) +
      0.24 * Math.sin(clockSec * 6.3 + 0.85);
    const breathPause = Math.sin(clockSec * 2.4) > -0.8 ? 1 : 0.14;
    goalOpen = clamp(syllableWave * breathPause, 0.08, 0.86);

    const stepIdx = Math.max(0, Math.floor(clockSec * 7.5));
    const trimmed = speechText.trim();
    vowel = trimmed.length > 0
      ? resolveVowelForChar(trimmed.charAt(stepIdx % trimmed.length), stepIdx)
      : (VOWEL_CYCLE[stepIdx % VOWEL_CYCLE.length] ?? "A");
  }

  const rate = speaking ? 20 : 16;
  const mouthOpenY = clamp(currentOpenY + (goalOpen - currentOpenY) * dampFactor(rate, dtSec), 0, 1);
  const cleanOpen = mouthOpenY < 0.006 && !speaking ? 0 : mouthOpenY;
  const mouthForm = cleanOpen > 0.02
    ? vowel === "I" || vowel === "E"
      ? 0.36
      : vowel === "U" || vowel === "O"
        ? -0.28
        : 0.14
    : 0;

  return {
    mouthOpenY: cleanOpen,
    mouthForm,
    vowel,
    paramA: vowel === "A" ? cleanOpen : cleanOpen * 0.12,
    paramI: vowel === "I" ? cleanOpen * 0.9 : 0,
    paramU: vowel === "U" ? cleanOpen * 0.88 : 0,
    paramE: vowel === "E" ? cleanOpen * 0.9 : 0,
    paramO: vowel === "O" ? cleanOpen * 0.92 : 0,
  };
}

export function classifyHitZoneFromAreasAndNormY(
  hitAreaNames: readonly string[],
  normY: number,
  normX = 0,
): Live2DHitZone {
  for (const raw of hitAreaNames) {
    const lower = raw.toLowerCase();
    if (lower.includes("head") || lower.includes("hair") || lower.includes("hat")) return "head";
    if (lower.includes("face") || lower.includes("eye") || lower.includes("cheek")) return "face";
    if (lower.includes("wand") || lower.includes("orb") || lower.includes("staff") || lower.includes("acc")) {
      return "accessory";
    }
  }
  const clampedY = Number.isFinite(normY) ? clamp(normY, 0, 1) : 0.5;
  const clampedX = Number.isFinite(normX) ? clamp(normX, -1, 1) : 0;
  if (clampedY < 0.27) return "head";
  if (clampedY < 0.43 && Math.abs(clampedX) < 0.48) return "face";
  if (Math.abs(clampedX) > 0.56) return "accessory";
  return "body";
}

export class Live2DCompanionController {
  private readonly model: Live2DModelType<Cubism4InternalModel>;
  private readonly catalog: Live2DCatalogBundle;
  private activeMotion: Live2DMotionItem | null = null;
  private activeExpression: Live2DExpressionItem | null = null;
  private disposed = false;

  private targetLookNx = 0;
  private targetLookNy = 0;
  private gazeState: GazeDampingState = {
    nx: 0, ny: 0, angleX: 0, angleY: 0, angleZ: 0, bodyAngleX: 0, eyeBallX: 0, eyeBallY: 0,
  };
  private lastHookMs = 0;
  private saccadeX = 0;
  private saccadeY = 0;
  private saccadeTimerSec = 1.5;
  private prngSeed = 0x2026_0419;

  private presenceExpression: BotExpressionId = "calm";
  private presenceAction: BotActionId = "idle";
  private isStreaming = false;
  private voiceActive = false;
  private speechText = "";
  private lipClockSec = 0;
  private currentMouthOpenY = 0;

  private lastTouchMs = 0;
  private comboCount = 0;
  private touchLockSec = 0;
  private touchImpulseX = 0;
  private touchImpulseY = 0;
  private touchImpulseZ = 0;

  private readonly onBeforeModelUpdate = (): void => {
    if (this.disposed) return;
    const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    const dtSec = this.lastHookMs > 0 ? clamp((nowMs - this.lastHookMs) * 0.001, 0.001, 0.06) : 0.016;
    this.lastHookMs = nowMs;
    this.applyFrameParameters(dtSec);
  };

  public constructor(
    source:
      | LoadedLive2DInstance
      | {
          readonly model: Live2DModelType<Cubism4InternalModel>;
          readonly rawModelJson?: Record<string, unknown> | null;
          readonly presetMeta?: Live2DPresetMeta;
          readonly isCustomPackage?: boolean;
        },
  ) {
    this.model = source.model;
    this.catalog = introspectLive2DCatalog({
      settings: this.model.internalModel?.settings,
      rawModelJson: source.rawModelJson ?? null,
      characterId: source.presetMeta?.characterId ?? null,
      isCustomPackage: source.isCustomPackage === true,
    });
    const internal = this.model.internalModel as (Cubism4InternalModel & { on?: (ev: string, fn: () => void) => void }) | undefined;
    internal?.on?.("beforeModelUpdate", this.onBeforeModelUpdate);

    const idleItem = pickMotionByCategory(this.catalog.motions, "idle");
    if (idleItem !== null) {
      this.activeMotion = idleItem;
      void this.model.motion(idleItem.group, idleItem.index, MOTION_PRIORITY_IDLE).catch(() => false);
    }
    const calmExp = pickExpressionByHint(this.catalog.expressions, "calm");
    if (calmExp !== null) {
      this.activeExpression = calmExp;
      void this.model.expression(calmExp.name).catch(() => false);
    }
  }

  public getCatalog(): Live2DCatalogBundle { return this.catalog; }
  public getMotions(): readonly Live2DMotionItem[] { return this.catalog.motions; }
  public getExpressions(): readonly Live2DExpressionItem[] { return this.catalog.expressions; }
  public getActiveMotion(): Live2DMotionItem | null { return this.activeMotion; }
  public getActiveExpression(): Live2DExpressionItem | null { return this.activeExpression; }

  public async playMotion(motionIdOrGroup: string, explicitIndex?: number): Promise<Live2DMotionItem | null> {
    if (this.disposed) return null;
    const matched = explicitIndex !== undefined
      ? this.catalog.motions.find((m) => m.group === motionIdOrGroup && m.index === explicitIndex)
      : (this.catalog.motions.find((m) => m.id === motionIdOrGroup) ??
        this.catalog.motions.find((m) => m.group === motionIdOrGroup));

    const group = matched?.group ?? motionIdOrGroup;
    const index = matched?.index ?? explicitIndex ?? 0;
    const priority = matched?.category === "idle" ? MOTION_PRIORITY_NORMAL : MOTION_PRIORITY_FORCE;
    try {
      const ok = await this.model.motion(group, index, priority);
      if (ok && matched !== undefined) this.activeMotion = matched;
    } catch {
      return null;
    }
    return matched ?? null;
  }

  public async setExpression(expressionIdOrName: string | number): Promise<Live2DExpressionItem | null> {
    if (this.disposed) return null;
    const matched = typeof expressionIdOrName === "number"
      ? (this.catalog.expressions[expressionIdOrName] ?? null)
      : (this.catalog.expressions.find(
          (e) => e.id === expressionIdOrName || e.name === expressionIdOrName,
        ) ?? null);
    const targetArg = matched !== null ? matched.name : expressionIdOrName;
    try {
      const ok = await this.model.expression(targetArg);
      if (ok && matched !== null) this.activeExpression = matched;
    } catch {
      return null;
    }
    return matched;
  }

  public async playShowcaseStep(stepIndex: number): Promise<{
    readonly step: DemoShowcaseStep;
    readonly motion: Live2DMotionItem | null;
    readonly expression: Live2DExpressionItem | null;
  } | null> {
    if (this.disposed || DEMO_SHOWCASE_STEPS.length === 0) return null;
    const step = DEMO_SHOWCASE_STEPS[Math.abs(stepIndex) % DEMO_SHOWCASE_STEPS.length];
    if (step === undefined) return null;
    const expTarget = pickExpressionByHint(this.catalog.expressions, step.expressionHint);
    const motionTarget = pickMotionByCategory(this.catalog.motions, step.motionCategory, stepIndex);
    if (expTarget !== null) await this.setExpression(expTarget.id);
    if (motionTarget !== null) await this.playMotion(motionTarget.id);
    return { step, motion: motionTarget, expression: expTarget };
  }

  public setPresenceState(params: {
    readonly expression: BotExpressionId;
    readonly action: BotActionId;
    readonly isStreaming?: boolean;
    readonly voiceActive?: boolean;
    readonly speechText?: string | null;
  }): void {
    const prevExpr = this.presenceExpression;
    const prevAction = this.presenceAction;
    this.presenceExpression = params.expression;
    this.presenceAction = params.action;

    if (params.isStreaming !== undefined) this.isStreaming = params.isStreaming;
    if (params.voiceActive !== undefined) this.voiceActive = params.voiceActive;
    if (params.speechText !== undefined) {
      this.speechText = params.speechText?.trim() ?? "";
    }
    if (this.isStreaming) {
      this.touchLockSec = 0;
    }

    if (this.touchLockSec <= 0 && (params.expression !== prevExpr || params.action !== prevAction)) {
      const resolved = resolveLive2DPresenceState(params.expression, params.action, this.catalog);
      if (resolved.expressionItem !== null) {
        void this.setExpression(resolved.expressionItem.id);
      }
      if (resolved.shouldTriggerMotion && resolved.motionItem !== null) {
        void this.playMotion(resolved.motionItem.id);
      }
    }
  }

  public setPresenceTarget(params: {
    readonly expression: BotExpressionId; readonly action: BotActionId;
    readonly isStreaming?: boolean; readonly voiceActive?: boolean; readonly speechText?: string | null;
  }): void {
    this.setPresenceState(params);
  }

  public setLookAtTarget(nx: number, ny: number, stageWorldPoint?: { readonly x: number; readonly y: number }): void {
    this.targetLookNx = Number.isFinite(nx) ? clamp(nx, -1, 1) : 0;
    this.targetLookNy = Number.isFinite(ny) ? clamp(ny, -1, 1) : 0;
    if (stageWorldPoint !== undefined) {
      this.model.focus(stageWorldPoint.x, stageWorldPoint.y, false);
    } else {
      this.model.internalModel?.focusController?.focus(this.targetLookNx * 0.65, this.targetLookNy * 0.65, false);
    }
  }

  public handlePointerTap(params: {
    readonly canvasX: number; readonly canvasY: number;
    readonly normX: number; readonly normY: number; readonly comboCount?: number;
  }): Live2DTouchResult {
    let hitNames: string[];
    try {
      hitNames = this.model.hitTest(params.canvasX, params.canvasY);
    } catch {
      hitNames = [];
    }
    const zone = classifyHitZoneFromAreasAndNormY(hitNames, params.normY, params.normX);
    this.setLookAtTarget(params.normX * 0.65, clamp(0.45 - params.normY, -0.7, 0.7));
    this.touchImpulseX = clamp(params.normX * 7.5, -8, 8);
    return this.triggerHitZone(zone, params.comboCount);
  }

  public triggerHitZone(zone: Live2DHitZone, explicitCombo?: number): Live2DTouchResult {
    const now = Date.now();
    const combo = explicitCombo ?? (now - this.lastTouchMs < 3200 ? this.comboCount + 1 : 1);
    this.lastTouchMs = now;
    this.comboCount = combo;
    this.touchLockSec = 3.2;
    this.touchImpulseY = zone === "head" ? -7.5 : zone === "face" ? 4.5 : -3.2;
    this.touchImpulseZ = zone === "head" ? 6.5 : zone === "accessory" ? -7.0 : 4.0;
    const { expressionItem, motionItem } = resolveTouchReactionTargets(zone, combo, this.catalog);
    if (expressionItem !== null) void this.setExpression(expressionItem.id);
    if (motionItem !== null) void this.playMotion(motionItem.id);
    return { zone, combo, motion: motionItem, expression: expressionItem };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const internal = this.model.internalModel as (Cubism4InternalModel & { off?: (ev: string, fn: () => void) => void }) | undefined;
    internal?.off?.("beforeModelUpdate", this.onBeforeModelUpdate);
    try {
      this.model.stopSpeaking();
      this.model.stopMotions();
    } catch {
      // Safe teardown if Pixi WebGL context already closed.
    }
  }

  private nextRandom(): number {
    let x = this.prngSeed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.prngSeed = x >>> 0;
    return (this.prngSeed % 10000) / 10000;
  }

  private applyFrameParameters(dtSec: number): void {
    const core = this.model.internalModel?.coreModel as unknown as CoreParameterWriter | undefined;
    if (core === undefined) return;

    this.saccadeTimerSec -= dtSec;
    if (this.saccadeTimerSec <= 0) {
      this.saccadeX = (this.nextRandom() * 2 - 1) * 0.06;
      this.saccadeY = (this.nextRandom() * 2 - 1) * 0.045;
      this.saccadeTimerSec = 1.1 + this.nextRandom() * 2.2;
    }

    if (this.touchLockSec > 0) this.touchLockSec = Math.max(0, this.touchLockSec - dtSec);
    const impulseDecay = Math.exp(-8.5 * dtSec);
    this.touchImpulseX *= impulseDecay;
    this.touchImpulseY *= impulseDecay;
    this.touchImpulseZ *= impulseDecay;

    this.gazeState = stepGazeDamping(this.gazeState, this.targetLookNx, this.targetLookNy, dtSec);
    core.addParameterValueById("ParamAngleX", this.gazeState.angleX * 0.35 + this.touchImpulseX, 1);
    core.addParameterValueById("ParamAngleY", this.gazeState.angleY * 0.35 + this.touchImpulseY, 1);
    core.addParameterValueById("ParamAngleZ", this.gazeState.angleZ * 0.45 + this.touchImpulseZ, 1);
    core.addParameterValueById("ParamBodyAngleX", this.gazeState.bodyAngleX * 0.45 + this.touchImpulseX * 0.35, 1);
    core.addParameterValueById("ParamEyeBallX", this.gazeState.eyeBallX * 0.3 + this.saccadeX, 1);
    core.addParameterValueById("ParamEyeBallY", this.gazeState.eyeBallY * 0.3 + this.saccadeY, 1);

    const speaking = this.isStreaming || this.voiceActive;
    if (speaking) this.lipClockSec += dtSec;

    const lip = computeStreamingLipSyncFrame({
      clockSec: this.lipClockSec,
      speaking,
      speechText: this.speechText,
      currentOpenY: this.currentMouthOpenY,
      dtSec,
    });
    this.currentMouthOpenY = lip.mouthOpenY;

    if (speaking || lip.mouthOpenY > 0) {
      core.setParameterValueById("ParamMouthOpenY", lip.mouthOpenY, 0.92);
      core.addParameterValueById("ParamMouthForm", lip.mouthForm, 0.65);
      core.setParameterValueById("ParamA", lip.paramA, 0.92);
      core.setParameterValueById("ParamI", lip.paramI, 0.85);
      core.setParameterValueById("ParamU", lip.paramU, 0.85);
      core.setParameterValueById("ParamE", lip.paramE, 0.85);
      core.setParameterValueById("ParamO", lip.paramO, 0.85);
    }
  }
}
