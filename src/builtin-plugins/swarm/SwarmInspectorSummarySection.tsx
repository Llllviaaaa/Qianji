/**
 * Swarm Summary Entry Section inside Right Workbench Inspector ("摘要")
 * (`src/builtin-plugins/swarm/SwarmInspectorSummarySection.tsx`).
 *
 * Registered on `workbench.inspector.sections` (`order: 15`).
 * - Returns `null` on normal non-swarm sessions.
 * - Concentric surface card (`10px` outer, `6px` inner controls) with status capsule,
 *   `done/total` progress track, role model pills, and `查看面板` / `角色模型` actions.
 */
import type { ReactNode } from "react";
import { PanelRightOpen, SlidersHorizontal } from "lucide-react";
import { useFrontendService, useSessionState } from "@qianji/client";
import { Button, IconButton } from "@qianji/client-primitives";
import type {
  SlotComponentProps,
  WorkbenchSlotBaseProps,
} from "@qianji/client-slots";
import type { SwarmMemberRole, SwarmRoleModelConfig } from "@qianji/protocol";
import { RUN_STATUS_LABELS, SWARM_ROLE_SPECS } from "./swarmLabels";
import {
  deriveOutcomeOverview,
  isSwarmEnabledForSession,
  patchSwarmUi,
  resolveSessionSwarmSummary,
  useSwarmData,
  useSwarmUi,
} from "./swarmStore";
import { openSwarmAuxPane } from "./SwarmWorkbenchPane";

function formatShortModelLabel(cfg: SwarmRoleModelConfig): string {
  const shortModel = cfg.model.split("/").pop() ?? cfg.model;
  return cfg.effort ? `${shortModel} (${cfg.effort})` : shortModel;
}

export function SwarmInspectorSummarySection({
  sessionFile: propSessionFile,
  sessionId: propSessionId,
  ctx,
}: SlotComponentProps<WorkbenchSlotBaseProps, "session-maybe">): ReactNode {
  const data = useSwarmData();
  const ui = useSwarmUi();
  const sessionSnap = useSessionState(ctx);
  const workbenchService = useFrontendService("workbenchService", ctx);

  const effectiveSessionId = propSessionId ?? sessionSnap?.sessionId ?? null;
  const effectiveSessionFile =
    propSessionFile !== undefined ? propSessionFile : (sessionSnap?.sessionFile ?? null);

  if (!isSwarmEnabledForSession(data, ui, effectiveSessionId, effectiveSessionFile)) {
    return null;
  }

  const summary = resolveSessionSwarmSummary(
    data,
    ui,
    effectiveSessionId,
    effectiveSessionFile,
  );
  const swarmId = summary?.run.id ?? ui.pendingDraftSwarmId;
  const snap = swarmId !== null ? data.snapshotsById[swarmId] : undefined;
  const overview = snap !== undefined ? deriveOutcomeOverview(snap) : null;

  const done = overview !== null ? overview.doneCount : (summary?.taskCounts.completed ?? 0);
  const total = overview !== null ? overview.totalCount : (summary?.taskCounts.total ?? 0);
  const completedPct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  const sessionOverrides: Partial<Record<SwarmMemberRole, SwarmRoleModelConfig>> =
    (swarmId !== null ? data.sessionRoleOverridesBySwarmId[swarmId] : undefined) ??
    summary?.run.roleModels ??
    {};

  const configuredRolePills = SWARM_ROLE_SPECS.flatMap((spec) => {
    const picked =
      sessionOverrides[spec.role] ??
      data.globalModelConfig.roleModels[spec.role] ??
      (spec.role !== "coordinator" ? (data.globalModelConfig.defaultWorkerModel ?? undefined) : undefined);
    if (!picked || picked.model.trim() === "") return [];
    return [{ role: spec.role, label: `${spec.shortLabel}: ${formatShortModelLabel(picked)}` }];
  });

  const openRoleModelsModal = () => {
    patchSwarmUi({
      ...(swarmId !== null ? { activeSwarmId: swarmId } : {}),
      roleModelsModalOpen: true,
      roleModelsModalScope: swarmId !== null ? "session" : "global",
    });
  };

  const handleOpenSwarmPane = () => {
    if (swarmId !== null) {
      patchSwarmUi({ activeSwarmId: swarmId });
    }
    openSwarmAuxPane(workbenchService);
  };

  const statusDotClass =
    summary === undefined
      ? "is-draft"
      : summary.run.status === "running"
        ? "is-working"
        : summary.run.status === "paused"
          ? "is-attention"
          : "is-waiting";

  return (
    <section
      className="pid-wb-inspector-section qj-swarm-inspector-summary"
      data-inspector-section="swarm"
      data-testid="swarm-inspector-summary"
    >
      <header className="pid-wb-inspector-head qj-swarm-summary-head">
        <span className="qj-swarm-summary-heading">
          <span className={`qj-swarm-dot ${statusDotClass}`} aria-hidden="true" />
          <span>蜂群协作</span>
          <span className="qj-swarm-summary-state">
            {summary !== undefined ? RUN_STATUS_LABELS[summary.run.status] : "待启动"}
          </span>
        </span>

        <IconButton
          size="sm"
          aria-label="角色模型"
          tooltip="配置蜂群各角色模型"
          data-testid="swarm-summary-models-btn"
          onClick={openRoleModelsModal}
        >
          <SlidersHorizontal size={12.5} />
        </IconButton>
      </header>

      {summary !== undefined ? (
        <div className="qj-swarm-summary-body">
          <div className="qj-swarm-summary-title-row">
            <strong className="qj-swarm-summary-title" title={summary.run.title}>
              {summary.run.title || "多智能体蜂群协作"}
            </strong>
            <span className="qj-swarm-summary-fraction">
              {done}/{total}
            </span>
          </div>

          <div className="qj-swarm-summary-track" aria-hidden="true">
            <div className="qj-swarm-summary-fill" style={{ width: `${completedPct}%` }} />
          </div>
        </div>
      ) : (
        <p className="pid-wb-inspector-empty qj-swarm-summary-draft-hint">
          发送指令后将由协调者分析仓库结构并按职责派生专职成员。
        </p>
      )}

      {configuredRolePills.length > 0 && (
        <div className="qj-swarm-summary-roles" data-testid="swarm-summary-role-pills">
          {configuredRolePills.map((item) => (
            <span key={item.role} className="qj-swarm-role-pill">
              {item.label}
            </span>
          ))}
        </div>
      )}

      <div className="qj-swarm-summary-actions">
        <Button
          variant="secondary"
          size="sm"
          data-testid="swarm-open-pane-btn"
          onClick={handleOpenSwarmPane}
        >
          <PanelRightOpen size={12.5} />
          <span>查看面板</span>
        </Button>
      </div>
    </section>
  );
}
