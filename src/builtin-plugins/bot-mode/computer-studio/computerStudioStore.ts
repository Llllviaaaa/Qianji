/**
 * Reactive state store & notification reducer for 「千机的电脑 (Qianji's Computer)」 Studio UI.
 *
 * Syncs `BotComputerStudioSnapshot` from both `botDataStore` (`snapshot.computerStudio` /
 * `snapshot.virtualServer.computerStudio`) and live `"bot/computer"` notifications,
 * while tracking studio split-pane geometry, timeline scrub index (`null` = LIVE),
 * pointer telemetry ripples, rolling PTY buffers, and fenced `/workspace` file explorer state.
 */
import { createReactiveStore, useStoreValue } from "@qianji/client-store";
import type {
  BotComputerEngineId,
  BotComputerEventNotification,
  BotComputerFileEntry,
  BotComputerFilesReadResult,
  BotComputerPointerTelemetry,
  BotComputerStudioSnapshot,
  BotComputerTimelineStep,
  BotComputerViewTab,
  BotSnapshotResult,
} from "@qianji/protocol";
import { FALLBACK_BOT_SNAPSHOT } from "../botFallbackData";
import { botDataStore } from "../botUiAtoms";

export const MIN_STUDIO_WIDTH = 440;
export const MAX_STUDIO_WIDTH = 960;
export const DEFAULT_STUDIO_WIDTH = 620;
const MAX_PTY_BUFFER_CHARS = 32_768;

export function clampStudioWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_STUDIO_WIDTH;
  return Math.max(MIN_STUDIO_WIDTH, Math.min(MAX_STUDIO_WIDTH, Math.round(width)));
}

export interface ComputerEngineCardMeta {
  readonly id: BotComputerEngineId;
  readonly badgeLabel: string;
  readonly title: string;
  readonly subtitle: string;
  readonly group: "local" | "remote";
}

export const COMPUTER_ENGINE_CARDS: readonly ComputerEngineCardMeta[] = [
  {
    id: "local-linux",
    badgeLabel: "Linux 桌面",
    title: "本地 Linux 桌面",
    subtitle: "WSL2 GUI 沙盒 · Xvfb :99",
    group: "local",
  },
  {
    id: "local-win-pip",
    badgeLabel: "Win 多开副屏",
    title: "本地 Win 多开桌面",
    subtitle: "当前账号派生 · 不抢鼠标",
    group: "local",
  },
  {
    id: "remote-vm",
    badgeLabel: "远程 VM",
    title: "远程虚拟机",
    subtitle: "Linux VPS · OpenSSH 7×24h",
    group: "remote",
  },
  {
    id: "remote-pc",
    badgeLabel: "远程电脑",
    title: "远程个人电脑",
    subtitle: "Mac mini / PC · 离线自治租约",
    group: "remote",
  },
];

export function getEngineCardMeta(engineId: BotComputerEngineId): ComputerEngineCardMeta {
  return COMPUTER_ENGINE_CARDS.find((item) => item.id === engineId) ?? COMPUTER_ENGINE_CARDS[0];
}

export const FALLBACK_COMPUTER_STUDIO_SNAPSHOT: BotComputerStudioSnapshot = {
  activeEngine: "local-linux",
  activeTab: "browser",
  autoFollow: true,
  localLinux: {
    distro: "qianji-bot-vm",
    guiReady: true,
    display: ":99",
    resolution: "1280x800",
    chromiumReady: true,
  },
  localWinPip: {
    accountMode: "current-user",
    backend: "win32-secondary-desktop",
    proSupported: false,
    childSessionEnabled: false,
    desktopName: "QianjiBotDesktop",
    fencedRoots: [],
    openWindows: [],
    resolution: "1280x800",
  },
  remoteNodes: [],
  takeover: { status: "idle" },
  timeline: [],
  filesCwd: "/workspace",
};

export interface ComputerStudioUiState {
  readonly studioOpen: boolean;
  readonly studioWidth: number;
  readonly scrubIndex: number | null;
  readonly latestPointer: BotComputerPointerTelemetry | null;
  readonly pointerClickSeq: number;
  readonly ptyBufferByEngine: Readonly<Record<BotComputerEngineId, string>>;
  readonly filesCwd: string;
  readonly filesEntries: readonly BotComputerFileEntry[];
  readonly selectedFilePath: string | null;
  readonly selectedFileRead: BotComputerFilesReadResult | null;
  readonly busyAction: string | null;
  readonly feedbackMessage: string | null;
}

export const INITIAL_COMPUTER_STUDIO_UI_STATE: ComputerStudioUiState = {
  studioOpen: false,
  studioWidth: DEFAULT_STUDIO_WIDTH,
  scrubIndex: null,
  latestPointer: null,
  pointerClickSeq: 0,
  ptyBufferByEngine: {
    "local-linux": "",
    "local-win-pip": "",
    "remote-vm": "",
    "remote-pc": "",
  },
  filesCwd: "/workspace",
  filesEntries: [],
  selectedFilePath: null,
  selectedFileRead: null,
  busyAction: null,
  feedbackMessage: null,
};

export const computerStudioSnapshotStore = createReactiveStore<BotComputerStudioSnapshot>(
  FALLBACK_COMPUTER_STUDIO_SNAPSHOT,
);
export const computerStudioUiStore = createReactiveStore<ComputerStudioUiState>(
  INITIAL_COMPUTER_STUDIO_UI_STATE,
);

export function useComputerStudioSnapshot(): BotComputerStudioSnapshot {
  return useStoreValue(computerStudioSnapshotStore);
}

export function useComputerStudioUi(): ComputerStudioUiState {
  return useStoreValue(computerStudioUiStore);
}

export function patchComputerStudioUi(patch: Partial<ComputerStudioUiState>): void {
  computerStudioUiStore.set((prev) => ({
    ...prev,
    ...patch,
    ...(patch.studioWidth !== undefined ? { studioWidth: clampStudioWidth(patch.studioWidth) } : {}),
  }));
}

export function openComputerStudio(options?: {
  readonly engine?: BotComputerEngineId;
  readonly tab?: BotComputerViewTab;
}): void {
  if (options?.engine !== undefined || options?.tab !== undefined) {
    computerStudioSnapshotStore.set((prev) => ({
      ...prev,
      ...(options.engine !== undefined ? { activeEngine: options.engine } : {}),
      ...(options.tab !== undefined ? { activeTab: options.tab } : {}),
    }));
  }
  patchComputerStudioUi({ studioOpen: true });
}

export function closeComputerStudio(): void {
  patchComputerStudioUi({ studioOpen: false });
}

export function toggleComputerStudio(): void {
  const cur = computerStudioUiStore.get().studioOpen;
  patchComputerStudioUi({ studioOpen: !cur });
}

export function setComputerScrubIndex(index: number | null): void {
  if (index === null) {
    patchComputerStudioUi({ scrubIndex: null });
    return;
  }
  const steps = computerStudioSnapshotStore.get().timeline;
  if (steps.length === 0) {
    patchComputerStudioUi({ scrubIndex: null });
    return;
  }
  const clamped = Math.max(0, Math.min(steps.length - 1, Math.round(index)));
  patchComputerStudioUi({ scrubIndex: clamped });
}

function appendPtyChunk(prev: string, chunk: string): string {
  const merged = prev + chunk;
  return merged.length > MAX_PTY_BUFFER_CHARS
    ? merged.slice(merged.length - MAX_PTY_BUFFER_CHARS)
    : merged;
}

function isClickAction(pointer: BotComputerPointerTelemetry | undefined): boolean {
  return pointer?.action === "click" || pointer?.action === "double-click";
}

function upsertTimelineStep(
  existing: readonly BotComputerTimelineStep[],
  step: BotComputerTimelineStep,
): BotComputerTimelineStep[] {
  const idx = existing.findIndex((item) => item.id === step.id);
  if (idx >= 0) {
    const next = [...existing];
    next[idx] = step;
    return next;
  }
  return [...existing, step].sort((a, b) => a.seq - b.seq || a.ts - b.ts);
}

export function applyComputerStudioSnapshot(next: BotComputerStudioSnapshot): void {
  computerStudioSnapshotStore.set(next);
  computerStudioUiStore.set((prev) => {
    const ptyEngine = next.pty?.engine ?? next.activeEngine;
    const ptyTail = next.pty?.outputTail ?? "";
    const curBuffer = prev.ptyBufferByEngine[ptyEngine] ?? "";
    const nextPtyBuffers =
      ptyTail !== "" && curBuffer === ""
        ? { ...prev.ptyBufferByEngine, [ptyEngine]: ptyTail }
        : prev.ptyBufferByEngine;
    const nextPointer = next.latestFrame?.cursor ?? prev.latestPointer;
    const clampedScrub =
      prev.scrubIndex !== null && next.timeline.length > 0
        ? Math.min(prev.scrubIndex, next.timeline.length - 1)
        : prev.scrubIndex !== null && next.timeline.length === 0
          ? null
          : prev.scrubIndex;
    return {
      ...prev,
      scrubIndex: clampedScrub,
      latestPointer: nextPointer,
      ptyBufferByEngine: nextPtyBuffers,
      ...(next.files !== undefined ? { filesEntries: next.files } : {}),
      ...(next.filesCwd !== undefined && next.filesCwd !== "" ? { filesCwd: next.filesCwd } : {}),
    };
  });
}

export function syncComputerStudioFromBotSnapshot(snap: BotSnapshotResult | null | undefined): void {
  if (!snap) return;
  if (snap === FALLBACK_BOT_SNAPSHOT) {
    computerStudioSnapshotStore.set(FALLBACK_COMPUTER_STUDIO_SNAPSHOT);
    return;
  }
  const embedded = snap.computerStudio ?? snap.virtualServer.computerStudio;
  if (embedded !== undefined) {
    applyComputerStudioSnapshot(embedded);
  }
}

export function applyComputerEventNotification(event: BotComputerEventNotification): void {
  if (!event || typeof event !== "object" || !("kind" in event)) return;

  if (event.kind === "snapshot") {
    applyComputerStudioSnapshot(event.snapshot);
    return;
  }

  if (event.kind === "frame") {
    computerStudioSnapshotStore.set((prev) => ({
      ...prev,
      latestFrame: event.frame,
    }));
    if (event.frame.cursor !== undefined) {
      const cursor = event.frame.cursor;
      computerStudioUiStore.set((prev) => ({
        ...prev,
        latestPointer: cursor,
        pointerClickSeq: isClickAction(cursor) ? prev.pointerClickSeq + 1 : prev.pointerClickSeq,
      }));
    }
    return;
  }

  if (event.kind === "pointer") {
    computerStudioUiStore.set((prev) => ({
      ...prev,
      latestPointer: event.pointer,
      pointerClickSeq: isClickAction(event.pointer) ? prev.pointerClickSeq + 1 : prev.pointerClickSeq,
    }));
    return;
  }

  if (event.kind === "timeline") {
    computerStudioSnapshotStore.set((prev) => {
      const nextTimeline = upsertTimelineStep(prev.timeline, event.step);
      const shouldFollow = prev.autoFollow && computerStudioUiStore.get().scrubIndex === null;
      return {
        ...prev,
        timeline: nextTimeline,
        ...(shouldFollow ? { activeEngine: event.step.engine, activeTab: event.step.tab } : {}),
      };
    });
    if (event.step.cursor !== undefined) {
      const stepCursor = event.step.cursor;
      computerStudioUiStore.set((prev) => ({
        ...prev,
        latestPointer: stepCursor,
        pointerClickSeq: isClickAction(stepCursor) ? prev.pointerClickSeq + 1 : prev.pointerClickSeq,
      }));
    }
    return;
  }

  if (event.kind === "takeover") {
    computerStudioSnapshotStore.set((prev) => ({
      ...prev,
      takeover: event.takeover,
      ...(event.takeover.status !== "idle" && event.takeover.engine !== undefined
        ? { activeEngine: event.takeover.engine }
        : {}),
      ...(event.takeover.status !== "idle" && event.takeover.tab !== undefined
        ? { activeTab: event.takeover.tab }
        : {}),
    }));
    return;
  }

  if (event.kind === "pty") {
    computerStudioSnapshotStore.set((prev) => ({
      ...prev,
      pty: {
        sessionId: event.sessionId,
        engine: event.engine,
        cwd: prev.pty?.cwd ?? "/workspace",
        alive: event.alive,
        outputTail: appendPtyChunk(prev.pty?.outputTail ?? "", event.chunk),
        updatedAt: event.updatedAt,
      },
    }));
    computerStudioUiStore.set((prev) => ({
      ...prev,
      ptyBufferByEngine: {
        ...prev.ptyBufferByEngine,
        [event.engine]: appendPtyChunk(prev.ptyBufferByEngine[event.engine] ?? "", event.chunk),
      },
    }));
  }
}

export function resetComputerStudioStores(): void {
  computerStudioSnapshotStore.set(FALLBACK_COMPUTER_STUDIO_SNAPSHOT);
  computerStudioUiStore.set(INITIAL_COMPUTER_STUDIO_UI_STATE);
}

// Automatically mirror `computerStudio` payloads embedded inside `botDataStore` snapshots.
botDataStore.subscribe(() => {
  syncComputerStudioFromBotSnapshot(botDataStore.get());
});
