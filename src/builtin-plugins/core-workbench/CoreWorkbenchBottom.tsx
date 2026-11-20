/**
 * Built-in bottom workbench drawer registered onto `shell.workbench.bottom`
 * (`src/builtin-plugins/core-workbench/CoreWorkbenchBottom.tsx`, ADR 0023).
 *
 * Owns child slot `workbench.bottom.tabs` (`keyed`) and supports both typed
 * slot tabs and legacy `contributions.bottomPanelTabs`.
 */
import { useCallback, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { Plus, Puzzle, TerminalSquare, X } from "lucide-react";
import {
  useClientContributions,
  useFrontendService,
  useSessionState,
  useWorkbenchState,
  useWorkspaceState,
} from "@qianji/client";
import type {
  CoreWorkbenchBottomProps,
  SlotComponentProps,
} from "@qianji/client-slots";
import {
  LegacyContributionHost,
  listRegisteredBottomTabIds,
  useSlotRegistryVersion,
} from "./tilingHelpers";

const DEFAULT_BOTTOM_HEIGHT = 240;
const MIN_BOTTOM_HEIGHT = 140;
const MAX_BOTTOM_HEIGHT = 560;

function clampHeight(height: number): number {
  return Math.min(MAX_BOTTOM_HEIGHT, Math.max(MIN_BOTTOM_HEIGHT, Math.round(height)));
}

export function CoreWorkbenchBottom({
  cwd: propCwd,
  sessionFile: propSessionFile,
  open: propOpen,
  activeTab: propActiveTab,
  renderSlot,
  ctx,
}: SlotComponentProps<CoreWorkbenchBottomProps, "session-maybe">): ReactElement | null {
  const workbench = useWorkbenchState(ctx);
  const workspace = useWorkspaceState(ctx);
  const session = useSessionState(ctx);
  const workbenchService = useFrontendService("workbenchService", ctx);
  const contributions = useClientContributions();
  const registry = ctx?.get("slots")?.registry;
  useSlotRegistryVersion(registry);

  const bottomOpen = propOpen ?? workbench?.bottomOpen ?? false;
  const activeBottomTab = propActiveTab ?? workbench?.activeBottomTab ?? "terminal";
  const cwd = propCwd ?? workspace?.cwd ?? "";
  const sessionFile = propSessionFile !== undefined ? propSessionFile : (session?.sessionFile ?? null);

  const [everOpened, setEverOpened] = useState(bottomOpen);
  if (bottomOpen && !everOpened) {
    setEverOpened(true);
  }
  const [height, setHeight] = useState(DEFAULT_BOTTOM_HEIGHT);

  const beginResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    document.body.classList.add("bottom-panel-is-resizing");
    const onMove = (moveEvent: PointerEvent) => {
      setHeight(clampHeight(startHeight + (startY - moveEvent.clientY)));
    };
    const cleanup = () => {
      document.body.classList.remove("bottom-panel-is-resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
  }, [height]);

  if (!everOpened) return null;

  const slotTabIds = listRegisteredBottomTabIds(registry);
  const slotTabSet = new Set(slotTabIds);
  const legacyTabs = contributions.bottomPanelTabs.filter((tab) => !slotTabSet.has(tab.id));
  const activeLegacyTab = legacyTabs.find((tab) => tab.id === activeBottomTab);
  const resolvedTabKey =
    activeLegacyTab !== undefined
      ? activeLegacyTab.id
      : slotTabSet.has(activeBottomTab)
        ? activeBottomTab
        : (slotTabIds[0] ?? "terminal");

  return (
    <section
      className="pid-bottom-workbench"
      data-core-workbench="bottom"
      hidden={!bottomOpen}
      style={{ height: `${height}px` }}
      aria-label="底部工作台"
    >
      <div
        className="pid-bottom-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整底部面板高度"
        aria-valuemin={MIN_BOTTOM_HEIGHT}
        aria-valuemax={MAX_BOTTOM_HEIGHT}
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={beginResize}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setHeight((prev) => clampHeight(prev + 24));
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setHeight((prev) => clampHeight(prev - 24));
          }
        }}
      />
      <header className="pid-bottom-header">
        <div className="pid-bottom-tabs" role="tablist" aria-label="底部面板视图">
          {slotTabIds.map((tabId) => {
            const selected = activeLegacyTab === undefined && resolvedTabKey === tabId;
            return (
              <button
                key={tabId}
                type="button"
                role="tab"
                data-bottom-tab={tabId}
                aria-selected={selected}
                className={`pid-wb-tab-btn${selected ? " active" : ""}`}
                onClick={() => workbenchService?.setActiveBottomTab(tabId)}
              >
                {tabId === "terminal" ? <TerminalSquare size={13} /> : <Puzzle size={13} />}
                <span>{tabId === "terminal" ? "终端" : tabId}</span>
              </button>
            );
          })}
          {legacyTabs.map((tab) => {
            const selected = activeLegacyTab?.id === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                data-bottom-tab={tab.id}
                aria-selected={selected}
                className={`pid-wb-tab-btn${selected ? " active" : ""}`}
                onClick={() => workbenchService?.setActiveBottomTab(tab.id)}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
        <div className="pid-wb-subbar-actions">
          {resolvedTabKey === "terminal" && activeLegacyTab === undefined && (
            <button
              type="button"
              className="pid-wb-icon-btn"
              title="新建终端"
              onClick={() => workbenchService?.requestNewTerminal()}
            >
              <Plus size={14} />
            </button>
          )}
          <button
            type="button"
            className="pid-wb-icon-btn"
            title="隐藏底部面板 (Ctrl+J)"
            onClick={() => workbenchService?.setBottomOpen(false)}
          >
            <X size={14} />
          </button>
        </div>
      </header>
      <div className="pid-bottom-body">
        {activeLegacyTab !== undefined ? (
          <LegacyContributionHost
            pluginId={activeLegacyTab.pluginId ?? activeLegacyTab.id}
            entryId={activeLegacyTab.id}
            slotKey="bottomPanelTabs"
            renderFn={activeLegacyTab.render}
            context={{ cwd, sessionFile }}
          />
        ) : (
          renderSlot(
            "workbench.bottom.tabs",
            { cwd, sessionFile, tabId: resolvedTabKey, active: bottomOpen },
            { key: resolvedTabKey },
          )
        )}
      </div>
    </section>
  );
}
