/**
 * Comprehensive verification suite for Qianji's 4K Live2D (Cubism 4) Frameless
 * Co-Pilot Stage, Task Choreographer, Pose Bindings & Unified Workshop.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import JSZip from "jszip";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type {
  Cubism4InternalModel,
  Live2DModel as Live2DModelType,
} from "pixi-live2d-display-lipsyncpatch/cubism4";
import { BotChatHeroStage } from "../src/builtin-plugins/bot-mode/BotCharacterStage";
import { BotCompanionPanel } from "../src/builtin-plugins/bot-mode/BotCompanionPanel";
import { triggerCharacterPoke } from "../src/builtin-plugins/bot-mode/botCharacterState";
import {
  botDataStore, botUiStore, FALLBACK_BOT_SNAPSHOT, INITIAL_BOT_UI_STATE, patchBotUi,
} from "../src/builtin-plugins/bot-mode/botStore";
import {
  extractLiveSessionToolActivity,
  REHEARSABLE_TASK_STAGES,
  resolveTaskCompanionPresence,
  setHoveredHeroTaskPreview,
} from "../src/builtin-plugins/bot-mode/live2d/botTaskChoreographer";
import {
  DEMO_SHOWCASE_STEPS, introspectLive2DCatalog, pickExpressionByHint,
  pickMotionByCategory, resolveLive2DPresenceState, resolveTouchReactionTargets,
} from "../src/builtin-plugins/bot-mode/live2d/live2dCatalog";
import {
  classifyHitZoneFromAreasAndNormY, computeStreamingLipSyncFrame,
  Live2DCompanionController, stepGazeDamping,
} from "../src/builtin-plugins/bot-mode/live2d/live2dController";
import {
  bindCurrentPoseToTaskStage, clearTaskStageBinding, getLive2DDirectorSnapshot,
  openLive2DShowcase, rehearseLive2DTaskStage, resetLive2DDirectorStore, resolveBoundTaskStagePose,
} from "../src/builtin-plugins/bot-mode/live2d/live2dDirectorStore";
import {
  ensureCubismCoreLoaded, getRegisteredZipPackage,
  registerZipLive2DPackage, revokeZipLive2DPackage,
} from "../src/builtin-plugins/bot-mode/live2d/live2dLoader";
import { Live2DShowcaseModal } from "../src/builtin-plugins/bot-mode/live2d/Live2DShowcaseModal";
import { ensurePixiCspRuntime, PIXI } from "../src/builtin-plugins/bot-mode/live2d/pixiCspRuntime";
import { computeFramingTarget } from "../src/builtin-plugins/bot-mode/live2d/live2dStageRuntime";
import { LIVE2D_CORE_SCRIPT_URL, LIVE2D_PRESET_IDS, LIVE2D_PRESETS, resolveLive2DPresetMeta } from "../src/builtin-plugins/bot-mode/live2d/types";

const REPO_ROOT = resolve(__dirname, "..");
const PUBLIC_DIR = resolve(REPO_ROOT, "public");
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const PLUSHIE_SLOP_RE = /毛茸茸|耳朵都要被揉热|绒偶|玩偶/;

function loadModel3DiskJson(publicRelUrl: string): {
  readonly modelDir: string;
  readonly raw: Record<string, unknown>;
} {
  const fullPath = resolve(PUBLIC_DIR, publicRelUrl.replace(/^\//, ""));
  expect(existsSync(fullPath)).toBe(true);
  const raw = JSON.parse(readFileSync(fullPath, "utf8")) as Record<string, unknown>;
  return { modelDir: dirname(fullPath), raw };
}

function collectModel3ReferencedFiles(raw: Record<string, unknown>): string[] {
  const refs = raw.FileReferences as Record<string, unknown> | undefined;
  if (refs === undefined || typeof refs !== "object" || refs === null) return [];
  const files: string[] = [];
  for (const key of ["Moc", "Physics", "Pose", "DisplayInfo", "UserData"]) {
    const val = refs[key];
    if (typeof val === "string" && val.length > 0) files.push(val);
  }
  if (Array.isArray(refs.Textures)) {
    for (const tex of refs.Textures) if (typeof tex === "string" && tex.length > 0) files.push(tex);
  }
  if (Array.isArray(refs.Expressions)) {
    for (const exp of refs.Expressions) {
      const f = (exp as { File?: unknown } | null)?.File;
      if (typeof f === "string" && f.length > 0) files.push(f);
    }
  }
  const motions = refs.Motions as Record<string, unknown> | undefined;
  if (motions !== undefined && typeof motions === "object" && motions !== null) {
    for (const groupList of Object.values(motions)) {
      if (!Array.isArray(groupList)) continue;
      for (const item of groupList) {
        const rec = item as { File?: unknown; Sound?: unknown } | null;
        if (typeof rec?.File === "string" && rec.File.length > 0) files.push(rec.File);
        if (typeof rec?.Sound === "string" && rec.Sound.length > 0) files.push(rec.Sound);
      }
    }
  }
  return files;
}

describe("4K Live2D (Cubism 4) Task-Interactive Co-Pilot & Frameless Workshop", () => {
  afterEach(() => {
    setHoveredHeroTaskPreview(null);
    resetLive2DDirectorStore();
    botUiStore.set(INITIAL_BOT_UI_STATE);
    botDataStore.set(FALLBACK_BOT_SNAPSHOT);
  });

  it("removes legacy Three.js/VRM files and bundles valid Cubism 4 Core + 3 4K Live2D models", () => {
    expect(existsSync(resolve(REPO_ROOT, "src/builtin-plugins/bot-mode/character3d"))).toBe(false);
    expect(existsSync(resolve(PUBLIC_DIR, "bot-models"))).toBe(false);

    expect(LIVE2D_CORE_SCRIPT_URL).toBe("/live2d/live2dcubismcore.min.js");
    const coreScriptPath = resolve(PUBLIC_DIR, "live2d/live2dcubismcore.min.js");
    expect(existsSync(coreScriptPath)).toBe(true);
    const coreSource = readFileSync(coreScriptPath, "utf8");
    expect(coreSource.length).toBeGreaterThan(100_000);
    expect(coreSource).toContain("Live2DCubismCore");

    expect(LIVE2D_PRESET_IDS).toEqual(["alabaster-felt", "warm-felt", "plush-ears"]);
    expect(LIVE2D_PRESETS["alabaster-felt"].characterId).toBe("mao");
    expect(LIVE2D_PRESETS["warm-felt"].characterId).toBe("hiyori");
    expect(LIVE2D_PRESETS["plush-ears"].characterId).toBe("rice");
    expect(resolveLive2DPresetMeta("custom").id).toBe("alabaster-felt");

    for (const id of LIVE2D_PRESET_IDS) {
      const meta = LIVE2D_PRESETS[id];
      const { modelDir, raw } = loadModel3DiskJson(meta.modelJsonUrl);
      const refFiles = collectModel3ReferencedFiles(raw);
      expect(refFiles.length).toBeGreaterThanOrEqual(12);
      for (const relPath of refFiles) {
        const diskFile = resolve(modelDir, relPath);
        expect(existsSync(diskFile), `Missing Live2D asset ${relPath} in ${meta.characterId}`).toBe(true);
        expect(statSync(diskFile).size).toBeGreaterThan(0);
      }
    }
  });

  it("maps Mao, Hiyori, Rice, and custom .zip catalogs to clean Chinese labels & showcase steps", () => {
    const maoJson = loadModel3DiskJson(LIVE2D_PRESETS["alabaster-felt"].modelJsonUrl).raw;
    const hiyoriJson = loadModel3DiskJson(LIVE2D_PRESETS["warm-felt"].modelJsonUrl).raw;
    const riceJson = loadModel3DiskJson(LIVE2D_PRESETS["plush-ears"].modelJsonUrl).raw;

    const maoCat = introspectLive2DCatalog({ rawModelJson: maoJson, characterId: "mao" });
    expect(maoCat.motions).toHaveLength(8);
    expect(maoCat.expressions).toHaveLength(8);
    expect(maoCat.motions.some((m) => m.labelZh === "虹光挥杖")).toBe(true);
    expect(maoCat.expressions.some((e) => e.labelZh === "害羞脸红")).toBe(true);

    const hiyoriCat = introspectLive2DCatalog({ rawModelJson: hiyoriJson, characterId: "hiyori" });
    expect(hiyoriCat.motions).toHaveLength(10);
    expect(hiyoriCat.expressions).toHaveLength(6);

    const riceCat = introspectLive2DCatalog({ rawModelJson: riceJson, characterId: "rice" });
    expect(riceCat.motions).toHaveLength(4);
    expect(riceCat.expressions).toHaveLength(6);

    for (const cat of [maoCat, hiyoriCat, riceCat]) {
      expect(new Set(cat.motions.map((m) => m.id)).size).toBe(cat.motions.length);
      for (const m of cat.motions) expect(EMOJI_RE.test(m.labelZh)).toBe(false);
      for (const e of cat.expressions) expect(EMOJI_RE.test(e.labelZh)).toBe(false);
    }

    const customCat = introspectLive2DCatalog({
      isCustomPackage: true,
      rawModelJson: {
        FileReferences: {
          Motions: {
            Idle: [{ File: "motions/idle_breath.motion3.json" }],
            TapBody: [{ File: "motions/special_magic.motion3.json" }],
          },
          Expressions: [
            { Name: "wink_01", File: "expressions/wink_01.exp3.json" },
            { Name: "blush", File: "expressions/blush.exp3.json" },
          ],
        },
      },
    });
    expect(customCat.motions[0]?.labelZh).toBe("待机呼吸");
    expect(customCat.motions[1]?.labelZh).toBe("招牌演绎·一");
    expect(customCat.expressions[0]?.labelZh).toBe("俏皮眨眼");
    expect(customCat.expressions[1]?.labelZh).toBe("害羞脸红");

    expect(DEMO_SHOWCASE_STEPS).toHaveLength(5);
    for (const step of DEMO_SHOWCASE_STEPS) {
      expect(pickExpressionByHint(maoCat.expressions, step.expressionHint)).not.toBeNull();
      expect(pickMotionByCategory(maoCat.motions, step.motionCategory)).not.toBeNull();
    }
    expect(resolveLive2DPresenceState("happy", "celebrate", maoCat).motionCategory).toBe("special");
    expect(resolveTouchReactionTargets("head", 3, maoCat).motionItem?.category).toBe("special");
  });

  it("drives damped 2.5D gaze, 5-vowel lip-sync, frameless calibration, and Live2DCompanionController", async () => {
    const g1 = stepGazeDamping({ nx: 0, ny: 0 }, 0.8, -0.5, 0.032);
    expect(g1.nx).toBeGreaterThan(0);
    expect(g1.ny).toBeLessThan(0);
    expect(Number.isFinite(g1.angleX)).toBe(true);
    expect(stepGazeDamping({ nx: 0, ny: 0 }, Number.NaN, 99, Number.NaN).nx).toBe(0);

    const speakingSample = computeStreamingLipSyncFrame({
      clockSec: 0.42, speaking: true, speechText: "你好千机，今天工作区进展顺利", currentOpenY: 0.1, dtSec: 0.032,
    });
    expect(speakingSample.mouthOpenY).toBeGreaterThan(0.08);
    expect(["A", "I", "U", "E", "O"]).toContain(speakingSample.vowel);

    let silentOpen = speakingSample.mouthOpenY;
    for (let i = 0; i < 40; i += 1) {
      silentOpen = computeStreamingLipSyncFrame({
        clockSec: 2.0, speaking: false, currentOpenY: silentOpen, dtSec: 0.05,
      }).mouthOpenY;
    }
    expect(silentOpen).toBe(0);

    expect(classifyHitZoneFromAreasAndNormY(["HitAreaHead"], 0.7, 0)).toBe("head");
    expect(classifyHitZoneFromAreasAndNormY([], 0.36, 0.1)).toBe("face");
    expect(classifyHitZoneFromAreasAndNormY([], 0.62, 0.72)).toBe("accessory");

    const bounds = { top: 0, centerX: 1400, width: 2800, height: 3900 };
    const frameAt = (framingMode: "half-body" | "bust-breakout" | "full-art") =>
      computeFramingTarget({
        bounds, meta: LIVE2D_PRESETS["alabaster-felt"], framingMode,
        stageVariant: "showcase", portalWidth: 540, portalHeight: 540, canvasWidth: 540, canvasHeight: 540,
      });
    const halfTarget = frameAt("half-body");
    const bustTarget = frameAt("bust-breakout");
    const fullTarget = frameAt("full-art");
    expect(halfTarget.topCanvasY).toBeGreaterThanOrEqual(40);
    expect(bustTarget.scale).toBeGreaterThan(halfTarget.scale);
    expect(fullTarget.scale).toBeLessThan(halfTarget.scale);
    expect(fullTarget.visibleHeightPx).toBeLessThanOrEqual(540);

    const writtenParams = new Map<string, number>();
    const hooks = new Map<string, () => void>();
    const mockModel = {
      internalModel: {
        settings: {},
        focusController: { focus: () => undefined },
        coreModel: {
          addParameterValueById: (id: string, val: number) => writtenParams.set(id, (writtenParams.get(id) ?? 0) + val),
          setParameterValueById: (id: string, val: number) => writtenParams.set(id, val),
        },
        on: (ev: string, fn: () => void) => hooks.set(ev, fn),
        off: (ev: string) => hooks.delete(ev),
      },
      motion: async () => true,
      expression: async () => true,
      focus: () => undefined,
      hitTest: (x: number, y: number) => (y < 120 && x > 0 ? ["Head"] : []),
      stopSpeaking: () => undefined,
      stopMotions: () => undefined,
    } as unknown as Live2DModelType<Cubism4InternalModel>;

    const maoRaw = loadModel3DiskJson(LIVE2D_PRESETS["alabaster-felt"].modelJsonUrl).raw;
    const ctrl = new Live2DCompanionController({
      model: mockModel, rawModelJson: maoRaw, presetMeta: LIVE2D_PRESETS["alabaster-felt"],
    });
    ctrl.setLookAtTarget(0.6, 0.4);
    ctrl.setPresenceState({ expression: "happy", action: "wave", isStreaming: true, speechText: "正在核查待办任务" });
    hooks.get("beforeModelUpdate")?.();
    expect(writtenParams.get("ParamMouthOpenY") ?? 0).toBeGreaterThan(0);
    expect((await ctrl.playShowcaseStep(1))?.motion).not.toBeNull();
    expect(ctrl.handlePointerTap({ canvasX: 200, canvasY: 80, normX: 0, normY: 0.15 }).combo).toBe(1);
    const touchExp = ctrl.getActiveExpression()?.id ?? null;
    ctrl.setPresenceState({ expression: "happy", action: "wave", isStreaming: false, speechText: null });
    expect(ctrl.getActiveExpression()?.id ?? null).toBe(touchExp);
    expect(ctrl.triggerHitZone("face").combo).toBe(2);
    expect(ctrl.triggerHitZone("accessory").combo).toBe(3);
    ctrl.dispose();
    expect(hooks.has("beforeModelUpdate")).toBe(false);
  });

  it("maps live session tool calls, pending approvals, hover previews, and custom task-stage pose bindings", () => {
    expect(REHEARSABLE_TASK_STAGES).toHaveLength(6);

    const readAct = extractLiveSessionToolActivity([
      { role: "user", content: "检查依赖" },
      { role: "assistant", toolCalls: [{ name: "read_file", status: "running", args: { Path: "D:/repo/package.json" } }] },
    ]);
    expect(readAct.toolPhase).toBe("tool-reading");
    expect(readAct.activeToolLabel).toBe("正在查阅 · package.json");
    expect(readAct.isRunningTool).toBe(true);

    const editAct = extractLiveSessionToolActivity([
      { role: "assistant", toolCalls: [{ name: "edit_file", status: "running", args: { path: "src/BotStage.tsx" } }] },
    ]);
    expect(editAct.toolPhase).toBe("tool-editing");
    expect(editAct.activeToolLabel).toBe("正在编写 · BotStage.tsx");

    const cmdDoneAct = extractLiveSessionToolActivity([
      {
        role: "assistant",
        toolCalls: [
          { name: "edit_file", status: "completed", args: { path: "src/a.ts" } },
          { name: "run_command", status: "completed", args: { CommandLine: "npm test" } },
        ],
      },
    ]);
    expect(cmdDoneAct.toolPhase).toBe("tool-command");
    expect(cmdDoneAct.completedToolCount).toBe(2);

    const streamPresence = resolveTaskCompanionPresence({
      ui: INITIAL_BOT_UI_STATE, snapshot: FALLBACK_BOT_SNAPSHOT, isStreaming: true, toolActivity: editAct,
    });
    expect(streamPresence.phase).toBe("tool-editing");
    expect(streamPresence.expression).toBe("focused");

    const donePresence = resolveTaskCompanionPresence({
      ui: INITIAL_BOT_UI_STATE, snapshot: FALLBACK_BOT_SNAPSHOT, justReplied: true, toolActivity: cmdDoneAct,
    });
    expect(donePresence.phase).toBe("task-completed");
    expect(donePresence.action).toBe("celebrate");
    expect(donePresence.speechText).toContain("2 步工具操作");

    const approvalSnapshot = {
      ...FALLBACK_BOT_SNAPSHOT,
      pendingApprovals: [
        {
          id: "ap-1", title: "发送周报草稿", summary: "向频道同步进展",
          commandSignature: "slack.post", createdAt: 1_700_000_000, expiresAt: 1_800_000_000,
        },
      ],
    };
    const approvalPresence = resolveTaskCompanionPresence({ ui: INITIAL_BOT_UI_STATE, snapshot: approvalSnapshot });
    expect(approvalPresence.phase).toBe("awaiting-approval");
    expect(approvalPresence.quickActions[0]?.id).toBe("approve-first");

    setHoveredHeroTaskPreview({
      id: "patrol", expression: "patrol", action: "scan",
      badgeLabelZh: "准备执行 · 主动巡检", speechText: "现在扫描工作区变更、待办与环境健康吗？",
    });
    const hoverPresence = resolveTaskCompanionPresence({ ui: INITIAL_BOT_UI_STATE, snapshot: approvalSnapshot });
    expect(hoverPresence.phase).toBe("hover-preview");
    expect(hoverPresence.expression).toBe("patrol");
    setHoveredHeroTaskPreview(null);

    bindCurrentPoseToTaskStage("tool-editing", { expressionId: "exp:exp_04", motionId: "TapBody:3" });
    expect(resolveBoundTaskStagePose("tool-editing")?.motionId).toBe("TapBody:3");
    rehearseLive2DTaskStage("tool-editing");
    expect(getLive2DDirectorSnapshot().rehearsingTaskStageId).toBe("tool-editing");
    clearTaskStageBinding("tool-editing");
    expect(resolveBoundTaskStagePose("tool-editing")).toBeNull();

    triggerCharacterPoke(0);
    expect(botUiStore.get().characterSpeech).toBeNull();
    const pokedPanelHtml = renderToStaticMarkup(createElement(BotCompanionPanel));
    expect(pokedPanelHtml).not.toContain('data-testid="bot-companion-speech-bubble"');
    expect(pokedPanelHtml).toContain('data-action="wave"');
  });

  it("unpacks .zip Live2D archives in memory with JSZip and rewrites relative URLs to blob: URLs", async () => {
    expect(await ensureCubismCoreLoaded()).toBe(false);

    const zip = new JSZip();
    zip.file("__MACOSX/._Custom.model3.json", "junk");
    zip.file(
      "CustomModel/Custom.model3.json",
      JSON.stringify({
        Version: 3,
        FileReferences: {
          Moc: "Custom.moc3",
          Physics: "Custom.physics3.json",
          Textures: ["textures/texture_00.png"],
          Expressions: [{ Name: "smile", File: "expressions/smile.exp3.json" }],
          Motions: { Idle: [{ File: "motions/idle.motion3.json", Sound: "sounds/missing.wav" }] },
        },
      }),
    );
    zip.file("CustomModel/Custom.moc3", new Uint8Array([1, 2, 3, 4]));
    zip.file("CustomModel/Custom.physics3.json", JSON.stringify({ Version: 3 }));
    zip.file("CustomModel/textures/texture_00.png", new Uint8Array([137, 80, 78, 71]));
    zip.file("CustomModel/expressions/smile.exp3.json", JSON.stringify({ Type: "Live2D Expression" }));
    zip.file("CustomModel/motions/idle.motion3.json", JSON.stringify({ Version: 3 }));

    const zipBytes = await zip.generateAsync({ type: "uint8array" });
    const safeBytes = new Uint8Array(zipBytes.byteLength);
    safeBytes.set(zipBytes);
    const { customId, fileName } = await registerZipLive2DPackage(
      new File([safeBytes], "aurora-custom.zip", { type: "application/zip" }),
    );
    expect(customId.startsWith("zip:")).toBe(true);
    expect(fileName).toBe("aurora-custom.zip");

    const refs = getRegisteredZipPackage(customId)?.rewrittenModelJson.FileReferences as Record<string, unknown>;
    expect(String(refs.Moc).startsWith("blob:")).toBe(true);
    expect(String((refs.Textures as string[])[0]).startsWith("blob:")).toBe(true);
    const idleEntry = ((refs.Motions as Record<string, Array<Record<string, unknown>>>).Idle ?? [])[0];
    expect(String(idleEntry?.File).startsWith("blob:")).toBe(true);
    expect(idleEntry?.Sound).toBeUndefined();

    revokeZipLive2DPackage(customId);
    expect(getRegisteredZipPackage(customId)).toBeNull();
  });

  it("consolidates status into single bot-vserver-pill, distills starter capsules, and removes eyebrow kickers", () => {
    const idlePanelHtml = renderToStaticMarkup(createElement(BotCompanionPanel));
    expect(idlePanelHtml).toContain('data-testid="bot-vserver-pill"');
    expect(idlePanelHtml).toContain('data-task-phase="idle-ready"');
    expect(idlePanelHtml).toContain("已连接");
    expect(idlePanelHtml).not.toContain('data-testid="bot-companion-task-chip"');
    expect(idlePanelHtml).not.toContain('data-testid="bot-companion-speech-bubble"');

    setHoveredHeroTaskPreview({
      id: "patrol", expression: "patrol", action: "scan",
      badgeLabelZh: "准备执行 · 主动巡检", speechText: "现在扫描工作区变更、待办与环境健康吗？",
    });
    const hoverPanelHtml = renderToStaticMarkup(createElement(BotCompanionPanel));
    expect(hoverPanelHtml).toContain('data-task-phase="hover-preview"');
    expect(hoverPanelHtml).toContain("准备执行 · 主动巡检");
    expect(hoverPanelHtml).not.toContain('data-testid="bot-companion-speech-bubble"');
    setHoveredHeroTaskPreview(null);

    botDataStore.set({
      ...FALLBACK_BOT_SNAPSHOT,
      pendingApprovals: [
        {
          id: "ap-9", title: "提交巡检修复补丁", summary: "修改 2 个文件",
          commandSignature: "git.commit", createdAt: 1_700_000_000, expiresAt: 1_800_000_000,
        },
      ],
    });
    const approvalPanelHtml = renderToStaticMarkup(createElement(BotCompanionPanel));
    expect(approvalPanelHtml).toContain('data-testid="bot-character-stage"');
    expect(approvalPanelHtml).toContain('data-testid="bot-companion-speech-bubble"');
    expect(approvalPanelHtml).toContain('data-testid="companion-action-approve-first"');
    expect(approvalPanelHtml).toContain('data-task-phase="awaiting-approval"');
    expect(approvalPanelHtml).toContain("待批准 · 提交巡检修复补丁");
    expect(approvalPanelHtml).not.toContain('data-testid="bot-companion-task-chip"');
    expect(EMOJI_RE.test(approvalPanelHtml)).toBe(false);
    expect(PLUSHIE_SLOP_RE.test(approvalPanelHtml)).toBe(false);

    const heroOpenPanelHtml = renderToStaticMarkup(
      createElement(BotChatHeroStage, { isMain: true, topTitle: "主对话", isStreaming: false }),
    );
    expect(heroOpenPanelHtml).not.toContain('data-testid="live2d-viewport-hero"');
    expect(heroOpenPanelHtml).toContain('data-testid="bot-hero-task-deck"');
    expect(heroOpenPanelHtml).toContain('data-testid="hero-task-status-callout"');
    expect(heroOpenPanelHtml).toContain('data-testid="hero-approve-first-btn"');
    expect(heroOpenPanelHtml).toContain('data-testid="hero-task-patrol"');
    expect(heroOpenPanelHtml).toContain('data-testid="hero-task-goals"');
    expect(heroOpenPanelHtml).not.toContain('data-testid="hero-open-live2d-showcase"');
    expect(heroOpenPanelHtml).not.toContain('data-testid="hero-play-live2d-demo"');

    patchBotUi({ rightPanelOpen: false });
    const heroCollapsedHtml = renderToStaticMarkup(
      createElement(BotChatHeroStage, { isMain: true, topTitle: "主对话", isStreaming: false }),
    );
    expect(heroCollapsedHtml).toContain('data-testid="bot-hero-character"');
    expect(heroCollapsedHtml).toContain('data-testid="live2d-viewport-hero"');

    openLive2DShowcase();
    rehearseLive2DTaskStage("tool-editing");
    const modalHtml = renderToStaticMarkup(createElement(Live2DShowcaseModal));
    expect(modalHtml).toContain('data-testid="bot-live2d-showcase-modal"');
    expect(modalHtml).not.toContain("qj-l2d-editorial-kicker");
    expect(modalHtml).toContain('<h1 class="qj-l2d-editorial-name">');
    expect(modalHtml).toContain('data-testid="workshop-task-rehearsal-box"');
    expect(modalHtml).toContain('data-testid="workshop-stage-task-hud"');
    expect(modalHtml).toContain('data-testid="workshop-bind-stage-btn"');
    expect(EMOJI_RE.test(modalHtml)).toBe(false);
  });

  it("patches PixiJS ShaderSystem for Tauri strict no-unsafe-eval CSP and synchronous texture upload", () => {
    const pixi = ensurePixiCspRuntime();
    expect(pixi.settings.CREATE_IMAGE_BITMAP).toBe(false);
    const maybeLoadTextures = (
      pixi as unknown as {
        loadTextures?: { config?: { preferWorkers?: boolean; preferCreateImageBitmap?: boolean } };
      }
    ).loadTextures;
    if (maybeLoadTextures?.config !== undefined) {
      expect(maybeLoadTextures.config.preferWorkers).toBe(false);
      expect(maybeLoadTextures.config.preferCreateImageBitmap).toBe(false);
    }

    // Simulate Tauri WebView CSP (`script-src 'self' blob: 'wasm-unsafe-eval'`, no `'unsafe-eval'`)
    // by invoking ShaderSystem.prototype.systemCheck directly: `@pixi/unsafe-eval` must keep it non-throwing.
    const systemCheck = (
      PIXI.ShaderSystem.prototype as unknown as { systemCheck: () => void }
    ).systemCheck;
    expect(() => systemCheck.call({})).not.toThrow();

    const tauriConf = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "src-tauri/tauri.conf.json"), "utf8"),
    ) as { app?: { security?: { csp?: string } } };
    const csp = tauriConf.app?.security?.csp ?? "";
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toMatch(/connect-src[^;]*\bblob:/);
  });
});
