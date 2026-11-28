/**
 * Quiet Muse Starter Capsules (`BotHeroTaskDeck.tsx`).
 *
 * Mounted beneath `你好，我是千机` in the empty chat canvas:
 * - Conditional inline approval callout ONLY when `pendingApprovals.length > 0`.
 * - Whisper-quiet `34px` monochrome starter capsules (`巡检工作区` · `梳理今日目标` ·
 *   `汇总未读简报` · `检查仓库改动`) with real-time hover-to-react sync on `千机`.
 */
import { useEffect, type ReactElement } from "react";
import { Activity, Inbox, Target, Terminal } from "lucide-react";
import { useRpcState, useSessionHandle, useWorkspaceState } from "@qianji/client";
import { patchBotUi, useBotController, useBotSnapshot, useBotUiState } from "./botStore";
import {
  CO_PILOT_TASK_PROMPTS,
  setHoveredHeroTaskPreview,
  type HoveredHeroTaskPreview,
} from "./live2d/botTaskChoreographer";

interface HeroStarterCapsuleSpec {
  readonly id: string;
  readonly testId: string;
  readonly labelZh: string;
  readonly Icon: typeof Activity;
  readonly countSuffix?: number;
  readonly preview: HoveredHeroTaskPreview;
  readonly onTrigger: () => void;
}

export function BotHeroTaskDeck(): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController();
  const workspaceSnap = useWorkspaceState();
  const rpcSnap = useRpcState();

  const targetSessionId = ui.activeSessionId ?? snapshot.mainSessionId;
  const targetSessionFile =
    targetSessionId === ""
      ? null
      : targetSessionId.startsWith("harness:")
        ? targetSessionId
        : `harness:${targetSessionId}`;
  const effectiveCwd = snapshot.botCwd || workspaceSnap?.cwd || "";
  const canAttach = targetSessionFile !== null && effectiveCwd !== "";

  const retained = useSessionHandle(
    canAttach ? targetSessionFile : null,
    canAttach ? { isolated: false, autoStart: false, cwd: effectiveCwd } : undefined,
  );

  useEffect(() => () => setHoveredHeroTaskPreview(null), []);

  const dispatchTaskPrompt = (promptText: string) => {
    setHoveredHeroTaskPreview(null);
    if (retained.handle !== null && rpcSnap?.hostStatus === "connected") {
      void retained.handle.sendMessage(promptText, []).catch(() => {
        patchBotUi({ activeView: "chat", composerDraft: promptText });
      });
      return;
    }
    patchBotUi({ activeView: "chat", composerDraft: promptText });
  };

  const firstApproval = snapshot.pendingApprovals[0];
  const unreadInboxCount = snapshot.inboxItems.filter((item) => item.unread).length;

  const capsules: readonly HeroStarterCapsuleSpec[] = [
    {
      id: "patrol",
      testId: "hero-task-patrol",
      labelZh: "巡检工作区",
      Icon: Activity,
      preview: {
        id: "patrol",
        expression: "patrol",
        action: "scan",
        badgeLabelZh: "准备执行 · 主动巡检",
        speechText: "现在扫描工作区变更、待办与环境健康吗？",
      },
      onTrigger: () => {
        setHoveredHeroTaskPreview(null);
        void ctrl.runPatrolNow();
      },
    },
    {
      id: "goals",
      testId: "hero-task-goals",
      labelZh: "梳理今日目标",
      Icon: Target,
      preview: {
        id: "goals",
        expression: "curious",
        action: "nod",
        badgeLabelZh: "准备规划 · 今日目标",
        speechText: "结合当前项目与记忆，帮你排好今天优先级",
      },
      onTrigger: () => dispatchTaskPrompt(CO_PILOT_TASK_PROMPTS.planGoals),
    },
    {
      id: "briefing",
      testId: "hero-task-briefing",
      labelZh: "汇总未读简报",
      Icon: Inbox,
      ...(unreadInboxCount > 0 ? { countSuffix: unreadInboxCount } : {}),
      preview: {
        id: "briefing",
        expression: "happy",
        action: "wave",
        badgeLabelZh: "准备浓缩 · 动态简报",
        speechText: "替你浓缩最新动态简报与收件箱重点",
      },
      onTrigger: () => dispatchTaskPrompt(CO_PILOT_TASK_PROMPTS.summarizeBriefing),
    },
    {
      id: "audit",
      testId: "hero-task-audit",
      labelZh: "检查仓库改动",
      Icon: Terminal,
      preview: {
        id: "audit",
        expression: "focused",
        action: "think",
        badgeLabelZh: "准备核查 · 代码体检",
        speechText: "检查当前仓库改动、潜在问题与容器状态",
      },
      onTrigger: () => dispatchTaskPrompt(CO_PILOT_TASK_PROMPTS.auditWorkspace),
    },
  ];

  return (
    <div className="qj-hero-task-deck" data-testid="bot-hero-task-deck">
      {firstApproval !== undefined && (
        <div
          className="qj-hero-status-callout warning"
          data-testid="hero-task-status-callout"
          data-tone="warning"
        >
          <div className="qj-hero-status-left">
            <span className="qj-companion-task-dot warning" aria-hidden="true" />
            <span className="qj-hero-status-text">
              待你拍板：{firstApproval.title}
              {snapshot.pendingApprovals.length > 1 ? (
                <span className="qj-tabular">{` 等 ${snapshot.pendingApprovals.length} 项`}</span>
              ) : null}
            </span>
          </div>
          <div className="qj-hero-status-actions">
            <button
              type="button"
              data-testid="hero-approve-first-btn"
              className="qj-hero-status-btn primary"
              onClick={() => void ctrl.resolveApproval(firstApproval.id, "approved")}
            >
              批准执行
            </button>
            <button
              type="button"
              className="qj-hero-status-btn"
              onClick={() => patchBotUi({ rightPanelOpen: true, rightTab: "approvals" })}
            >
              查看详情
            </button>
          </div>
        </div>
      )}

      <div className="qj-hero-starter-row" data-testid="hero-task-grid">
        {capsules.map(({ id, testId, labelZh, Icon, countSuffix, preview, onTrigger }) => (
          <button
            key={id}
            type="button"
            data-testid={testId}
            className="qj-hero-starter-capsule"
            onMouseEnter={() => setHoveredHeroTaskPreview(preview)}
            onMouseLeave={() => setHoveredHeroTaskPreview(null)}
            onFocus={() => setHoveredHeroTaskPreview(preview)}
            onBlur={() => setHoveredHeroTaskPreview(null)}
            onClick={onTrigger}
          >
            <Icon size={14} strokeWidth={1.75} className="qj-hero-starter-icon" aria-hidden="true" />
            <span>{labelZh}</span>
            {countSuffix !== undefined && (
              <span className="qj-hero-starter-count qj-tabular">{countSuffix}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
