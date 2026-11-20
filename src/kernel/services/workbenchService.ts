/**
 * Frontend Cordis `workbenchService` (ADR 0023 Phase 2).
 *
 * Wraps Qianji's right/bottom workbench state (`useWorkbenchStore`) and
 * tiling layout tree (`useWorkbenchLayoutStore`) behind a clean Cordis Service
 * without leaking raw Zustand store internals.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import type {
  PaneDropZone,
  WorkbenchSplitDirection,
  WorkbenchTileNode,
} from "../../lib/workbenchTiling";
import { useAppStore } from "../../store";
import { useWorkbenchLayoutStore } from "../../stores/workbenchLayoutStore";
import {
  matchesWorkbenchFileCwd,
  resolveWorkspaceActiveFilePath,
  useWorkbenchStore,
  type OpenFileOptions,
  type OpenWorkbenchFile,
} from "../../stores/workbenchStore";
import { ServiceEmitter, shallowEqualObject, trackContextEffect } from "./shared";

export type {
  OpenFileOptions,
  OpenWorkbenchFile,
  PaneDropZone,
  WorkbenchSplitDirection,
  WorkbenchTileNode,
};

declare module "@deepseek-ai/cordis" {
  interface Context {
    workbenchService: WorkbenchService;
  }
}

export interface WorkbenchServiceSnapshot {
  readonly rightOpen: boolean;
  readonly rightMaximized: boolean;
  readonly bottomOpen: boolean;
  readonly activeBottomTab: string;
  readonly inspectorOpen: boolean;
  readonly openPanes: readonly string[];
  readonly layoutTree: WorkbenchTileNode | null;
  readonly maximizedPaneId: string | null;
  readonly twoPaneDirection: WorkbenchSplitDirection;
  readonly fileDrawerOpen: boolean;
  readonly activeTab: string;
  readonly openFiles: readonly OpenWorkbenchFile[];
  readonly activeFilePath: string | null;
  readonly activeFile: OpenWorkbenchFile | null;
  readonly previewUrl: string;
  readonly summaryFocus: "overview" | "diagnostics";
  readonly terminalCreateNonce: number;
}

function buildWorkbenchSnapshot(): WorkbenchServiceSnapshot {
  const wb = useWorkbenchStore.getState();
  const layout = useWorkbenchLayoutStore.getState();
  const cwd = useAppStore.getState().cwd || wb.activeFileCwd || undefined;
  const resolvedPath = resolveWorkspaceActiveFilePath(wb, cwd);
  const activeFile = resolvedPath === null
    ? null
    : wb.openFiles.find(
        (item) => item.path === resolvedPath && matchesWorkbenchFileCwd(item.cwd, cwd),
      ) ?? wb.openFiles.find((item) => item.path === resolvedPath) ?? null;

  return {
    rightOpen: wb.rightOpen,
    rightMaximized: wb.rightMaximized,
    bottomOpen: wb.bottomOpen,
    activeBottomTab: wb.activeBottomTab,
    inspectorOpen: layout.inspectorOpen,
    openPanes: layout.openPanes,
    layoutTree: layout.layoutTree,
    maximizedPaneId: layout.maximizedPaneId,
    twoPaneDirection: layout.twoPaneDirection,
    fileDrawerOpen: layout.fileDrawerOpen,
    activeTab: wb.activeTab,
    openFiles: wb.openFiles,
    activeFilePath: resolvedPath,
    activeFile,
    previewUrl: wb.previewUrl,
    summaryFocus: wb.summaryFocus,
    terminalCreateNonce: wb.terminalCreateNonce,
  };
}

interface WorkbenchInternalState {
  snapshot: WorkbenchServiceSnapshot;
  readonly emitter: ServiceEmitter;
}

export class WorkbenchService extends Service {
  static provide = "workbenchService";
  private readonly internal: WorkbenchInternalState;

  constructor(ctx: Context) {
    super(ctx, "workbenchService");
    this.internal = {
      snapshot: buildWorkbenchSnapshot(),
      emitter: new ServiceEmitter("workbenchService"),
    };

    const sync = () => {
      const next = buildWorkbenchSnapshot();
      if (!shallowEqualObject(this.internal.snapshot, next)) {
        this.internal.snapshot = next;
        this.internal.emitter.emit();
      }
    };

    const offWb = useWorkbenchStore.subscribe(sync);
    const offLayout = useWorkbenchLayoutStore.subscribe(sync);
    const offApp = useAppStore.subscribe((state, prev) => {
      if (state.cwd !== prev.cwd) sync();
    });

    ctx.effect(() => () => {
      offWb();
      offLayout();
      offApp();
      this.internal.emitter.clear();
    });
  }

  getSnapshot(): WorkbenchServiceSnapshot {
    return this.internal.snapshot;
  }

  subscribe(listener: () => void): () => void {
    const rawUnsub = this.internal.emitter.add(listener);
    return trackContextEffect(this.ctx, rawUnsub);
  }

  openPane(paneId: string): void {
    useWorkbenchLayoutStore.getState().openPane(paneId);
  }

  closePane(paneId: string): void {
    useWorkbenchLayoutStore.getState().closePane(paneId);
  }

  togglePane(paneId: string): void {
    useWorkbenchLayoutStore.getState().togglePane(paneId);
  }

  activateExtensionPane(paneId: string): void {
    useWorkbenchLayoutStore.getState().activateExtensionPane(paneId);
  }

  swapOrDockPanes(sourceId: string, targetId: string, zone: PaneDropZone = "swap"): void {
    useWorkbenchLayoutStore.getState().swapOrDockPanes(sourceId, targetId, zone);
  }

  setSplitNodeRatio(splitId: string, ratio: number): void {
    useWorkbenchLayoutStore.getState().setSplitNodeRatio(splitId, ratio);
  }

  setTwoPaneDirection(direction: WorkbenchSplitDirection): void {
    useWorkbenchLayoutStore.getState().setTwoPaneDirection(direction);
  }

  toggleMaximizePane(paneId: string): void {
    useWorkbenchLayoutStore.getState().toggleMaximizePane(paneId);
  }

  toggleInspector(): void {
    useWorkbenchLayoutStore.getState().toggleInspector();
  }

  setInspectorOpen(open: boolean): void {
    useWorkbenchLayoutStore.getState().setInspectorOpen(open);
  }

  toggleBottom(): void {
    useWorkbenchStore.getState().toggleBottom();
  }

  setBottomOpen(open: boolean): void {
    useWorkbenchStore.getState().setBottomOpen(open);
  }

  setActiveBottomTab(tab: string): void {
    useWorkbenchStore.getState().setActiveBottomTab(tab);
  }

  openTab(tab: string): void {
    useWorkbenchStore.getState().openTab(tab);
  }

  setRightOpen(open: boolean): void {
    useWorkbenchStore.getState().setRightOpen(open);
  }

  async openFile(path: string, options?: OpenFileOptions & { cwd?: string }): Promise<void> {
    const targetCwd = options?.cwd ?? useAppStore.getState().cwd;
    await useWorkbenchStore.getState().openFile(targetCwd, path, options);
  }

  selectFile(path: string, cwd?: string): void {
    useWorkbenchStore.getState().selectFile(path, cwd);
  }

  updateFileContent(path: string, content: string, cwd?: string): void {
    useWorkbenchStore.getState().updateFileContent(path, content, cwd);
  }

  async saveFile(path: string, cwd?: string): Promise<boolean> {
    const targetCwd = cwd ?? useAppStore.getState().cwd;
    return useWorkbenchStore.getState().saveFile(targetCwd, path);
  }

  closeFile(path: string, cwd?: string): void {
    useWorkbenchStore.getState().closeFile(path, cwd);
  }

  openReview(): void {
    useWorkbenchStore.getState().openReview();
  }

  openPreview(url?: string): void {
    useWorkbenchStore.getState().openPreview(url);
  }

  openSummary(focus: "overview" | "diagnostics" = "overview"): void {
    useWorkbenchStore.getState().openSummary(focus);
  }

  bumpTerminalCreateNonce(): void {
    useWorkbenchStore.getState().bumpTerminalCreateNonce();
  }

  requestNewTerminal(): void {
    useWorkbenchStore.getState().requestNewTerminal();
  }

  toggleFileDrawer(): void {
    useWorkbenchLayoutStore.getState().toggleFileDrawer();
  }

  setFileDrawerOpen(open: boolean): void {
    useWorkbenchLayoutStore.getState().setFileDrawerOpen(open);
  }
}
