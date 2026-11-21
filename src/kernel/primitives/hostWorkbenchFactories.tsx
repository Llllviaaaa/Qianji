/**
 * Host-owned production workbench & feature-plugin UI factories
 * (`src/kernel/primitives/hostWorkbenchFactories.tsx`, ADR 0023).
 *
 * Bridges Qianji's full-featured production workbench views (`TerminalPanel`,
 * `WorkbenchContextCard` + plan/subagent/diagnostics, `ReviewDiffTab`,
 * `BrowserPreviewTab`, and `DiagramBlock`) into built-in plugins via
 * `renderFactory(...)` while keeping every slot 100% overridable.
 */
import { createElement, useCallback, type PointerEvent as ReactPointerEvent, type ReactElement, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Circle, Clock } from "lucide-react";
import type { PlanGetResult } from "@qianji/protocol";
import type {
  ClientSlotsService,
  SlotComponentProps,
  SlotFactorySpec,
  SlotRegistry,
} from "@qianji/client-slots";
import { DiagramBlock as HostDiagramBlock, type DiagramKind } from "../../components/DiagramBlock";
import { BrowserPreviewTab as HostBrowserPreviewTab } from "../../components/workbench/BrowserPreviewTab";
import { ReviewDiffTab as HostReviewDiffTab } from "../../components/workbench/ReviewDiffTab";
import { TerminalPanel as HostTerminalPanel } from "../../components/workbench/TerminalPanel";
import { WorkbenchContextCard } from "../../components/workbench/WorkbenchContextCard";
import { agent } from "../../lib/agent";
import type { CodeReviewScope } from "../../lib/codeReview";
import { deriveSubagentActivities, deriveTaskPlan } from "../../lib/envSources";
import { describeError } from "../../lib/errors";
import {
  HARNESS_SESSION_PREFIX,
  harnessRuntimes,
  isHarnessSessionFile,
  isRpcMethodNotFound,
} from "../../lib/harnessRuntime";
import { useAppStore } from "../../store";

const HOST_FACTORIES_PLUGIN_ID = "core-host-factories";

export interface HostTerminalFactoryProps {
  readonly cwd: string;
  readonly visible?: boolean;
  readonly compactHeader?: boolean;
}

export interface HostInspectorSectionFactoryProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
}

export interface HostReviewFactoryProps {
  readonly cwd?: string;
}

export interface HostWebPreviewFactoryProps {
  readonly cwd?: string;
  readonly paneControls?: ReactNode;
  readonly onHeaderPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
}

export interface HostDiagramBlockFactoryProps {
  readonly kind: DiagramKind;
  readonly source: string;
}

declare module "@qianji/client-slots" {
  interface SlotFactoryMap {
    "host.workbench.terminal": SlotFactorySpec<HostTerminalFactoryProps, "root">;
    "host.workbench.inspector.context": SlotFactorySpec<HostInspectorSectionFactoryProps, "root">;
    "host.workbench.inspector.diagnostics": SlotFactorySpec<HostInspectorSectionFactoryProps, "root">;
    "host.workbench.review": SlotFactorySpec<HostReviewFactoryProps, "root">;
    "host.workbench.webPreview": SlotFactorySpec<HostWebPreviewFactoryProps, "root">;
    "host.diagram.block": SlotFactorySpec<HostDiagramBlockFactoryProps, "root">;
  }
}

function HostTerminalFactory({
  cwd,
  visible = true,
  compactHeader = false,
}: SlotComponentProps<HostTerminalFactoryProps, "root">): ReactElement {
  return createElement(HostTerminalPanel, { cwd, visible, compactHeader });
}

function HostInspectorContextFactory({
  cwd: ownerCwd,
  sessionFile: ownerSessionFile,
}: SlotComponentProps<HostInspectorSectionFactoryProps, "root">): ReactElement {
  const storeCwd = useAppStore((s) => s.cwd);
  const storeSessionFile = useAppStore((s) => s.sessionFile);
  const messages = useAppStore((s) => s.messages);
  const cwd = (ownerCwd && ownerCwd.trim() !== "" ? ownerCwd : storeCwd).trim();
  const sessionFile = ownerSessionFile !== undefined ? ownerSessionFile : storeSessionFile;

  const hostSessionId =
    sessionFile !== null && isHarnessSessionFile(sessionFile)
      ? sessionFile.slice(HARNESS_SESSION_PREFIX.length)
      : undefined;

  const planQuery = useQuery({
    queryKey: ["workbench-plan", hostSessionId, messages.length],
    queryFn: async (): Promise<PlanGetResult> => {
      try {
        return await harnessRuntimes.call<PlanGetResult>("plan.get", { sessionId: hostSessionId });
      } catch (error) {
        if (isRpcMethodNotFound(error)) return { plan: { explanation: "", items: [] } };
        throw error;
      }
    },
    enabled: Boolean(hostSessionId),
    staleTime: 4_000,
  });

  const derivedPlan = deriveTaskPlan(messages);
  const rpcPlan = planQuery.data?.plan;
  const planSteps =
    rpcPlan !== undefined && rpcPlan.items.length > 0
      ? rpcPlan.items
      : (derivedPlan?.steps ?? []);
  const completedSteps = planSteps.filter((step) => step.status === "completed").length;
  const subagents = deriveSubagentActivities(messages);

  return (
    <WorkbenchContextCard cwd={cwd} sessionFile={sessionFile} mode="context">
      {(planSteps.length > 0 || subagents.length > 0) && (
        <section className="pid-wb-inspector-section" data-inspector-section="plan">
          <header className="pid-wb-inspector-head">
            <span>任务进度</span>
            {planSteps.length > 0 && (
              <span className="pid-wb-muted">
                {completedSteps}/{planSteps.length}
              </span>
            )}
          </header>
          {planSteps.length > 0 && (
            <ul className="pid-wb-plan-list">
              {planSteps.map((step) => (
                <li key={step.id} className={`pid-wb-plan-item status-${step.status}`}>
                  {step.status === "completed" ? (
                    <CheckCircle2 size={13} className="pid-wb-plan-icon done" />
                  ) : step.status === "in_progress" ? (
                    <Clock size={13} className="pid-wb-plan-icon active" />
                  ) : (
                    <Circle size={13} className="pid-wb-plan-icon" />
                  )}
                  <span>{step.text}</span>
                </li>
              ))}
            </ul>
          )}
          {subagents.length > 0 && (
            <ul className="pid-wb-inspector-list">
              {subagents.map((item) => (
                <li key={item.id} className="pid-wb-connector-row">
                  <span
                    className={`pid-wb-status-dot ${
                      item.status === "completed"
                        ? "online"
                        : item.status === "failed"
                          ? "offline"
                          : "running"
                    }`}
                  />
                  <span className="pid-wb-connector-name">{item.label}</span>
                  <span className="pid-wb-muted">{item.role}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </WorkbenchContextCard>
  );
}

function HostInspectorDiagnosticsFactory({
  cwd: ownerCwd,
  sessionFile: ownerSessionFile,
}: SlotComponentProps<HostInspectorSectionFactoryProps, "root">): ReactElement {
  const storeCwd = useAppStore((s) => s.cwd);
  const storeSessionFile = useAppStore((s) => s.sessionFile);
  const cwd = (ownerCwd && ownerCwd.trim() !== "" ? ownerCwd : storeCwd).trim();
  const sessionFile = ownerSessionFile !== undefined ? ownerSessionFile : storeSessionFile;
  return createElement(WorkbenchContextCard, { cwd, sessionFile, mode: "diagnostics" });
}

function HostReviewFactory({
  cwd: ownerCwd,
  ctx,
}: SlotComponentProps<HostReviewFactoryProps, "root">): ReactElement {
  const storeCwd = useAppStore((s) => s.cwd);
  const git = useAppStore((s) => s.git);
  const settings = useAppStore((s) => s.settings);
  const workspaceCwd = (ownerCwd && ownerCwd.trim() !== "" ? ownerCwd : storeCwd).trim();

  const onRefreshGit = useCallback(async () => {
    const ws = ctx?.get("workspaceService");
    if (ws !== undefined) {
      await ws.refreshGit(workspaceCwd || undefined);
    } else {
      await useAppStore.getState().refreshGit();
    }
  }, [ctx, workspaceCwd]);

  const onRestoreFiles = useCallback(
    async (paths?: string[]) => {
      const snapshot = useAppStore.getState().git;
      if (workspaceCwd === "" || snapshot === null || snapshot.files.length === 0) return;
      const targets = paths !== undefined && paths.length > 0 ? paths : snapshot.files.map((f) => f.path);
      if (targets.length === 0) return;
      const label = targets.length === 1 ? targets[0] : `${targets.length} 个文件`;
      if (typeof window !== "undefined" && !window.confirm(`撤销对 ${label} 的本地更改？未提交的改动将丢失。`)) {
        return;
      }
      try {
        await agent.gitRestoreFiles(workspaceCwd, targets);
        await onRefreshGit();
        useAppStore.getState().showToast("已撤销本地更改", "info");
      } catch (error) {
        useAppStore.getState().showToast(describeError(error), "error");
      }
    },
    [onRefreshGit, workspaceCwd],
  );

  const onRequestReview = useCallback(
    (target: CodeReviewScope = { mode: "uncommitted" }) => {
      void (async () => {
        if (settings?.reviewDelivery === "detached") {
          const current = useAppStore.getState();
          const wsTarget = current.cwd || workspaceCwd;
          current.prepareNewTask();
          if (wsTarget !== "") await useAppStore.getState().connect(wsTarget);
        }
        const scope =
          target.mode === "base-branch"
            ? `审查当前分支相对于基线分支 ${target.baseBranch} 的代码更改。先运行 git merge-base HEAD ${target.baseBranch}，再检查从合并基点到 HEAD 的差异。`
            : "审查当前未提交的代码更改，包括已暂存、未暂存和未跟踪文件。";
        const sent = await useAppStore.getState().sendMessage(
          [
            scope,
            "只报告由这些更改引入、作者明确会修复的离散问题，重点检查正确性、回归风险、安全性和缺失测试；按严重程度列出发现。没有可操作问题时请直接说明。",
            "需要定位到具体改动行的意见，请另起一行输出 ::code-comment{title=\"[P1] 简短标题\" body=\"问题、触发场景和修复方向\" file=\"相对或绝对文件路径\" start=行号 end=行号 priority=1}。正文保持普通 Markdown，不要输出 JSON。",
          ].join("\n\n"),
        );
        if (sent) {
          ctx?.get("navigationService")?.setDraftMode(false);
        }
      })();
    },
    [ctx, settings?.reviewDelivery, workspaceCwd],
  );

  return createElement(HostReviewDiffTab, {
    cwd: workspaceCwd,
    git,
    onRefreshGit,
    onRestoreFiles,
    onRequestReview,
  });
}

function HostWebPreviewFactory({
  cwd = "",
  paneControls,
  onHeaderPointerDown,
}: SlotComponentProps<HostWebPreviewFactoryProps, "root">): ReactElement {
  return createElement(HostBrowserPreviewTab, {
    cwd,
    ...(paneControls === undefined ? {} : { paneControls }),
    ...(onHeaderPointerDown === undefined ? {} : { onHeaderPointerDown }),
  });
}

function HostDiagramBlockFactory({
  kind,
  source,
}: SlotComponentProps<HostDiagramBlockFactoryProps, "root">): ReactElement {
  return createElement(HostDiagramBlock, { kind, source });
}

export function registerHostWorkbenchFactories(
  target: Pick<SlotRegistry, "registerFactory"> | Pick<ClientSlotsService, "registerFactory">,
): Array<() => void> {
  return [
    target.registerFactory("host.workbench.terminal", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:workbench-terminal`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostTerminalFactory,
    }),
    target.registerFactory("host.workbench.inspector.context", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:workbench-inspector-context`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostInspectorContextFactory,
    }),
    target.registerFactory("host.workbench.inspector.diagnostics", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:workbench-inspector-diagnostics`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostInspectorDiagnosticsFactory,
    }),
    target.registerFactory("host.workbench.review", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:workbench-review`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostReviewFactory,
    }),
    target.registerFactory("host.workbench.webPreview", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:workbench-web-preview`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostWebPreviewFactory,
    }),
    target.registerFactory("host.diagram.block", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:diagram-block`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostDiagramBlockFactory,
    }),
  ];
}
