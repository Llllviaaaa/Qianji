/**
 * Unified Computer Protocol (UCP) wire contracts for Qianji Virtual Computer 2.0 (`@qianji/protocol`).
 *
 * Models the 2x2 Virtual Computer matrix (`local-linux`, `local-win-pip`, `remote-vm`, `remote-pc`),
 * multi-tab studio workspace (`desktop`, `browser`, `terminal`, `files`), live frame streaming,
 * pointer telemetry, non-hijacking background input dispatch, timeline replay, manual takeover,
 * persistent PTY sessions, and fenced/remote file explorer operations.
 */
import type { BotRemoteAuthMethod } from "./bot-methods.ts";

export type BotComputerEngineId = "local-linux" | "local-win-pip" | "remote-vm" | "remote-pc";

export type BotComputerViewTab = "desktop" | "browser" | "terminal" | "files";

export type BotWinDesktopBackend = "rdp-child-session" | "win32-secondary-desktop" | "unavailable";

export type BotRemoteNodeKind = "ssh-vm" | "companion-pc";

export const BOT_COMPUTER_ENGINES: readonly BotComputerEngineId[] = ["local-linux", "local-win-pip", "remote-vm", "remote-pc"] as const;

export const BOT_COMPUTER_VIEW_TABS: readonly BotComputerViewTab[] = ["desktop", "browser", "terminal", "files"] as const;

export interface BotLocalLinuxDesktopStatus {
  distro: string;
  guiReady: boolean;
  display: string;
  resolution: string;
  chromiumReady: boolean;
  vncPort?: number;
  vncWsUrl?: string;
  vncReady?: boolean;
  provisioningStep?: string;
  windowManager?: string;
  error?: string;
}

export interface BotWinOpenWindow {
  hwnd: string;
  title: string;
  app?: string;
}

export interface BotLocalWinPipStatus {
  accountMode: "current-user";
  backend: BotWinDesktopBackend;
  proSupported: boolean;
  childSessionEnabled: boolean;
  childSessionActive?: boolean;
  signOutRequired?: boolean;
  viewerOpen?: boolean;
  childSessionId?: number;
  desktopName: string;
  isolatedProfileDir?: string;
  fencedRoots: string[];
  openWindows: BotWinOpenWindow[];
  resolution?: string;
  elevationHint?: string;
  error?: string;
}

export interface BotRemoteAutonomyLease {
  active: boolean;
  lastSeq: number;
  queuedOfflineEvents: number;
  updatedAt?: number;
}

export interface BotRemoteComputerNode {
  id: string;
  alias: string;
  kind: BotRemoteNodeKind;
  host: string;
  port: number;
  username?: string;
  workDir?: string;
  authMethod?: BotRemoteAuthMethod;
  privateKeyPath?: string;
  hasStoredSecret?: boolean;
  osSummary?: string;
  connected: boolean;
  latencyMs?: number;
  vncWsUrl?: string;
  autonomyLease: BotRemoteAutonomyLease;
  lastError?: string;
}

export type BotComputerPointerAction = "move" | "click" | "double-click" | "drag" | "scroll" | "type";

export interface BotComputerPointerTelemetry {
  x: number;
  y: number;
  viewportWidth: number;
  viewportHeight: number;
  action: BotComputerPointerAction;
  label?: string;
  ts: number;
}

export type BotComputerStreamTab = "desktop" | "browser";

export type BotComputerStreamMimeType = "image/jpeg" | "image/png" | "image/webp";

export interface BotComputerStreamFrame {
  engine: BotComputerEngineId;
  tab: BotComputerStreamTab;
  mimeType: BotComputerStreamMimeType;
  dataBase64: string;
  width: number;
  height: number;
  seq: number;
  ts: number;
  url?: string;
  title?: string;
  cursor?: BotComputerPointerTelemetry;
}

export type BotComputerInputKind = "mouse" | "wheel" | "key" | "text" | "paste";

export type BotComputerMouseAction = "move" | "down" | "up" | "click" | "double-click";

export type BotComputerMouseButton = "left" | "right" | "middle";

export type BotComputerKeyModifier = "ctrl" | "shift" | "alt" | "meta";

export interface BotComputerInputEvent {
  engine?: BotComputerEngineId;
  tab?: BotComputerViewTab;
  kind: BotComputerInputKind;
  mouseAction?: BotComputerMouseAction;
  button?: BotComputerMouseButton;
  x?: number;
  y?: number;
  endX?: number;
  endY?: number;
  deltaX?: number;
  deltaY?: number;
  viewportWidth?: number;
  viewportHeight?: number;
  key?: string;
  text?: string;
  modifiers?: BotComputerKeyModifier[];
}

export type BotComputerTimelineStatus = "running" | "completed" | "error" | "takeover";

export interface BotComputerTimelineStep {
  id: string;
  seq: number;
  ts: number;
  engine: BotComputerEngineId;
  tab: BotComputerViewTab;
  title: string;
  subtitle?: string;
  toolName?: string;
  urlOrApp?: string;
  thumbnailBase64?: string;
  terminalSnippet?: string;
  cursor?: BotComputerPointerTelemetry;
  status: BotComputerTimelineStatus;
}

export type BotComputerTakeoverStatus = "idle" | "requested" | "active";

export interface BotComputerTakeoverState {
  status: BotComputerTakeoverStatus;
  reason?: string;
  targetUrlOrApp?: string;
  engine?: BotComputerEngineId;
  tab?: BotComputerViewTab;
  requestedAt?: number;
  sessionId?: string;
}

export interface BotComputerPtySessionInfo {
  sessionId: string;
  engine: BotComputerEngineId;
  cwd: string;
  alive: boolean;
  outputTail: string;
  updatedAt: number;
  cols?: number;
  rows?: number;
  exitCode?: number | null;
}

export interface BotComputerFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  sizeBytes: number;
  updatedAt: number;
  mimeType?: string;
  readonly?: boolean;
}

export interface BotComputerStudioSnapshot {
  activeEngine: BotComputerEngineId;
  activeTab: BotComputerViewTab;
  autoFollow: boolean;
  localLinux?: BotLocalLinuxDesktopStatus;
  localWinPip?: BotLocalWinPipStatus;
  remoteNodes: BotRemoteComputerNode[];
  activeRemoteNodeId?: string;
  latestFrame?: BotComputerStreamFrame;
  takeover: BotComputerTakeoverState;
  timeline: BotComputerTimelineStep[];
  pty?: BotComputerPtySessionInfo;
  files?: BotComputerFileEntry[];
  filesCwd?: string;
}

export type BotComputerEngineActionKind =
  | "start"
  | "stop"
  | "restart"
  | "provision-linux-gui"
  | "enable-win-child-session"
  | "open-native-desktop"
  | "launch-app"
  | "close-window"
  | "connect-remote"
  | "disconnect-remote"
  | "sync-autonomy-lease";

export interface BotComputerSelectParams {
  engine?: BotComputerEngineId;
  tab?: BotComputerViewTab;
  autoFollow?: boolean;
  activeRemoteNodeId?: string;
}

export interface BotComputerEngineActionParams {
  engine: BotComputerEngineId;
  action: BotComputerEngineActionKind;
  forceOpen?: boolean;
  appOrUrl?: string;
  launchKind?: "browser" | "app";
  hwnd?: string;
  remoteNodeId?: string;
}

export interface BotComputerEngineActionResult {
  ok: boolean;
  message: string;
  elevationRequired?: boolean;
  snapshot: BotComputerStudioSnapshot;
}

export interface BotComputerRemoteNodeUpsertParams {
  id?: string;
  alias: string;
  kind: BotRemoteNodeKind;
  host: string;
  port?: number;
  username?: string;
  workDir?: string;
  authMethod?: BotRemoteAuthMethod;
  privateKeyPath?: string;
  password?: string;
}

export interface BotComputerStreamControlParams {
  active: boolean;
  engine?: BotComputerEngineId;
  tab?: BotComputerStreamTab;
  fps?: number;
}

export interface BotComputerTakeoverActionParams {
  action: "request" | "start" | "release";
  engine?: BotComputerEngineId;
  tab?: BotComputerViewTab;
  reason?: string;
  targetUrlOrApp?: string;
  sessionId?: string;
}

export interface BotComputerPtyWriteParams {
  sessionId?: string;
  engine?: BotComputerEngineId;
  data: string;
}

export interface BotComputerFilesListParams {
  engine?: BotComputerEngineId;
  path?: string;
}

export interface BotComputerFilesListResult {
  engine: BotComputerEngineId;
  cwd: string;
  entries: BotComputerFileEntry[];
}

export interface BotComputerFilesReadParams {
  engine?: BotComputerEngineId;
  path: string;
  maxBytes?: number;
}

export interface BotComputerFilesReadResult {
  path: string;
  content?: string;
  dataBase64?: string;
  mimeType?: string;
  sizeBytes: number;
  isBinary: boolean;
}

export interface BotComputerRpcMethodMap {
  "bot.computer.getSnapshot": { params: { engine?: BotComputerEngineId; includeFrame?: boolean }; result: BotComputerStudioSnapshot };
  "bot.computer.select": { params: BotComputerSelectParams; result: BotComputerStudioSnapshot };
  "bot.computer.action": { params: BotComputerEngineActionParams; result: BotComputerEngineActionResult };
  "bot.computer.remoteNode.upsert": { params: BotComputerRemoteNodeUpsertParams; result: { node: BotRemoteComputerNode; snapshot: BotComputerStudioSnapshot } };
  "bot.computer.remoteNode.delete": { params: { id: string }; result: { ok: true; snapshot: BotComputerStudioSnapshot } };
  "bot.computer.stream": { params: BotComputerStreamControlParams; result: { ok: true } };
  "bot.computer.input": { params: BotComputerInputEvent; result: { ok: boolean; frame?: BotComputerStreamFrame } };
  "bot.computer.navigate": { params: { url: string; engine?: BotComputerEngineId }; result: { ok: boolean; frame?: BotComputerStreamFrame; snapshot: BotComputerStudioSnapshot } };
  "bot.computer.takeover": { params: BotComputerTakeoverActionParams; result: { takeover: BotComputerTakeoverState; snapshot: BotComputerStudioSnapshot } };
  "bot.computer.pty.open": { params: { engine?: BotComputerEngineId; cwd?: string; cols?: number; rows?: number }; result: { pty: BotComputerPtySessionInfo } };
  "bot.computer.pty.write": { params: BotComputerPtyWriteParams; result: { pty: BotComputerPtySessionInfo } };
  "bot.computer.pty.resize": { params: { sessionId?: string; engine?: BotComputerEngineId; cols: number; rows: number }; result: { ok: true } };
  "bot.computer.pty.close": { params: { sessionId?: string; engine?: BotComputerEngineId }; result: { ok: true } };
  "bot.computer.files.list": { params: BotComputerFilesListParams; result: BotComputerFilesListResult };
  "bot.computer.files.read": { params: BotComputerFilesReadParams; result: BotComputerFilesReadResult };
}

/** Server-push notification payload broadcast on `bot/computer`. */
export type BotComputerEventNotification =
  | { kind: "frame"; frame: BotComputerStreamFrame }
  | { kind: "pointer"; engine: BotComputerEngineId; tab: BotComputerViewTab; pointer: BotComputerPointerTelemetry }
  | { kind: "timeline"; step: BotComputerTimelineStep }
  | { kind: "takeover"; takeover: BotComputerTakeoverState }
  | { kind: "pty"; sessionId: string; engine: BotComputerEngineId; chunk: string; alive: boolean; updatedAt: number }
  | { kind: "snapshot"; snapshot: BotComputerStudioSnapshot };

