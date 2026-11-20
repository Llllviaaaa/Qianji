/**
 * Built-in inspector sections registered onto `workbench.inspector.sections`
 * (`env`, `context`, `outputs`, `extensions`, `diagnostics`, ADR 0023).
 *
 * Wired purely through `@qianji/client` Frontend Cordis Services and dynamic
 * `workbench.panes` discovery — zero hardcoded feature plugin gates.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  FileCode2,
  FileText,
  Folder,
  Globe,
  Layers,
  MessageSquare,
  Monitor,
  Puzzle,
  RefreshCw,
} from "lucide-react";
import type { HostInfoResult, PlanGetResult } from "@qianji/protocol";
import {
  useClientContributions,
  useFrontendService,
  useSessionState,
  useWorkbenchState,
  useWorkspaceState,
} from "@qianji/client";
import type { SlotComponentProps, WorkbenchSlotBaseProps } from "@qianji/client-slots";
import {
  deriveOutputs,
  derivePlanSteps,
  EMPTY_MESSAGES,
  splitWorkspaceDisplay,
  type DerivedPlanItem,
} from "./inspectorHelpers";
import {
  isPaneRegistered,
  listRegisteredExtensionPaneIds,
  resolvePaneTitle,
  useSlotRegistryVersion,
} from "./tilingHelpers";

function renderOutputGlyph(filePath: string): ReactElement {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "html" || ext === "htm" || ext === "svg") {
    return <Globe size={13} className="pid-wb-output-icon" />;
  }
  if (["ts", "tsx", "js", "jsx", "py", "rs", "css", "json", "vue"].includes(ext)) {
    return <FileCode2 size={13} className="pid-wb-output-icon" />;
  }
  return <FileText size={13} className="pid-wb-output-icon" />;
}

/** 1. Environment section (`env`). */
export function InspectorEnvSection({
  cwd: propCwd,
  ctx,
}: SlotComponentProps<WorkbenchSlotBaseProps, "session-maybe">): ReactElement {
  const workspace = useWorkspaceState(ctx);
  const workspaceService = useFrontendService("workspaceService", ctx);
  const cwd = propCwd ?? workspace?.cwd ?? "";
  const git = workspace?.git ?? null;
  const ws = splitWorkspaceDisplay(cwd);

  return (
    <section className="pid-wb-inspector-section" data-inspector-section="env">
      <header className="pid-wb-inspector-head">
        <span>运行环境</span>
      </header>
      <div className="pid-wb-env-rows">
        <div className="pid-wb-env-row">
          <Monitor size={13} className="pid-wb-env-icon" />
          <span>本机环境</span>
          {git?.branch !== undefined && git.branch !== "" && (
            <span className="pid-wb-env-branch">{git.branch}</span>
          )}
        </div>
        <button
          type="button"
          className="pid-wb-env-row is-folder"
          disabled={cwd === ""}
          title={cwd || "未选择工作区"}
          onClick={() => {
            if (cwd !== "") void workspaceService?.openInFileManager(cwd);
          }}
        >
          <Folder size={13} className="pid-wb-env-icon" />
          <span className="pid-wb-env-name">{ws.name}</span>
          {ws.parent !== "" && <span className="pid-wb-env-parent">{ws.parent}</span>}
        </button>
      </div>
    </section>
  );
}

/** 2. Context & task progress section (`context`). */
export function InspectorContextSection({
  cwd: propCwd,
  sessionFile: propSessionFile,
  ctx,
}: SlotComponentProps<WorkbenchSlotBaseProps, "session-maybe">): ReactElement {
  const session = useSessionState(ctx);
  const workspace = useWorkspaceState(ctx);
  const rpcService = useFrontendService("rpcService", ctx);
  const cwd = propCwd ?? workspace?.cwd ?? "";
  const sessionFile = propSessionFile !== undefined ? propSessionFile : (session?.sessionFile ?? null);
  const messages = session?.messages ?? EMPTY_MESSAGES;
  const stats = session?.stats ?? null;
  const model = session?.model ?? null;

  const [rpcPlanItems, setRpcPlanItems] = useState<readonly DerivedPlanItem[]>([]);

  const hostSessionId =
    sessionFile !== null && sessionFile.startsWith("harness://")
      ? sessionFile.slice("harness://".length)
      : session?.sessionId ?? undefined;

  const refreshPlan = useCallback(async () => {
    if (rpcService === undefined || hostSessionId === undefined || hostSessionId === "") return;
    try {
      const result = await rpcService.call<PlanGetResult>("plan.get", { sessionId: hostSessionId });
      const items = result?.plan?.items ?? [];
      setRpcPlanItems(
        items.map((item) => ({
          id: item.id,
          text: item.text,
          status: item.status === "completed" || item.status === "in_progress" ? item.status : "pending",
        })),
      );
    } catch {
      // Ignore when offline or method unavailable.
    }
  }, [hostSessionId, rpcService]);

  const contextTokens = stats?.contextUsage?.tokens ?? stats?.tokens.total ?? 0;
  const contextWindow = stats?.contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
  const rawContextPercent = stats?.contextUsage?.percent;
  const contextPct =
    typeof rawContextPercent === "number"
      ? Math.min(100, Math.max(0, Math.round(rawContextPercent)))
      : contextWindow > 0 && contextTokens > 0
        ? Math.min(100, Math.round((contextTokens / contextWindow) * 100))
        : null;
  const meterTone =
    contextPct !== null && contextPct >= 90 ? "danger" : contextPct !== null && contextPct >= 75 ? "warn" : "normal";

  const derivedSteps = useMemo(() => derivePlanSteps(messages), [messages]);
  const planSteps = rpcPlanItems.length > 0 ? rpcPlanItems : derivedSteps;
  const completedSteps = planSteps.filter((step) => step.status === "completed").length;
  const hasContextActivity = messages.length > 0 || contextTokens > 0;

  return (
    <section className="pid-wb-inspector-section" data-inspector-section="context" data-cwd={cwd}>
      <header className="pid-wb-inspector-head">
        <span>上下文</span>
        {contextPct !== null && (
          <span className={`pid-wb-inspector-metric${meterTone !== "normal" ? ` ${meterTone}` : ""}`}>
            {contextPct}%
          </span>
        )}
      </header>
      {!hasContextActivity ? (
        <p className="pid-wb-inspector-empty">发送消息后查看上下文用量。</p>
      ) : (
        <div className="pid-wb-inspector-context">
          {contextPct !== null && (
            <div className="pid-wb-progress-track" aria-hidden="true">
              <div className={`pid-wb-progress-fill tone-${meterTone}`} style={{ width: `${contextPct}%` }} />
            </div>
          )}
          <div className="pid-wb-inspector-token-row">
            <span>{contextTokens.toLocaleString()} tokens</span>
            {contextWindow > 0 && <span className="pid-wb-muted">/ {contextWindow.toLocaleString()}</span>}
          </div>
        </div>
      )}
      {planSteps.length > 0 && (
        <div className="pid-wb-inspector-plan">
          <div className="pid-wb-inspector-head">
            <span>任务进度</span>
            <span className="pid-wb-muted">
              {completedSteps}/{planSteps.length}
            </span>
            {rpcService !== undefined && (
              <button type="button" className="pid-wb-icon-btn small" title="刷新任务进度" onClick={() => void refreshPlan()}>
                <RefreshCw size={11} />
              </button>
            )}
          </div>
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
        </div>
      )}
    </section>
  );
}

/** 3. Outputs section (`outputs`). */
export function InspectorOutputsSection({
  cwd: propCwd,
  ctx,
}: SlotComponentProps<WorkbenchSlotBaseProps, "session-maybe">): ReactElement {
  const session = useSessionState(ctx);
  const workspace = useWorkspaceState(ctx);
  const workbenchService = useFrontendService("workbenchService", ctx);
  const registry = ctx?.get("slots")?.registry;
  useSlotRegistryVersion(registry);

  const cwd = propCwd ?? workspace?.cwd ?? "";
  const messages = session?.messages ?? EMPTY_MESSAGES;
  const outputs = useMemo(() => deriveOutputs(messages, 20), [messages]);
  const uncommittedCount = workspace?.git?.files.length ?? 0;
  const reviewAvailable = isPaneRegistered(registry, "review");

  return (
    <section className="pid-wb-inspector-section" data-inspector-section="outputs">
      <header className="pid-wb-inspector-head">
        <span>产出文件</span>
        {reviewAvailable && uncommittedCount > 0 && (
          <button type="button" className="pid-wb-inspector-action" onClick={() => workbenchService?.openReview()}>
            审查 ({uncommittedCount})
          </button>
        )}
      </header>
      {outputs.length > 0 ? (
        <ul className="pid-wb-output-list">
          {outputs.map((output) => (
            <li key={output.id} className="pid-wb-output-row">
              <button
                type="button"
                className="pid-wb-output-btn"
                title={output.path}
                onClick={() => {
                  if (cwd !== "") void workbenchService?.openFile(output.path, { cwd });
                }}
              >
                {renderOutputGlyph(output.path)}
                <span className="pid-wb-output-name">{output.fileName}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pid-wb-inspector-empty">本轮尚未写入或修改工作区文件。</p>
      )}
    </section>
  );
}

/** 4. Extensions section (`extensions`) — dynamically lists registered extension panes + legacy tabs. */
export function InspectorExtensionsSection({
  ctx,
}: SlotComponentProps<WorkbenchSlotBaseProps, "session-maybe">): ReactElement | null {
  const workbench = useWorkbenchState(ctx);
  const workbenchService = useFrontendService("workbenchService", ctx);
  const contributions = useClientContributions();
  const registry = ctx?.get("slots")?.registry;
  useSlotRegistryVersion(registry);

  const openPanes = workbench?.openPanes ?? [];
  const registeredExtIds = listRegisteredExtensionPaneIds(registry);
  const registeredSet = new Set(registeredExtIds);
  const legacyOnlyTabs = contributions.rightWorkbenchTabs.filter((tab) => !registeredSet.has(tab.id));

  if (registeredExtIds.length === 0 && legacyOnlyTabs.length === 0) return null;

  return (
    <section className="pid-wb-inspector-section" data-inspector-section="extensions">
      <header className="pid-wb-inspector-head">
        <span>扩展视图</span>
      </header>
      <div className="pid-wb-ext-tabs" role="tablist" aria-label="扩展面板">
        {registeredExtIds.map((paneId) => {
          const isOpen = openPanes.includes(paneId);
          const label = resolvePaneTitle(paneId, contributions.rightWorkbenchTabs);
          const icon =
            paneId === "side-chat" ? <MessageSquare size={12} /> : paneId === "intelligent-ui-canvas" ? <Layers size={12} /> : <Puzzle size={12} />;
          return (
            <button
              key={paneId}
              type="button"
              role="tab"
              data-wb-tab={paneId}
              aria-selected={isOpen}
              className={`pid-wb-ext-tab-btn${isOpen ? " active" : ""}`}
              onClick={() => workbenchService?.activateExtensionPane(paneId)}
            >
              {icon}
              <span>{label}</span>
            </button>
          );
        })}
        {legacyOnlyTabs.map((tab) => {
          const isOpen = openPanes.includes(tab.id);
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              data-wb-tab={tab.id}
              aria-selected={isOpen}
              className={`pid-wb-ext-tab-btn${isOpen ? " active" : ""}`}
              onClick={() => workbenchService?.activateExtensionPane(tab.id)}
            >
              {tab.icon ?? <Puzzle size={12} />}
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** 5. Diagnostics footer section (`diagnostics`). */
export function InspectorDiagnosticsSection({
  ctx,
}: SlotComponentProps<WorkbenchSlotBaseProps, "session-maybe">): ReactElement {
  const workbench = useWorkbenchState(ctx);
  const rpcService = useFrontendService("rpcService", ctx);
  const summaryFocus = workbench?.summaryFocus ?? "overview";

  const diagnosticsRef = useRef<HTMLElement>(null);
  const [diagExpanded, setDiagExpanded] = useState(() => summaryFocus === "diagnostics");
  const [prevFocus, setPrevFocus] = useState(summaryFocus);
  const [hostInfo, setHostInfo] = useState<HostInfoResult | null>(null);

  if (prevFocus !== summaryFocus) {
    setPrevFocus(summaryFocus);
    if (summaryFocus === "diagnostics" && !diagExpanded) setDiagExpanded(true);
  }

  useEffect(() => {
    if (summaryFocus === "diagnostics") {
      diagnosticsRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    }
  }, [summaryFocus]);

  const loadHostInfo = useCallback(async () => {
    if (rpcService === undefined) return;
    try {
      setHostInfo(await rpcService.call<HostInfoResult>("host.info"));
    } catch {
      // Ignore when offline.
    }
  }, [rpcService]);

  const toggleExpanded = () => {
    const next = !diagExpanded;
    setDiagExpanded(next);
    if (next && hostInfo === null) void loadHostInfo();
  };

  return (
    <section
      ref={diagnosticsRef}
      className="pid-wb-inspector-section is-footer"
      data-diagnostics-section=""
      data-inspector-section="diagnostics"
    >
      <div className="pid-wb-inspector-head">
        <button type="button" className="pid-wb-diag-toggle" aria-expanded={diagExpanded} onClick={toggleExpanded}>
          {diagExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>诊断日志</span>
        </button>
        {diagExpanded && rpcService !== undefined && (
          <button type="button" className="pid-wb-icon-btn small" title="刷新诊断信息" onClick={() => void loadHostInfo()}>
            <RefreshCw size={11} />
          </button>
        )}
      </div>
      {diagExpanded && (
        <div className="pid-wb-diag-body">
          {hostInfo !== null ? (
            <div className="pid-wb-diag-meta">
              Host v{hostInfo.version} · 协议 v{hostInfo.protocolVersion}
            </div>
          ) : (
            <p className="pid-wb-inspector-empty">暂无运行日志。</p>
          )}
        </div>
      )}
    </section>
  );
}

export const CoreInspectorSections = {
  Env: InspectorEnvSection,
  Context: InspectorContextSection,
  Outputs: InspectorOutputsSection,
  Extensions: InspectorExtensionsSection,
  Diagnostics: InspectorDiagnosticsSection,
};
