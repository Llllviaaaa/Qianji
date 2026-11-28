/**
 * Step-by-step Action Timeline Scrubber (`BotComputerTimelineBar`) at the bottom
 * of `BotComputerStudioPane`.
 */
import type { ReactElement } from "react";
import { ChevronLeft, ChevronRight, Radio } from "lucide-react";
import {
  getEngineCardMeta,
  patchComputerStudioUi,
  setComputerScrubIndex,
  useComputerStudioSnapshot,
  useComputerStudioUi,
} from "./computerStudioStore";

function formatStepClock(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "--:--:--";
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function BotComputerTimelineBar(): ReactElement {
  const snap = useComputerStudioSnapshot();
  const ui = useComputerStudioUi();

  const steps = snap.timeline;
  const total = steps.length;
  const isLive = ui.scrubIndex === null;
  const effectiveIdx =
    total === 0
      ? 0
      : ui.scrubIndex !== null
        ? Math.min(ui.scrubIndex, total - 1)
        : total - 1;
  const currentStep = total > 0 ? steps[effectiveIdx] : undefined;

  const handleStepPrev = () => {
    if (total === 0) return;
    if (ui.scrubIndex === null) {
      setComputerScrubIndex(Math.max(0, total - 2));
    } else {
      setComputerScrubIndex(Math.max(0, ui.scrubIndex - 1));
    }
  };

  const handleStepNext = () => {
    if (total === 0 || ui.scrubIndex === null) return;
    if (ui.scrubIndex >= total - 1) {
      setComputerScrubIndex(null);
    } else {
      setComputerScrubIndex(ui.scrubIndex + 1);
    }
  };

  const stepEngineBadge = currentStep ? getEngineCardMeta(currentStep.engine).badgeLabel : null;

  return (
    <footer className="qj-cs-timeline-bar" data-testid="computer-timeline-bar">
      <div className="qj-cs-timeline-nav">
        <button
          type="button"
          data-testid="timeline-prev-btn"
          className="qj-cs-icon-btn sm"
          aria-label="上一步操作回放"
          title="上一步操作回放"
          disabled={total === 0 || (ui.scrubIndex !== null && ui.scrubIndex <= 0)}
          onClick={handleStepPrev}
        >
          <ChevronLeft size={14} />
        </button>
        <button
          type="button"
          data-testid="timeline-next-btn"
          className="qj-cs-icon-btn sm"
          aria-label="下一步操作回放"
          title="下一步操作回放"
          disabled={isLive || total === 0}
          onClick={handleStepNext}
        >
          <ChevronRight size={14} />
        </button>
      </div>

      <div className="qj-cs-timeline-track-col">
        <div className="qj-cs-timeline-meta">
          <span className="qj-cs-timeline-step-title" data-testid="timeline-step-title">
            {currentStep !== undefined
              ? `${effectiveIdx + 1}/${total} · ${currentStep.title}`
              : "等待千机执行桌面 / 浏览器 / 终端动作…"}
          </span>
          <span className="qj-cs-timeline-step-time qj-tabular">
            {stepEngineBadge !== null ? `${stepEngineBadge} · ` : ""}
            {currentStep !== undefined ? formatStepClock(currentStep.ts) : "实时就绪"}
          </span>
        </div>
        <input
          type="range"
          data-testid="timeline-slider"
          aria-label="分身操作时间轴进度"
          className="qj-cs-timeline-slider"
          min={0}
          max={Math.max(0, total - 1)}
          step={1}
          disabled={total <= 1}
          value={effectiveIdx}
          onChange={(e) => {
            const idx = Number(e.target.value);
            if (idx >= total - 1) {
              setComputerScrubIndex(null);
            } else {
              patchComputerStudioUi({ scrubIndex: idx });
            }
          }}
        />
      </div>

      <button
        type="button"
        data-testid="timeline-live-btn"
        className={`qj-cs-live-pill${isLive ? " is-live" : ""}`}
        onClick={() => setComputerScrubIndex(null)}
        title="跳回实时画面"
      >
        <Radio size={11.5} />
        <span>● LIVE 实时</span>
      </button>
    </footer>
  );
}
