/**
 * Pure state-driven presence resolution, task check-in reactions, Hero hover
 * preview state, and pointer gaze math for Qianji's Live2D Co-Pilot (`botCharacterState.ts`).
 */
import type { PointerEvent } from "react";
import type { BotSnapshotResult } from "@qianji/protocol";
import {
  patchBotUi,
  type BotActionId,
  type BotExpressionId,
  type BotUiState,
} from "./botUiAtoms";
import {
  getHoveredHeroTaskPreview,
  hoveredHeroTaskStore,
  setHoveredHeroTaskPreview,
  useHoveredHeroTaskPreview,
  type HoveredHeroTaskPreview,
} from "./live2d/botTaskChoreographer";

export {
  getHoveredHeroTaskPreview,
  hoveredHeroTaskStore,
  setHoveredHeroTaskPreview,
  useHoveredHeroTaskPreview,
  type HoveredHeroTaskPreview,
};

export const EXPRESSION_LABELS: Readonly<Record<BotExpressionId, string>> = {
  calm: "恬静",
  happy: "开心",
  focused: "专注",
  patrol: "巡检",
  curious: "好奇",
  sleepy: "小憩",
};

export const ACTION_LABELS: Readonly<Record<BotActionId, string>> = {
  idle: "守候",
  wave: "招呼",
  nod: "倾听",
  think: "思考",
  scan: "巡检",
  celebrate: "欢欣",
};

let lastPokeTs = 0;
let recentPokeCombo = 0;

export function triggerCharacterPoke(currentNonce: number): void {
  const now = Date.now();
  recentPokeCombo = now - lastPokeTs < 4000 ? recentPokeCombo + 1 : 1;
  lastPokeTs = now;
  const isCombo = recentPokeCombo >= 3;
  patchBotUi({
    characterMoodMode: "manual",
    characterExpression: "happy",
    characterAction: isCombo ? "celebrate" : "wave",
    characterSpeech: null,
    characterBurstNonce: currentNonce + 1,
  });
}

function pickIdleLookSpeech(): string {
  const hour = new Date().getHours();
  if (hour < 11) return "早间工作区已就绪，要先梳理今日重点推进目标吗？";
  if (hour < 14) return "午间持续值守中，有阶段性检查随时交办给我";
  if (hour < 19) return "下午推进顺利吗？我正替你留意工作区与收件箱动态";
  return "晚间值守在线，需要做一次提交前体检或收尾汇总吗？";
}

export function resolveCharacterPresence(params: {
  readonly ui: BotUiState;
  readonly snapshot: BotSnapshotResult;
  readonly isStreaming?: boolean;
  readonly justReplied?: boolean;
  readonly idleLookAround?: boolean;
  readonly hoveringStage?: boolean;
}): {
  readonly expression: BotExpressionId;
  readonly action: BotActionId;
  readonly speechText: string;
} {
  const {
    ui,
    snapshot,
    isStreaming = false,
    justReplied = false,
    idleLookAround = false,
    hoveringStage = false,
  } = params;
  const hoveredPreview = hoveredHeroTaskStore.get();
  if (hoveredPreview !== null) {
    return {
      expression: hoveredPreview.expression,
      action: hoveredPreview.action,
      speechText: hoveredPreview.speechText,
    };
  }
  if (ui.characterMoodMode === "manual") {
    return {
      expression: ui.characterExpression || "happy",
      action: ui.characterAction || "wave",
      speechText:
        ui.characterSpeech ??
        "工作区状态正常，需要我现在跑一次主动巡检，还是梳理今日目标？",
    };
  }
  if (isStreaming) {
    return { expression: "focused", action: "think", speechText: "正在核查上下文并推进任务…" };
  }
  if (justReplied) {
    return { expression: "happy", action: "wave", speechText: "已经整理完结果，要继续推进下一步目标吗？" };
  }
  if (ui.voiceCallActive) {
    return { expression: "happy", action: "wave", speechText: "语音连线倾听中，请直接交办任务" };
  }
  if (ui.serverBusy) {
    return { expression: "patrol", action: "scan", speechText: "正在主动扫描工作区变更与环境健康…" };
  }
  if (snapshot.pendingApprovals.length > 0) {
    return {
      expression: "happy",
      action: "wave",
      speechText: `有 ${snapshot.pendingApprovals.length} 项敏感操作待你批准确认`,
    };
  }
  if (ui.composerDraft.trim().length > 0) {
    return { expression: "curious", action: "nod", speechText: "正在倾听你的任务描述，发送后我立即跟进" };
  }
  if (snapshot.virtualServer.lifecycle === "sleeping") {
    return { expression: "sleepy", action: "idle", speechText: "隔离容器处于节能浅眠，发消息即可唤醒" };
  }
  if (hoveringStage) {
    return {
      expression: "curious",
      action: "nod",
      speechText: "点我可以快捷发起工作区巡检，或者梳理今日重点目标",
    };
  }
  if (idleLookAround) {
    return { expression: "curious", action: "nod", speechText: pickIdleLookSpeech() };
  }
  return {
    expression: "calm",
    action: "idle",
    speechText: snapshot.pacing.heartbeatEnabled
      ? `工作区盯守中 · 每 ${snapshot.pacing.heartbeatIntervalMinutes}m 自动巡检`
      : "工作区待命守候中，随时准备执行任务",
  };
}

let pendingGazeRaf: number | null = null;

export function applyStageGazeMove(clientX: number, clientY: number, stageEl: HTMLElement): void {
  if (typeof window === "undefined") return;
  const targets = stageEl.querySelectorAll<HTMLElement>(
    '[data-testid="bot-character-stage"], [data-testid="bot-hero-character"]',
  );
  if (targets.length === 0) return;
  if (pendingGazeRaf !== null) return;
  pendingGazeRaf = window.requestAnimationFrame(() => {
    pendingGazeRaf = null;
    targets.forEach((target) => {
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const cx = rect.left + rect.width * 0.5;
      const cy = rect.top + rect.height * 0.5;
      const nx = Math.max(-1, Math.min(1, (clientX - cx) / Math.max(window.innerWidth * 0.45, 320)));
      const ny = Math.max(-1, Math.min(1, (clientY - cy) / Math.max(window.innerHeight * 0.45, 280)));
      target.style.setProperty("--look-x", nx.toFixed(3));
      target.style.setProperty("--look-y", ny.toFixed(3));
    });
  });
}

export function applyGazePointerMove(event: PointerEvent<HTMLElement>): void {
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const nx = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1));
  const ny = Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height) * 2 - 1));
  event.currentTarget.style.setProperty("--look-x", nx.toFixed(3));
  event.currentTarget.style.setProperty("--look-y", ny.toFixed(3));
}

export function resetGazePointer(event: PointerEvent<HTMLElement>): void {
  event.currentTarget.style.setProperty("--look-x", "0");
  event.currentTarget.style.setProperty("--look-y", "0");
}
