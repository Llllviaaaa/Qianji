/**
 * Core workbench topbar toggle controls contributed into `workbench.topbarControls`
 * (`src/builtin-plugins/core-workbench/CoreTopbarControls.tsx`, ADR 0023).
 *
 * Feature plugins (`code-review`, `web-preview`, `side-chat`, etc.) register
 * their own toggle buttons into `workbench.topbarControls` independently —
 * zero hardcoded feature gates live here.
 */
import type { ReactElement } from "react";
import { FileText, Layers, Puzzle, SquareTerminal } from "lucide-react";
import {
  useClientContributions,
  useFrontendService,
  useWorkbenchState,
} from "@qianji/client";
import {
  SlotHost,
  type SlotComponentProps,
  type WorkbenchSlotBaseProps,
} from "@qianji/client-slots";
import {
  filterRegisteredPanes,
  isPaneRegistered,
  listRegisteredBottomTabIds,
  useSlotRegistryVersion,
} from "./tilingHelpers";

function DockRightIcon({ open, size = 15 }: { readonly open: boolean; readonly size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2.4" stroke="currentColor" strokeWidth="1.25" />
      <path d="M10.5 2.75V13.25" stroke="currentColor" strokeWidth="1.25" />
      {open && <rect x="10.9" y="2.9" width="2.7" height="10.2" rx="0.9" fill="currentColor" fillOpacity="0.22" />}
    </svg>
  );
}

function DockBottomIcon({ open, size = 15 }: { readonly open: boolean; readonly size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2.4" stroke="currentColor" strokeWidth="1.25" />
      <path d="M2.25 10.25H13.75" stroke="currentColor" strokeWidth="1.25" />
      {open && <rect x="2.4" y="10.6" width="11.2" height="2.6" rx="0.8" fill="currentColor" fillOpacity="0.22" />}
    </svg>
  );
}

/** Core primary pane toggles (`files` and `terminal`), ordered between feature panes and chrome controls. */
export function CorePrimaryTopbarButtons({
  ctx,
}: SlotComponentProps<WorkbenchSlotBaseProps, "session-maybe">): ReactElement {
  const workbench = useWorkbenchState(ctx);
  const workbenchService = useFrontendService("workbenchService", ctx);
  const contributions = useClientContributions();
  const registry = ctx?.get("slots")?.registry;
  useSlotRegistryVersion(registry);

  const activePanes = filterRegisteredPanes(
    workbench?.openPanes ?? [],
    registry,
    contributions.rightWorkbenchTabs,
  );
  const filesOpen = activePanes.includes("files") || activePanes.includes("editor");
  const terminalOpen = activePanes.includes("terminal");

  return (
    <>
      <button
        type="button"
        data-wb-tab="files"
        className={`pid-wb-top-toggle${filesOpen ? " active" : ""}`}
        title="工作区文件 (Files)"
        aria-label="工作区文件"
        aria-pressed={filesOpen}
        onClick={() => workbenchService?.togglePane("files")}
      >
        <FileText size={15} strokeWidth={1.65} />
      </button>
      <button
        type="button"
        data-wb-tab="terminal"
        className={`pid-wb-top-toggle${terminalOpen ? " active" : ""}`}
        title="集成终端 (Ctrl+J)"
        aria-label="集成终端"
        aria-pressed={terminalOpen}
        onClick={() => workbenchService?.togglePane("terminal")}
      >
        <SquareTerminal size={15} strokeWidth={1.65} />
      </button>
    </>
  );
}

/** Trailing topbar chrome: active legacy workbench tab pills, bottom drawer toggle, and inspector toggle. */
export function CoreChromeTopbarButtons({
  ctx,
}: SlotComponentProps<WorkbenchSlotBaseProps, "session-maybe">): ReactElement {
  const workbench = useWorkbenchState(ctx);
  const workbenchService = useFrontendService("workbenchService", ctx);
  const contributions = useClientContributions();
  const registry = ctx?.get("slots")?.registry;
  useSlotRegistryVersion(registry);

  const rightOpen = workbench?.rightOpen ?? false;
  const bottomOpen = workbench?.bottomOpen ?? false;
  const inspectorOpen = workbench?.inspectorOpen ?? false;
  const activePanes = filterRegisteredPanes(
    workbench?.openPanes ?? [],
    registry,
    contributions.rightWorkbenchTabs,
  );

  // Show pills for active legacy `rightWorkbenchTabs` not already backed by a `workbench.panes` entry
  const activeLegacyTabs = contributions.rightWorkbenchTabs.filter(
    (tab) => activePanes.includes(tab.id) && !isPaneRegistered(registry, tab.id),
  );
  const canvasOpen = activePanes.includes("intelligent-ui-canvas");
  const registeredBottomTabs = listRegisteredBottomTabIds(registry);
  const hasExtraBottomTabs =
    contributions.bottomPanelTabs.length > 0 || registeredBottomTabs.some((id) => id !== "terminal");
  const showBottomControl = bottomOpen || hasExtraBottomTabs;

  const inspectorLabel = !rightOpen
    ? "切换右侧工作台 (Ctrl+Alt+B)"
    : inspectorOpen && activePanes.length === 0
      ? "隐藏工作台 (Ctrl+Alt+B)"
      : "切换环境与上下文栏 (Ctrl+Alt+B)";

  return (
    <>
      {canvasOpen && (
        <button
          type="button"
          data-wb-tab="intelligent-ui-canvas"
          className="pid-wb-top-toggle active"
          title="关闭画布"
          aria-label="画布"
          aria-pressed
          onClick={() => workbenchService?.togglePane("intelligent-ui-canvas")}
        >
          <Layers size={14} strokeWidth={1.65} />
        </button>
      )}
      {activeLegacyTabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          data-wb-tab={tab.id}
          className="pid-wb-top-toggle active"
          title={`关闭${tab.label}`}
          aria-label={tab.label}
          aria-pressed
          onClick={() => workbenchService?.togglePane(tab.id)}
        >
          {tab.icon ?? <Puzzle size={14} strokeWidth={1.65} />}
        </button>
      ))}
      {showBottomControl && (
        <button
          type="button"
          data-wb-bottom-toggle="true"
          className={`pid-wb-top-toggle${bottomOpen ? " active" : ""}`}
          title="切换底部扩展面板"
          aria-label="切换底部扩展面板"
          aria-pressed={bottomOpen}
          onClick={() => workbenchService?.toggleBottom()}
        >
          <DockBottomIcon open={bottomOpen} size={15} />
        </button>
      )}
      <button
        type="button"
        data-wb-tab="summary"
        className={`pid-wb-top-toggle${inspectorOpen ? " active" : ""}`}
        title={inspectorLabel}
        aria-label={inspectorLabel}
        aria-pressed={inspectorOpen}
        onClick={() => workbenchService?.toggleInspector()}
      >
        <DockRightIcon open={inspectorOpen} size={15} />
      </button>
    </>
  );
}

/** Standalone toolbar container rendering all registered `workbench.topbarControls` entries. */
export function CoreTopbarControls({
  cwd = "",
  sessionFile = null,
}: WorkbenchSlotBaseProps): ReactElement {
  return (
    <div className="pid-wb-topbar-controls" role="toolbar" aria-label="工作区面板开关">
      <SlotHost
        slotKey="workbench.topbarControls"
        kind="list"
        scope="session-maybe"
        props={{ cwd, sessionFile }}
      />
    </div>
  );
}
