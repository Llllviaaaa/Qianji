/**
 * Built-in `swarm` Cordis Feature Plugin (`src/builtin-plugins/swarm/index.ts`).
 *
 * Pure Session-Scoped Architecture:
 * - Right Workbench `"swarm"` Pane (`workbench.panes`, `key: "swarm"`) — NEVER hijacks `hub.pages`!
 * - Zero Shell Chrome Clutter: NO `sidebar.nav`, `sidebar.sessionRow`, `composer.toolbar`,
 *   `workbench.topbarControls`, `conversation.header`, `shell.statusbar`, or `composer.status`.
 * - Session-scoped entry points ONLY:
 *   1) `SwarmLiveCapsule` (`conversation.turnFooter`) + `SwarmToolCallCard` (`conversation.toolCall`)
 *   2) `SwarmInspectorSummarySection` (`workbench.inspector.sections`, `order: 15`)
 *   3) `SwarmSettingsModelsSection` (`settings.sections`) + `SwarmRoleModelsModal` (`shell.modals`)
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import {
  SWARM_RPC_METHODS, SWARM_RPC_NOTIFICATIONS,
  type SwarmAlertNotification, type SwarmBoardNotification, type SwarmConfigUpdatedNotification,
  type SwarmCreateResult, type SwarmMemberDeltaNotification, type SwarmOpenNotification, type SwarmUpdatedNotification,
} from "@qianji/protocol";
import { SwarmLiveCapsule, SwarmToolCallCard, SwarmTurnFooterCard } from "./SwarmConversationCards";
import { SwarmHoneycombHexCanvas, SwarmMentionsChordCanvas } from "./SwarmHiveCanvases";
import { SwarmHiveGraphTab } from "./SwarmHiveGraphTab";
import { SwarmInspectorSummarySection } from "./SwarmInspectorSummarySection";
import { SwarmMemberDetailView } from "./SwarmMemberDetailView";
import { SwarmMembersTab } from "./SwarmMembersTab";
import { SwarmMessageBoard } from "./SwarmMessageBoard";
import { SwarmOverviewTab } from "./SwarmOverviewTab";
import { getBeeAccentColor, SwarmBeeCluster, SwarmPixelBee, SwarmPixelBeeSvgNode } from "./SwarmPixelBee";
import {
  SwarmRoleModelsConfigurator, SwarmRoleModelsModal, SwarmSettingsModelsSection,
} from "./SwarmRoleModelsConfig";
import {
  applySwarmAlertNotification, applySwarmBoardNotification, applySwarmConfigPayload,
  applySwarmConfigUpdatedNotification, applySwarmListResult, applySwarmMemberDeltaNotification,
  applySwarmSnapshot, applySwarmUpdatedNotification, applyWorktreeDiff, deriveOutcomeOverview,
  findSwarmSummaryForSession, INITIAL_SWARM_DATA_STATE, INITIAL_SWARM_UI_STATE, jumpToBoardSeq,
  normalizeBareSessionId, patchSwarmUi, resetSwarmStores, selectSwarmMember, swarmDataStore,
  swarmUiStore, useSwarmData, useSwarmUi,
} from "./swarmStore";
import { openSwarmAuxPane, SWARM_WORKBENCH_PANE_ID, SwarmWorkbenchPane } from "./SwarmWorkbenchPane";
import { syncSwarmsFromRpc, useSwarmController } from "./useSwarmController";

export const SWARM_PLUGIN_ID = "swarm";

export {
  applySwarmAlertNotification, applySwarmBoardNotification, applySwarmConfigPayload,
  applySwarmConfigUpdatedNotification, applySwarmListResult, applySwarmMemberDeltaNotification,
  applySwarmSnapshot, applySwarmUpdatedNotification, applyWorktreeDiff, deriveOutcomeOverview,
  getBeeAccentColor, INITIAL_SWARM_DATA_STATE, INITIAL_SWARM_UI_STATE, jumpToBoardSeq,
  openSwarmAuxPane, patchSwarmUi, resetSwarmStores, selectSwarmMember, SWARM_WORKBENCH_PANE_ID, SwarmBeeCluster,
  swarmDataStore, SwarmHiveGraphTab, SwarmHoneycombHexCanvas,
  SwarmInspectorSummarySection, SwarmLiveCapsule, SwarmMemberDetailView, SwarmMembersTab,
  SwarmMentionsChordCanvas, SwarmMessageBoard, SwarmOverviewTab,
  SwarmPixelBee, SwarmPixelBeeSvgNode, SwarmRoleModelsConfigurator, SwarmRoleModelsModal,
  SwarmSettingsModelsSection, SwarmToolCallCard, SwarmTurnFooterCard,
  swarmUiStore, SwarmWorkbenchPane, syncSwarmsFromRpc, useSwarmController, useSwarmData, useSwarmUi,
};

export const swarmBuiltinPlugin: Plugin.Object = {
  name: SWARM_PLUGIN_ID,
  inject: [
    "slots", "sessionService", "workspaceService", "composerService",
    "workbenchService", "navigationService", "rpcService",
  ],
  apply(ctx: Context): void {
    // 1. Right "摘要" (`workbench.inspector.sections`, order: 15) Entry
    ctx.slots.register("workbench.inspector.sections", {
      id: `${SWARM_PLUGIN_ID}:inspector-summary`,
      pluginId: SWARM_PLUGIN_ID,
      tier: "builtin",
      order: 15,
      component: SwarmInspectorSummarySection,
    });

    // 2. Single Calm Right Aux Pane (`workbench.panes`, key: "swarm") — NO `hub.pages`!
    ctx.slots.register("workbench.panes", {
      id: `${SWARM_PLUGIN_ID}:pane`,
      pluginId: SWARM_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      key: SWARM_WORKBENCH_PANE_ID,
      component: SwarmWorkbenchPane,
    });

    // 3. 6-Role Swarm Model Configuration (`设置 -> 模型与密钥` + In-Session Modal)
    ctx.slots.register("settings.sections", {
      id: `${SWARM_PLUGIN_ID}:role-models`,
      pluginId: SWARM_PLUGIN_ID,
      tier: "builtin",
      order: 30,
      component: SwarmSettingsModelsSection,
    });

    ctx.slots.register("shell.modals", {
      id: `${SWARM_PLUGIN_ID}:role-models-modal`,
      pluginId: SWARM_PLUGIN_ID,
      tier: "builtin",
      order: 30,
      component: SwarmRoleModelsModal,
    });

    // 4. Inline `SwarmLiveCapsule` (`conversation.turnFooter`) + `SwarmToolCallCard` (`conversation.toolCall`)
    ctx.slots.register("conversation.toolCall", {
      id: `${SWARM_PLUGIN_ID}:tool-call`,
      pluginId: SWARM_PLUGIN_ID,
      tier: "builtin",
      priority: 10,
      key: ["swarm", "swarm_*", "post_message", "read_board", "swarm_wait"],
      component: SwarmToolCallCard,
    });

    ctx.slots.register("conversation.turnFooter", {
      id: `${SWARM_PLUGIN_ID}:turn-footer`,
      pluginId: SWARM_PLUGIN_ID,
      tier: "builtin",
      order: 20,
      component: SwarmLiveCapsule,
    });

    // 5. `/swarm` Slash UI Shortcuts (`ui` | `overview` | `board` | `members` | `hive` | `graph`)
    ctx.composerService.registerSlashInterceptor({
      id: `${SWARM_PLUGIN_ID}:slash-ui`,
      pluginId: SWARM_PLUGIN_ID,
      onSlashCommand: (name, rawArgs) => {
        if (name !== "swarm") return false;
        const sub = rawArgs.trim().toLowerCase();
        if (sub === "ui" || sub === "overview" || sub === "board" || sub === "members" || sub === "hive" || sub === "graph") {
          const targetTab =
            sub === "board" ? "board"
            : sub === "members" ? "members"
            : sub === "hive" || sub === "graph" ? "hive"
            : "overview";
          patchSwarmUi({ workbenchTab: targetTab, selectedMemberName: null });
          openSwarmAuxPane(ctx.workbenchService);
          return true;
        }
        return false;
      },
    });

    // 6. Automatic Session-Switch Isolation & Auto-Close
    const collectKnownSessionIds = (): Set<string> => {
      const ids = new Set<string>();
      for (const item of ctx.sessionService.getSnapshot().sessions) {
        const sId = normalizeBareSessionId(item.sessionId);
        const sFile = normalizeBareSessionId(item.file);
        if (sId !== "") ids.add(sId);
        if (sFile !== "") ids.add(sFile);
      }
      return ids;
    };

    let prevNormId = normalizeBareSessionId(ctx.sessionService.getSnapshot().sessionId);
    let prevNormFile = normalizeBareSessionId(ctx.sessionService.getSnapshot().sessionFile);
    let prevKnownSessionIds = collectKnownSessionIds();

    ctx.sessionService.subscribe(() => {
      const snap = ctx.sessionService.getSnapshot();
      const normId = normalizeBareSessionId(snap.sessionId);
      const normFile = normalizeBareSessionId(snap.sessionFile);
      if (normId === prevNormId && normFile === prevNormFile) {
        prevKnownSessionIds = collectKnownSessionIds();
        return;
      }

      const wasDraft = prevNormId === "" && prevNormFile === "";
      const existedPreviously =
        (normId !== "" && prevKnownSessionIds.has(normId)) ||
        (normFile !== "" && prevKnownSessionIds.has(normFile));
      prevNormId = normId;
      prevNormFile = normFile;
      prevKnownSessionIds = collectKnownSessionIds();

      const ui = swarmUiStore.get();
      const bound = findSwarmSummaryForSession(swarmDataStore.get().summaries, snap.sessionId, snap.sessionFile);
      if (bound !== undefined) {
        patchSwarmUi({
          activeSwarmId: bound.run.id, pendingDraftSwarm: false,
          pendingDraftSwarmId: null, pendingAdoptingSessionId: null, selectedMemberName: null,
        });
        return;
      }

      if (wasDraft && (normId !== "" || normFile !== "") && !existedPreviously && (ui.pendingDraftSwarm || ui.pendingDraftSwarmId !== null)) {
        const targetId = normId || normFile;
        patchSwarmUi({ pendingAdoptingSessionId: targetId });
        if (ui.pendingDraftSwarmId === null) {
          void ctx.rpcService
            .call<SwarmCreateResult>(SWARM_RPC_METHODS.create, {
              goal: "多智能体蜂群协作会话", title: "蜂群协作",
              cwd: snap.cwd || ctx.workspaceService.getSnapshot().cwd, coordinatorSessionId: targetId,
            })
            .then((created) => { if (created && created.run) applySwarmSnapshot(created); })
            .catch(() => undefined);
        } else {
          void syncSwarmsFromRpc(ctx, { cwd: snap.cwd, sessionId: targetId, targetSwarmId: ui.pendingDraftSwarmId });
        }
        return;
      }

      patchSwarmUi({
        activeSwarmId: null, pendingDraftSwarm: false, pendingDraftSwarmId: null,
        pendingAdoptingSessionId: null, selectedMemberName: null, roleModelsModalOpen: false,
      });
      if (ctx.workbenchService.getSnapshot().openPanes.includes(SWARM_WORKBENCH_PANE_ID)) {
        ctx.workbenchService.closePane(SWARM_WORKBENCH_PANE_ID);
      }
    });

    // 7. Live Host Push Notification Subscriptions & Initial Sync
    void syncSwarmsFromRpc(ctx);
    ctx.rpcService.onReconnect(() => void syncSwarmsFromRpc(ctx));

    let lastCwd = ctx.workspaceService.getSnapshot().cwd;
    ctx.workspaceService.subscribe(() => {
      const nextCwd = ctx.workspaceService.getSnapshot().cwd;
      if (nextCwd !== lastCwd) {
        lastCwd = nextCwd;
        void syncSwarmsFromRpc(ctx, { cwd: nextCwd });
      }
    });

    ctx.rpcService.onNotification<SwarmUpdatedNotification>(SWARM_RPC_NOTIFICATIONS.updated, applySwarmUpdatedNotification);
    ctx.rpcService.onNotification<SwarmBoardNotification>(SWARM_RPC_NOTIFICATIONS.board, applySwarmBoardNotification);
    ctx.rpcService.onNotification<SwarmMemberDeltaNotification>(SWARM_RPC_NOTIFICATIONS.memberDelta, applySwarmMemberDeltaNotification);
    ctx.rpcService.onNotification<SwarmConfigUpdatedNotification>(SWARM_RPC_NOTIFICATIONS.configUpdated, applySwarmConfigUpdatedNotification);
    ctx.rpcService.onNotification<SwarmAlertNotification>(SWARM_RPC_NOTIFICATIONS.alert, (payload) => {
      applySwarmAlertNotification(payload);
      if (payload?.alert && !payload.alert.resolved && typeof window !== "undefined") {
        ctx.navigationService.showToast(
          `[蜂群告警] ${payload.alert.message}`,
          payload.alert.severity === "danger" ? "error" : "warning",
        );
      }
    });
    ctx.rpcService.onNotification<SwarmOpenNotification>(SWARM_RPC_NOTIFICATIONS.open, (payload) => {
      if (payload?.swarmId !== undefined && payload.swarmId !== "") patchSwarmUi({ activeSwarmId: payload.swarmId });
      void syncSwarmsFromRpc(ctx, {
        ...(payload?.cwd !== undefined ? { cwd: payload.cwd } : {}),
        ...(payload?.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
        ...(payload?.swarmId !== undefined ? { targetSwarmId: payload.swarmId } : {}),
      });
      openSwarmAuxPane(ctx.workbenchService);
    });
  },
};

export default swarmBuiltinPlugin;
