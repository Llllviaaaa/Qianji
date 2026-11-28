/**
 * Right Workbench Session-Scoped Swarm Pane (`src/builtin-plugins/swarm/SwarmWorkbenchPane.tsx`).
 *
 * Registered on `workbench.panes` (`key: "swarm"`):
 * - Eliminates double-header collision beneath host `.pid-wb-pane-header` (`蜂群`):
 *   renders ONE sleek 38px Unified Workbench Navigation Bar:
 *   - Left: Crisp tab strip (`总览` | `消息板` + tabular count | `成员` + live count | `蜂巢`)
 *   - Right: Quiet live status capsule (`● 运行中` / `已暂停` / `已完成`) + Pause/Play + `角色模型`
 * - Swarm Title & Goal breathe inside `总览`'s Editorial Masthead.
 */
import { useMemo, type ReactElement } from "react";
import { Pause, Play, SlidersHorizontal } from "lucide-react";
import { useSessionState } from "@qianji/client";
import { Button, IconButton } from "@qianji/client-primitives";
import type {
  SlotComponentProps,
  WorkbenchPaneSlotProps,
} from "@qianji/client-slots";
import { SwarmHiveGraphTab } from "./SwarmHiveGraphTab";
import { RUN_STATUS_LABELS } from "./swarmLabels";
import { SwarmMemberDetailView } from "./SwarmMemberDetailView";
import { SwarmMembersTab } from "./SwarmMembersTab";
import { SwarmMessageBoard } from "./SwarmMessageBoard";
import { SwarmOverviewTab } from "./SwarmOverviewTab";
import { SwarmPixelBee } from "./SwarmPixelBee";
import {
  patchSwarmUi,
  resolveActiveSwarmSnapshot,
  swarmChannelKey,
  useSwarmData,
  useSwarmUi,
  type SwarmWorkbenchTab,
} from "./swarmStore";
import { useSwarmController } from "./useSwarmController";

export const SWARM_WORKBENCH_PANE_ID = "swarm";

export interface SwarmWorkbenchOpener {
  setRightOpen(open: boolean): void;
  openPane(paneId: string): void;
  activateExtensionPane?(paneId: string): void;
  setInspectorOpen?(open: boolean): void;
}

export function openSwarmAuxPane(workbenchService: SwarmWorkbenchOpener | undefined): void {
  if (workbenchService === undefined) return;
  workbenchService.setRightOpen(true);
  if (typeof workbenchService.activateExtensionPane === "function") {
    workbenchService.activateExtensionPane(SWARM_WORKBENCH_PANE_ID);
    workbenchService.setInspectorOpen?.(false);
  } else {
    workbenchService.openPane(SWARM_WORKBENCH_PANE_ID);
  }
}

export function SwarmWorkbenchPane({
  sessionFile: propSessionFile,
  active,
  renderFactory,
  ctx,
}: SlotComponentProps<WorkbenchPaneSlotProps, "session-maybe">): ReactElement {
  const data = useSwarmData();
  const ui = useSwarmUi();
  const sessionSnap = useSessionState(ctx);
  const controller = useSwarmController(ctx);

  const sessionId = sessionSnap?.sessionId ?? null;
  const sessionFile = propSessionFile ?? sessionSnap?.sessionFile ?? null;
  const snapshot = resolveActiveSwarmSnapshot(data, ui, sessionId, sessionFile);

  const selectedMember =
    snapshot !== null && ui.selectedMemberName !== null
      ? (snapshot.members.find((m) => m.name === ui.selectedMemberName) ?? null)
      : null;

  const boardCount = useMemo(() => {
    if (snapshot === null) return 0;
    const seqs = new Set<number>();
    for (const m of snapshot.recentMessages) seqs.add(m.seq);
    const cachedMain = data.boardBySwarmChannel[swarmChannelKey(snapshot.run.id, "main")] ?? [];
    for (const m of cachedMain) seqs.add(m.seq);
    return Math.max(snapshot.run.headSeq, seqs.size);
  }, [data.boardBySwarmChannel, snapshot]);

  const liveMemberCount = useMemo(
    () => (snapshot !== null ? snapshot.members.filter((m) => !m.killed).length : 0),
    [snapshot],
  );

  const setTab = (tab: SwarmWorkbenchTab) => {
    patchSwarmUi({ workbenchTab: tab, selectedMemberName: null });
  };

  const isRunning = snapshot?.run.status === "running";
  const isPaused = snapshot?.run.status === "paused";
  const dotStateClass =
    snapshot === null
      ? "is-waiting"
      : isRunning
        ? "is-working"
        : isPaused
          ? "is-attention"
          : "is-waiting";

  return (
    <section
      className="qj-swarm-wb-pane"
      data-feature-pane="swarm"
      data-testid="swarm-workbench-pane"
      aria-label="蜂群"
      hidden={!active}
    >
      {/* Unified 38px Workbench Navigation Bar (single bar right beneath `.pid-wb-pane-header`) */}
      <header className="qj-swarm-nav-bar" data-testid="swarm-workbench-navbar">
        {snapshot !== null ? (
          <nav className="qj-swarm-underline-tabs" role="tablist" aria-label="蜂群视图导航">
            <button
              type="button"
              role="tab"
              aria-selected={selectedMember === null && ui.workbenchTab === "overview"}
              data-testid="swarm-tab-overview"
              className={`qj-swarm-underline-tab${selectedMember === null && ui.workbenchTab === "overview" ? " active" : ""}`}
              onClick={() => setTab("overview")}
            >
              <span>总览</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={selectedMember === null && ui.workbenchTab === "board"}
              data-testid="swarm-tab-board"
              className={`qj-swarm-underline-tab${selectedMember === null && ui.workbenchTab === "board" ? " active" : ""}`}
              onClick={() => setTab("board")}
            >
              <span>消息板</span>
              {boardCount > 0 && <span className="qj-swarm-tab-count">{boardCount}</span>}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={selectedMember !== null || ui.workbenchTab === "members"}
              data-testid="swarm-tab-members"
              className={`qj-swarm-underline-tab${selectedMember !== null || ui.workbenchTab === "members" ? " active" : ""}`}
              onClick={() => setTab("members")}
            >
              <span>成员</span>
              {liveMemberCount > 0 && <span className="qj-swarm-tab-count">{liveMemberCount}</span>}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={selectedMember === null && ui.workbenchTab === "hive"}
              data-testid="swarm-tab-hive"
              className={`qj-swarm-underline-tab${selectedMember === null && ui.workbenchTab === "hive" ? " active" : ""}`}
              onClick={() => setTab("hive")}
            >
              <span>蜂巢</span>
            </button>
          </nav>
        ) : (
          <span className="qj-swarm-nav-idle-label">多智能体协同</span>
        )}

        <div className="qj-swarm-pane-actions">
          {snapshot !== null && (
            <span
              className="qj-swarm-status-capsule"
              data-status={snapshot.run.status}
              data-testid="swarm-status-capsule"
            >
              <span className={`qj-swarm-dot ${dotStateClass}`} aria-hidden="true" />
              <span>{RUN_STATUS_LABELS[snapshot.run.status]}</span>
            </span>
          )}

          {(isRunning || isPaused) && snapshot !== null && (
            <IconButton
              size="sm"
              aria-label={isPaused ? "恢复蜂群" : "暂停蜂群"}
              tooltip={isPaused ? "恢复蜂群执行" : "暂停蜂群调度"}
              disabled={ui.busyAction !== null}
              onClick={() =>
                void controller.controlRun(snapshot.run.id, isPaused ? "resume" : "pause")
              }
            >
              {isPaused ? <Play size={13} /> : <Pause size={13} />}
            </IconButton>
          )}

          <IconButton
            size="sm"
            aria-label="角色模型配置"
            tooltip="配置蜂群各角色模型"
            data-testid="swarm-pane-models-btn"
            onClick={() =>
              patchSwarmUi({
                ...(snapshot !== null ? { activeSwarmId: snapshot.run.id } : {}),
                roleModelsModalOpen: true,
                roleModelsModalScope: snapshot !== null ? "session" : "global",
              })
            }
          >
            <SlidersHorizontal size={13} />
          </IconButton>
        </div>
      </header>

      {/* Pane Body */}
      {snapshot === null ? (
        <div className="qj-swarm-wb-empty" data-testid="swarm-pane-empty">
          <SwarmPixelBee name="coordinator" isQueen state="waiting" size="lg" />
          <strong>当前会话尚未启动蜂群协作</strong>
          <p>在对话中发送 `/swarm 目标描述`，协调者将拆解任务主线并召集专职成员并行推进。</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => patchSwarmUi({ roleModelsModalOpen: true, roleModelsModalScope: "global" })}
          >
            <SlidersHorizontal size={12.5} />
            <span>预设各角色模型</span>
          </Button>
        </div>
      ) : selectedMember !== null ? (
        <SwarmMemberDetailView
          snapshot={snapshot}
          member={selectedMember}
          renderFactory={renderFactory}
          ctx={ctx}
        />
      ) : (
        <div className="qj-swarm-wb-body">
          {ui.workbenchTab === "overview" && <SwarmOverviewTab snapshot={snapshot} ctx={ctx} />}
          {ui.workbenchTab === "board" && <SwarmMessageBoard snapshot={snapshot} ctx={ctx} />}
          {ui.workbenchTab === "members" && <SwarmMembersTab snapshot={snapshot} />}
          {ui.workbenchTab === "hive" && <SwarmHiveGraphTab snapshot={snapshot} />}
        </div>
      )}
    </section>
  );
}
