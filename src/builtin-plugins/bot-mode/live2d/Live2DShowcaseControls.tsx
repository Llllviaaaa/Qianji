/**
 * Flat Frosted-Glass Inspector (`Live2DShowcaseControls`) for
 *《千机 · 角色与任务工坊》(`Live2DShowcaseModal`).
 *
 * Structured with clean vertical rhythm and hairline dividers — zero nested
 * sub-cards or eyebrow kickers inside the glass panel.
 */
import { useMemo, useRef, useState, type ChangeEvent, type ReactElement } from "react";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  FileCode2,
  FolderArchive,
  Link2,
  Play,
  RotateCcw,
  Search,
  ShieldAlert,
  Smile,
  Sparkles,
  Square,
  Sun,
  Terminal,
  X,
} from "lucide-react";
import type { BotAvatarPresetId } from "@qianji/protocol";
import {
  REHEARSABLE_STAGE_BY_ID,
  REHEARSABLE_TASK_STAGES,
  type RehearsableTaskStageId,
} from "./botTaskChoreographer";
import { DEMO_SHOWCASE_STEPS } from "./live2dCatalog";
import {
  bindCurrentPoseToTaskStage,
  clearCustomLive2DPackage,
  clearTaskStageBinding,
  importCustomLive2DPackage,
  rehearseLive2DTaskStage,
  selectLive2DExpression,
  selectLive2DMotion,
  setLive2DBackdropTheme,
  setLive2DHeadTracking,
  setLive2DParallaxStrength,
  toggleLive2DDemoReel,
  type Live2DDirectorState,
} from "./live2dDirectorStore";
import {
  LIVE2D_PRESET_IDS,
  LIVE2D_PRESETS,
  type Live2DBackdropThemeId,
  type Live2DMotionItem,
} from "./types";

type MotionCategoryFilter = "all" | Live2DMotionItem["category"];

const MOTION_TABS: ReadonlyArray<{ readonly id: MotionCategoryFilter; readonly labelZh: string }> = [
  { id: "all", labelZh: "全部" },
  { id: "idle", labelZh: "待机" },
  { id: "greeting", labelZh: "问候" },
  { id: "emotion", labelZh: "情绪" },
  { id: "special", labelZh: "招牌" },
  { id: "touch", labelZh: "互动" },
];

const BACKDROP_THEMES: ReadonlyArray<{
  readonly id: Live2DBackdropThemeId;
  readonly labelZh: string;
  readonly swatch: string;
}> = [
  { id: "atelier-aurora", labelZh: "极光画室", swatch: "#7c9cff" },
  { id: "sunlit-window", labelZh: "晴空窗畔", swatch: "#f59e0b" },
  { id: "stardust-sanctuary", labelZh: "星辉秘境", swatch: "#a855f7" },
  { id: "velvet-night", labelZh: "丝绒夜幕", swatch: "#64748b" },
];

const PERSONA_SUBLABELS: Readonly<Record<Exclude<BotAvatarPresetId, "custom">, string>> = {
  "alabaster-felt": "云白·虹彩绘师",
  "warm-felt": "暖珀·晴空学妹",
  "plush-ears": "星黛·秘境司书",
};

const HEAD_TRACK_STATUS_TEXT: Readonly<Record<Live2DDirectorState["headTrackingStatus"], string>> = {
  off: "鼠标与触控板跟随",
  requesting: "正在开启本地摄像头…",
  active: "本地摄像头实时视差中",
  fallback: "已回退至鼠标跟随",
};

const STAGE_ICONS: Readonly<Record<RehearsableTaskStageId, typeof Search>> = {
  "tool-reading": Search,
  "tool-editing": FileCode2,
  "tool-command": Terminal,
  "awaiting-approval": ShieldAlert,
  "task-completed": CheckCircle2,
  "task-error": AlertTriangle,
};

export interface Live2DShowcaseControlsProps {
  readonly director: Live2DDirectorState;
  readonly activePreset: BotAvatarPresetId;
  readonly onSelectPreset: (preset: Exclude<BotAvatarPresetId, "custom">) => void;
  readonly onActivateCustomModel: () => void;
  readonly onClose: () => void;
}

export function Live2DShowcaseControls({
  director,
  activePreset,
  onSelectPreset,
  onActivateCustomModel,
  onClose,
}: Live2DShowcaseControlsProps): ReactElement {
  const [motionTab, setMotionTab] = useState<MotionCategoryFilter>("all");
  const [fallbackStageId, setFallbackStageId] = useState<RehearsableTaskStageId>("tool-editing");
  const zipInputRef = useRef<HTMLInputElement | null>(null);

  const visibleMotions = useMemo(
    () =>
      motionTab === "all"
        ? director.availableMotions
        : director.availableMotions.filter((m) => m.category === motionTab),
    [director.availableMotions, motionTab],
  );

  const handleZipFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const loadedId = await importCustomLive2DPackage(file);
    if (loadedId !== null) onActivateCustomModel();
  };

  const activeMotionId = director.selectedMotionId ?? director.liveMotion?.id ?? null;
  const activeExpressionId = director.selectedExpressionId ?? director.liveExpression?.id ?? null;
  const targetBindStageId = director.rehearsingTaskStageId ?? fallbackStageId;
  const targetStageSpec = REHEARSABLE_STAGE_BY_ID.get(targetBindStageId) ?? REHEARSABLE_TASK_STAGES[0];
  const targetStageLabel = targetStageSpec?.labelZh ?? "当前任务";
  const currentStageBinding = director.taskStageBindings[targetBindStageId];
  const isCurrentPoseBound =
    currentStageBinding !== undefined &&
    currentStageBinding.expressionId === activeExpressionId &&
    currentStageBinding.motionId === activeMotionId;

  const totalSteps = Math.max(1, DEMO_SHOWCASE_STEPS.length);
  const reelProgressRatio = director.demoReelActive
    ? Math.max(0.05, Math.min(1, (director.demoReelStepIndex + 1) / totalSteps))
    : 0;

  return (
    <aside className="qj-l2d-inspector-card" aria-label="角色与任务工坊控制面板">
      <div className="qj-showcase-deck-head">
        <div className="qj-showcase-deck-head-left">
          <h2 className="qj-showcase-deck-title">角色与任务工坊</h2>
          <button
            type="button"
            data-testid="showcase-demo-reel-btn"
            className={`qj-showcase-reel-cta qj-tabular${director.demoReelActive ? " active" : ""}`}
            onClick={() => toggleLive2DDemoReel()}
          >
            {director.demoReelActive ? <Square size={12} /> : <Play size={12} />}
            <span>
              {director.demoReelActive
                ? `停止展演 (${director.demoReelStepIndex + 1}/${totalSteps})`
                : "自动展演"}
            </span>
          </button>
        </div>

        <button
          type="button"
          className="qj-muse-modal-close"
          aria-label="关闭角色与任务工坊"
          title="关闭 (Esc)"
          onClick={onClose}
        >
          <X size={16} strokeWidth={1.85} />
        </button>
      </div>

      {director.demoReelActive && (
        <div className="qj-showcase-reel-progress">
          <div className="qj-showcase-reel-bar">
            <span style={{ transform: `scaleX(${reelProgressRatio.toFixed(3)})` }} />
          </div>
          <div className="qj-showcase-reel-caption">
            {director.demoReelCaption ?? "正在切换角色神态与动作…"}
          </div>
        </div>
      )}

      <div className="qj-showcase-section">
        <div className="qj-showcase-section-head">
          <span>陪伴角色</span>
          <div className="qj-showcase-asset-icons">
            <input
              ref={zipInputRef}
              type="file"
              accept=".zip,.model3.json,application/zip"
              style={{ display: "none" }}
              onChange={(e) => void handleZipFileChange(e)}
            />
            <button
              type="button"
              data-testid="showcase-import-live2d-zip"
              className="qj-showcase-icon-action"
              title={
                director.customModelFileName
                  ? `已挂载模型包：${director.customModelFileName}`
                  : "导入或拖放 Live2D .zip 模型压缩包"
              }
              onClick={() => zipInputRef.current?.click()}
            >
              <FolderArchive size={13} />
              <span>{director.customModelFileName ?? "导入 .zip"}</span>
            </button>
            {director.customModelFileName !== null && (
              <button
                type="button"
                className="qj-showcase-icon-only"
                title="恢复内置 4K 角色"
                aria-label="恢复内置 4K 角色"
                onClick={() => {
                  clearCustomLive2DPackage();
                  onSelectPreset("alabaster-felt");
                }}
              >
                <RotateCcw size={13} />
              </button>
            )}
          </div>
        </div>

        {director.importError !== null && (
          <div className="qj-showcase-error-note" role="alert">{director.importError}</div>
        )}

        <div className="qj-showcase-persona-row" role="group" aria-label="内置角色切换">
          {LIVE2D_PRESET_IDS.map((id) => {
            const meta = LIVE2D_PRESETS[id];
            const isSelected = activePreset === id && director.customModelSource === null;
            return (
              <button
                key={id}
                type="button"
                data-testid={`showcase-persona-${id}`}
                className={`qj-showcase-persona-pill${isSelected ? " active" : ""}`}
                onClick={() => {
                  clearCustomLive2DPackage();
                  setLive2DBackdropTheme(meta.defaultBackdrop);
                  onSelectPreset(id);
                }}
              >
                <span className="qj-showcase-persona-dot" style={{ background: meta.accentHex }} />
                <span className="qj-showcase-persona-name">{PERSONA_SUBLABELS[id]}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div
        className="qj-showcase-section qj-showcase-divider-section"
        data-testid="workshop-task-rehearsal-box"
      >
        <div className="qj-showcase-section-head">
          <span>任务状态联动演练与绑定</span>
          {director.rehearsingTaskStageId !== null && (
            <button
              type="button"
              className="qj-showcase-icon-action"
              onClick={() => rehearseLive2DTaskStage(null)}
            >
              <span>退出预演</span>
            </button>
          )}
        </div>

        <div className="qj-task-stage-grid" role="group" aria-label="任务状态演练列表">
          {REHEARSABLE_TASK_STAGES.map((stage) => {
            const StageIcon = STAGE_ICONS[stage.id];
            const isRehearsing = director.rehearsingTaskStageId === stage.id;
            const hasBinding = director.taskStageBindings[stage.id] !== undefined;
            return (
              <button
                key={stage.id}
                type="button"
                data-testid={`workshop-task-stage-${stage.id}`}
                className={`qj-task-stage-chip${isRehearsing ? " active" : ""}`}
                onClick={() => {
                  setFallbackStageId(stage.id);
                  rehearseLive2DTaskStage(stage.id);
                }}
              >
                <span className="qj-task-stage-chip-label">
                  <StageIcon size={12} />
                  <span>{stage.labelZh}</span>
                </span>
                {hasBinding && <span className="qj-task-bound-dot" title="已绑定专属神态" />}
              </button>
            );
          })}
        </div>

        <div className="qj-task-bind-bar">
          <button
            type="button"
            data-testid="workshop-bind-stage-btn"
            className="qj-task-bind-btn"
            onClick={() => bindCurrentPoseToTaskStage(targetBindStageId)}
          >
            <Link2 size={12.5} />
            <span>
              {isCurrentPoseBound
                ? `已绑定至「${targetStageLabel}」状态`
                : `绑定当前神态至「${targetStageLabel}」`}
            </span>
          </button>

          {currentStageBinding !== undefined && (
            <button
              type="button"
              data-testid="workshop-reset-stage-binding"
              className="qj-task-bind-reset"
              title={`重置「${targetStageLabel}」默认神态`}
              aria-label={`重置「${targetStageLabel}」默认神态`}
              onClick={() => clearTaskStageBinding(targetBindStageId)}
            >
              <RotateCcw size={12.5} />
            </button>
          )}
        </div>
      </div>

      <div className="qj-showcase-section qj-showcase-divider-section">
        <div className="qj-showcase-section-head">
          <span>神态表情</span>
        </div>
        <div className="qj-live2d-exp-grid" role="list" aria-label="神态表情列表">
          {director.availableExpressions.length === 0 ? (
            <span className="qj-l2d-muted-hint">正在读取模型表情…</span>
          ) : (
            director.availableExpressions.map((exp) => (
              <button
                key={exp.id}
                type="button"
                role="listitem"
                className={`qj-live2d-exp-pill${activeExpressionId === exp.id ? " active" : ""}`}
                onClick={() => selectLive2DExpression(exp.id)}
              >
                <Smile size={12} />
                <span>{exp.labelZh}</span>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="qj-showcase-motion-panel qj-showcase-divider-section">
        <div className="qj-showcase-section-head">
          <span>动作点播</span>
          <div className="qj-showcase-cat-strip" role="tablist" aria-label="动作分类">
            {MOTION_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={motionTab === tab.id}
                className={`qj-showcase-cat-tab${motionTab === tab.id ? " active" : ""}`}
                onClick={() => setMotionTab(tab.id)}
              >
                {tab.labelZh}
              </button>
            ))}
          </div>
        </div>

        <div className="qj-showcase-motion-grid" role="list" aria-label="动作列表">
          {visibleMotions.length === 0 ? (
            <div className="qj-showcase-motion-empty">该分类下暂无动作，切换至「全部」查看</div>
          ) : (
            visibleMotions.map((motion) => {
              const isPlaying = activeMotionId === motion.id;
              return (
                <button
                  key={motion.id}
                  type="button"
                  role="listitem"
                  className={`qj-showcase-motion-card${isPlaying ? " active" : ""}`}
                  onClick={() => selectLive2DMotion(motion.id)}
                >
                  <span className="qj-showcase-motion-name">{motion.labelZh}</span>
                  {isPlaying && <Sparkles size={12} />}
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="qj-showcase-optics-section qj-showcase-divider-section">
        <div className="qj-showcase-light-row" role="group" aria-label="氛围场景">
          <Sun size={13.5} className="qj-showcase-light-icon" />
          <div className="qj-showcase-light-pills">
            {BACKDROP_THEMES.map((theme) => (
              <button
                key={theme.id}
                type="button"
                className={`qj-showcase-light-pill${director.backdropTheme === theme.id ? " active" : ""}`}
                onClick={() => setLive2DBackdropTheme(theme.id)}
              >
                <span className="qj-showcase-light-dot" style={{ background: theme.swatch }} />
                <span>{theme.labelZh}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="qj-showcase-footer-controls">
          <div className="qj-showcase-headtrack-inline">
            <Camera size={13} className="qj-showcase-light-icon" />
            <div className="qj-showcase-headtrack-copy">
              <span className="qj-showcase-headtrack-title">摄像头头部视差</span>
              <span className="qj-showcase-headtrack-sub">
                {HEAD_TRACK_STATUS_TEXT[director.headTrackingStatus]}
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={director.headTrackingEnabled}
              aria-label="摄像头头部视差"
              className={`qj-showcase-switch${director.headTrackingEnabled ? " on" : ""}`}
              onClick={() => setLive2DHeadTracking(!director.headTrackingEnabled)}
            >
              <span className="qj-showcase-switch-thumb" />
            </button>
          </div>

          <div className="qj-showcase-parallax-inline">
            <label className="qj-showcase-mini-slider">
              <span>视差灵动度</span>
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.05}
                aria-label="视差灵动度"
                value={director.parallaxStrength}
                onChange={(e) => setLive2DParallaxStrength(Number(e.target.value))}
              />
            </label>
          </div>
        </div>
      </div>
    </aside>
  );
}
