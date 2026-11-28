/**
 * External reactive director store (`useSyncExternalStore`) for Qianji's
 * 4K Live2D (Cubism 4) Task-Interactive Co-Pilot & Workshop.
 */
import { useSyncExternalStore } from "react";
import {
  mapPhaseToRehearsableStage,
  REHEARSABLE_STAGE_BY_ID,
  type CompanionTaskPhaseId,
  type RehearsableTaskStageId,
} from "./botTaskChoreographer";
import {
  DEMO_SHOWCASE_STEPS,
  pickExpressionByHint,
  pickMotionByCategory,
  resolveLive2DPresenceState,
  type Live2DCatalogBundle,
} from "./live2dCatalog";
import { registerZipLive2DPackage, revokeZipLive2DPackage } from "./live2dLoader";
import type {
  HeadTrackingStatus,
  Live2DBackdropThemeId,
  Live2DExpressionItem,
  Live2DFramingMode,
  Live2DHitZone,
  Live2DMotionItem,
} from "./types";

export interface TaskStagePoseBinding {
  readonly expressionId: string | null;
  readonly motionId: string | null;
}
export type TaskStageBindingMap = Readonly<Partial<Record<RehearsableTaskStageId, TaskStagePoseBinding>>>;
export interface Live2DHitBanner {
  readonly zone: Live2DHitZone;
  readonly labelZh: string;
  readonly speechZh: string;
  readonly combo: number;
  readonly nonce: number;
}

export interface Live2DDirectorState {
  readonly showcaseOpen: boolean;
  readonly framingMode: Live2DFramingMode;
  readonly backdropTheme: Live2DBackdropThemeId;
  readonly parallaxStrength: number;
  readonly headTrackingEnabled: boolean;
  readonly headTrackingStatus: HeadTrackingStatus;
  readonly availableMotions: readonly Live2DMotionItem[];
  readonly availableExpressions: readonly Live2DExpressionItem[];
  readonly selectedMotionId: string | null;
  readonly liveMotion: Live2DMotionItem | null;
  readonly motionNonce: number;
  readonly selectedExpressionId: string | null;
  readonly liveExpression: Live2DExpressionItem | null;
  readonly expressionNonce: number;
  readonly rehearsingTaskStageId: RehearsableTaskStageId | null;
  readonly taskStageBindings: TaskStageBindingMap;
  readonly demoReelActive: boolean;
  readonly demoReelStepIndex: number;
  readonly demoReelCaption: string | null;
  readonly customModelSource: string | null;
  readonly customModelFileName: string | null;
  readonly importError: string | null;
  readonly lastHitBanner: Live2DHitBanner | null;
}

const TASK_BINDINGS_STORAGE_KEY = "qianji.bot.live2dTaskBindings.v1";

function readPersistedTaskBindings(): TaskStageBindingMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(TASK_BINDINGS_STORAGE_KEY);
    if (raw === null || raw.trim() === "") return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return {};
    const next: Partial<Record<RehearsableTaskStageId, TaskStagePoseBinding>> = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (!REHEARSABLE_STAGE_BY_ID.has(key as RehearsableTaskStageId) || typeof val !== "object" || val === null) {
        continue;
      }
      const rec = val as Record<string, unknown>;
      const expressionId = typeof rec.expressionId === "string" ? rec.expressionId : null;
      const motionId = typeof rec.motionId === "string" ? rec.motionId : null;
      if (expressionId !== null || motionId !== null) {
        next[key as RehearsableTaskStageId] = { expressionId, motionId };
      }
    }
    return next;
  } catch {
    return {};
  }
}

function persistTaskBindings(bindings: TaskStageBindingMap): void {
  if (typeof window === "undefined") return;
  try {
    if (Object.keys(bindings).length === 0) {
      window.localStorage.removeItem(TASK_BINDINGS_STORAGE_KEY);
    } else {
      window.localStorage.setItem(TASK_BINDINGS_STORAGE_KEY, JSON.stringify(bindings));
    }
  } catch {
    // Ignore restricted storage errors.
  }
}

export const INITIAL_LIVE2D_DIRECTOR_STATE: Live2DDirectorState = {
  showcaseOpen: false, framingMode: "half-body", backdropTheme: "atelier-aurora",
  parallaxStrength: 1.0, headTrackingEnabled: false, headTrackingStatus: "off",
  availableMotions: [], availableExpressions: [], selectedMotionId: null, liveMotion: null,
  motionNonce: 0, selectedExpressionId: null, liveExpression: null, expressionNonce: 0,
  rehearsingTaskStageId: null, taskStageBindings: {}, demoReelActive: false, demoReelStepIndex: 0,
  demoReelCaption: null, customModelSource: null, customModelFileName: null,
  importError: null, lastHitBanner: null,
};

type Listener = () => void;

let directorState: Live2DDirectorState = {
  ...INITIAL_LIVE2D_DIRECTOR_STATE,
  taskStageBindings: readPersistedTaskBindings(),
};
const listeners = new Set<Listener>();
let demoReelTimer: ReturnType<typeof setTimeout> | null = null;
let hitBannerTimer: ReturnType<typeof setTimeout> | null = null;
let hitBannerNonceCounter = 0;

function emitChange(): void {
  for (const listener of listeners) listener();
}

function setDirectorState(
  updater: Live2DDirectorState | ((prev: Live2DDirectorState) => Live2DDirectorState),
): void {
  const next = typeof updater === "function" ? updater(directorState) : updater;
  if (next === directorState) return;
  directorState = next;
  emitChange();
}

function subscribeDirector(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function getLive2DDirectorSnapshot(): Live2DDirectorState { return directorState; }
export function useLive2DDirectorState(): Live2DDirectorState {
  return useSyncExternalStore(subscribeDirector, getLive2DDirectorSnapshot, getLive2DDirectorSnapshot);
}
function clearDemoReelTimer(): void {
  if (demoReelTimer !== null) { clearTimeout(demoReelTimer); demoReelTimer = null; }
}
function clearHitBannerTimer(): void {
  if (hitBannerTimer !== null) { clearTimeout(hitBannerTimer); hitBannerTimer = null; }
}

function cleanupCustomModelSource(source: string | null): void {
  if (source === null) return;
  if (source.startsWith("zip:")) {
    revokeZipLive2DPackage(source);
    return;
  }
  if (source.startsWith("blob:") && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    try {
      URL.revokeObjectURL(source);
    } catch {
      // Ignore already-revoked URLs.
    }
  }
}

function scheduleDemoShowcaseStep(stepIndex: number): void {
  clearDemoReelTimer();
  const step = DEMO_SHOWCASE_STEPS[stepIndex];
  if (DEMO_SHOWCASE_STEPS.length === 0 || step === undefined) {
    setDirectorState((prev) => ({
      ...prev, demoReelActive: false, demoReelStepIndex: 0,
      demoReelCaption: null, selectedMotionId: null, motionNonce: prev.motionNonce + 1,
    }));
    return;
  }
  const expTarget = pickExpressionByHint(directorState.availableExpressions, step.expressionHint);
  const motionTarget = pickMotionByCategory(directorState.availableMotions, step.motionCategory, stepIndex);
  setDirectorState((prev) => ({
    ...prev, rehearsingTaskStageId: null, demoReelActive: true, demoReelStepIndex: stepIndex,
    demoReelCaption: step.captionZh,
    selectedExpressionId: expTarget?.id ?? prev.selectedExpressionId,
    expressionNonce: prev.expressionNonce + 1,
    selectedMotionId: motionTarget?.id ?? prev.selectedMotionId,
    motionNonce: prev.motionNonce + 1,
  }));
  if (typeof window !== "undefined") {
    demoReelTimer = setTimeout(
      () => scheduleDemoShowcaseStep(stepIndex + 1),
      Math.max(1500, Math.round(step.holdSec * 1000)),
    );
  }
}

export function startLive2DDemoReel(options?: { readonly openShowcase?: boolean }): void {
  if (options?.openShowcase === true) setDirectorState((prev) => ({ ...prev, showcaseOpen: true }));
  scheduleDemoShowcaseStep(0);
}

export function stopLive2DDemoReel(): void {
  clearDemoReelTimer();
  setDirectorState((prev) => ({
    ...prev, demoReelActive: false, demoReelStepIndex: 0,
    demoReelCaption: null, selectedMotionId: null, motionNonce: prev.motionNonce + 1,
  }));
}

export function toggleLive2DDemoReel(options?: { readonly openShowcase?: boolean }): void {
  if (directorState.demoReelActive) stopLive2DDemoReel();
  else startLive2DDemoReel(options);
}

export function openLive2DShowcase(options?: { readonly startDemoReel?: boolean }): void {
  setDirectorState((prev) => ({ ...prev, showcaseOpen: true, importError: null }));
  if (options?.startDemoReel === true) scheduleDemoShowcaseStep(0);
}

export function closeLive2DShowcase(): void {
  setDirectorState((prev) => ({
    ...prev, showcaseOpen: false, rehearsingTaskStageId: null, importError: null,
  }));
}

export function setLive2DFramingMode(framingMode: Live2DFramingMode): void {
  if (directorState.framingMode !== framingMode) setDirectorState((prev) => ({ ...prev, framingMode }));
}

export function setLive2DBackdropTheme(backdropTheme: Live2DBackdropThemeId): void {
  if (directorState.backdropTheme !== backdropTheme) setDirectorState((prev) => ({ ...prev, backdropTheme }));
}

export function setLive2DParallaxStrength(value: number): void {
  const clamped = Math.max(0, Math.min(1.5, Math.round(value * 100) / 100));
  if (directorState.parallaxStrength !== clamped) {
    setDirectorState((prev) => ({ ...prev, parallaxStrength: clamped }));
  }
}

export function setLive2DHeadTracking(enabled: boolean): void {
  setDirectorState((prev) => ({
    ...prev, headTrackingEnabled: enabled, headTrackingStatus: enabled ? "requesting" : "off",
  }));
}

export function reportLive2DHeadTrackingStatus(status: HeadTrackingStatus): void {
  if (directorState.headTrackingStatus !== status) {
    setDirectorState((prev) => ({ ...prev, headTrackingStatus: status }));
  }
}

export function reportLive2DCatalog(catalog: Live2DCatalogBundle): void {
  const sameMotions =
    directorState.availableMotions.length === catalog.motions.length &&
    directorState.availableMotions.every((m, idx) => m.id === catalog.motions[idx]?.id);
  const sameExps =
    directorState.availableExpressions.length === catalog.expressions.length &&
    directorState.availableExpressions.every((e, idx) => e.id === catalog.expressions[idx]?.id);
  if (sameMotions && sameExps) return;
  setDirectorState((prev) => ({
    ...prev, availableMotions: catalog.motions, availableExpressions: catalog.expressions,
  }));
}

export function selectLive2DMotion(motionId: string | null): void {
  clearDemoReelTimer();
  setDirectorState((prev) => ({
    ...prev, demoReelActive: false, demoReelCaption: null,
    selectedMotionId: motionId, motionNonce: prev.motionNonce + 1,
  }));
}

export function reportLive2DMotion(motion: Live2DMotionItem | null): void {
  if (directorState.liveMotion?.id !== motion?.id) setDirectorState((prev) => ({ ...prev, liveMotion: motion }));
}

export function selectLive2DExpression(expressionId: string | null): void {
  setDirectorState((prev) => ({
    ...prev, selectedExpressionId: expressionId, expressionNonce: prev.expressionNonce + 1,
  }));
}

export function reportLive2DExpression(expression: Live2DExpressionItem | null): void {
  if (directorState.liveExpression?.id !== expression?.id) {
    setDirectorState((prev) => ({ ...prev, liveExpression: expression }));
  }
}

function filterValidCatalogId<T extends { readonly id: string }>(
  id: string | null | undefined,
  items: readonly T[],
): string | null {
  if (id === null || id === undefined) return null;
  return items.length === 0 || items.some((item) => item.id === id) ? id : null;
}

export function rehearseLive2DTaskStage(stageId: RehearsableTaskStageId | null): void {
  clearDemoReelTimer();
  if (stageId === null) {
    setDirectorState((prev) => ({
      ...prev, rehearsingTaskStageId: null, demoReelActive: false,
      demoReelCaption: null, selectedMotionId: null, motionNonce: prev.motionNonce + 1,
    }));
    return;
  }
  const spec = REHEARSABLE_STAGE_BY_ID.get(stageId);
  if (spec === undefined) return;
  const bound = directorState.taskStageBindings[stageId];
  const catalog = { motions: directorState.availableMotions, expressions: directorState.availableExpressions };
  const fallback = resolveLive2DPresenceState(spec.defaultExpression, spec.defaultAction, catalog);
  const validExp = filterValidCatalogId(bound?.expressionId, catalog.expressions);
  const validMotion = filterValidCatalogId(bound?.motionId, catalog.motions);
  setDirectorState((prev) => ({
    ...prev, rehearsingTaskStageId: stageId, demoReelActive: false, demoReelCaption: null,
    selectedExpressionId: validExp ?? fallback.expressionItem?.id ?? prev.selectedExpressionId,
    expressionNonce: prev.expressionNonce + 1,
    selectedMotionId: validMotion ?? fallback.motionItem?.id ?? null,
    motionNonce: prev.motionNonce + 1,
  }));
}

export function bindCurrentPoseToTaskStage(
  stageId: RehearsableTaskStageId,
  explicit?: Partial<TaskStagePoseBinding>,
): void {
  const expressionId =
    explicit?.expressionId !== undefined
      ? explicit.expressionId
      : (directorState.selectedExpressionId ?? directorState.liveExpression?.id ?? null);
  const motionId =
    explicit?.motionId !== undefined
      ? explicit.motionId
      : (directorState.selectedMotionId ?? directorState.liveMotion?.id ?? null);
  const nextBindings: TaskStageBindingMap = {
    ...directorState.taskStageBindings,
    [stageId]: { expressionId, motionId },
  };
  persistTaskBindings(nextBindings);
  setDirectorState((prev) => ({ ...prev, taskStageBindings: nextBindings }));
}

export function clearTaskStageBinding(stageId: RehearsableTaskStageId): void {
  if (!(stageId in directorState.taskStageBindings)) return;
  const copy: Partial<Record<RehearsableTaskStageId, TaskStagePoseBinding>> = {
    ...directorState.taskStageBindings,
  };
  delete copy[stageId];
  persistTaskBindings(copy);
  setDirectorState((prev) => ({ ...prev, taskStageBindings: copy }));
}

export function resolveBoundTaskStagePose(
  phase: CompanionTaskPhaseId,
  state: Live2DDirectorState = directorState,
): TaskStagePoseBinding | null {
  const stageId = mapPhaseToRehearsableStage(phase);
  if (stageId === null) return null;
  const bound = state.taskStageBindings[stageId];
  if (bound === undefined) return null;
  const expressionId = filterValidCatalogId(bound.expressionId, state.availableExpressions);
  const motionId = filterValidCatalogId(bound.motionId, state.availableMotions);
  return expressionId === null && motionId === null ? null : { expressionId, motionId };
}

export async function importCustomLive2DPackage(file: File): Promise<string | null> {
  const lower = file.name.toLowerCase();
  try {
    if (lower.endsWith(".zip")) {
      const { customId, fileName } = await registerZipLive2DPackage(file);
      cleanupCustomModelSource(directorState.customModelSource);
      setDirectorState((prev) => ({
        ...prev, customModelSource: customId, customModelFileName: fileName,
        selectedMotionId: null, selectedExpressionId: null, importError: null,
        motionNonce: prev.motionNonce + 1,
      }));
      return customId;
    }
    if (lower.endsWith(".model3.json") || lower.endsWith(".json")) {
      const blobUrl = URL.createObjectURL(file);
      cleanupCustomModelSource(directorState.customModelSource);
      setDirectorState((prev) => ({
        ...prev, customModelSource: blobUrl, customModelFileName: file.name,
        selectedMotionId: null, selectedExpressionId: null, importError: null,
        motionNonce: prev.motionNonce + 1,
      }));
      return blobUrl;
    }
    setDirectorState((prev) => ({ ...prev, importError: "请选择包含 .model3.json 的 Live2D .zip 模型压缩包" }));
    return null;
  } catch (err) {
    setDirectorState((prev) => ({
      ...prev, importError: err instanceof Error ? err.message : "Live2D 模型包解析失败",
    }));
    return null;
  }
}

export function clearCustomLive2DPackage(): void {
  if (directorState.customModelSource === null && directorState.customModelFileName === null) return;
  cleanupCustomModelSource(directorState.customModelSource);
  setDirectorState((prev) => ({
    ...prev, customModelSource: null, customModelFileName: null,
    selectedMotionId: null, selectedExpressionId: null, importError: null,
  }));
}

const ZONE_REACTIONS: Readonly<Record<Live2DHitZone, { readonly labelZh: string; readonly speechZh: string }>> = {
  head: { labelZh: "轻触问候", speechZh: "收到信号，工作区状态正常，随时听候调遣。" },
  face: { labelZh: "视线聚焦", speechZh: "我在盯着当前任务进度呢，有新指令请直接交办。" },
  accessory: { labelZh: "信物唤醒", speechZh: "巡检与记忆链路均在线，需要现在核查待办吗？" },
  body: { labelZh: "即时响应", speechZh: "随时待命中，点快捷任务卡即可直接派发工作。" },
};

export function recordLive2DHitBanner(
  zone: Live2DHitZone,
  motion: Live2DMotionItem | null,
  combo: number,
): Live2DHitBanner {
  clearHitBannerTimer();
  hitBannerNonceCounter += 1;
  const base = ZONE_REACTIONS[zone];
  const banner: Live2DHitBanner = {
    zone, combo, nonce: hitBannerNonceCounter,
    labelZh: motion ? motion.labelZh : base.labelZh,
    speechZh: combo >= 3 ? "连续唤醒收到，优先任务随时交给我推进！" : base.speechZh,
  };
  setDirectorState((prev) => ({ ...prev, lastHitBanner: banner }));
  if (typeof window !== "undefined") {
    hitBannerTimer = setTimeout(() => {
      setDirectorState((prev) =>
        prev.lastHitBanner?.nonce === banner.nonce ? { ...prev, lastHitBanner: null } : prev,
      );
    }, 3200);
  }
  return banner;
}

export function resetLive2DDirectorStore(): void {
  clearDemoReelTimer();
  clearHitBannerTimer();
  cleanupCustomModelSource(directorState.customModelSource);
  persistTaskBindings({});
  directorState = INITIAL_LIVE2D_DIRECTOR_STATE;
  emitChange();
}
