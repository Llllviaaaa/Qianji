/**
 * Virtual Server (Local & Remote) state transitions for `BotStateStore`.
 */
import type {
  BotServerActionKind,
  BotServerActionResult,
  BotServerMode,
  BotVirtualServerStatus,
} from "@qianji/protocol";
import type { PersistedBotState } from "./defaults.ts";

export interface VirtualServerPatch {
  mode?: BotServerMode;
  cpuCores?: number;
  memoryLimitGb?: number;
  diskLimitGb?: number;
  autoSleepIdle?: boolean;
  remoteHost?: string;
  remotePort?: number;
  remoteUser?: string;
  remoteWorkDir?: string;
}

export function applyVirtualServerPatch(
  st: PersistedBotState,
  patch: VirtualServerPatch,
): BotVirtualServerStatus {
  if (patch.mode === "local" || patch.mode === "remote") {
    st.virtualServer.mode = patch.mode;
    st.virtualServer.lifecycle = "running";
    if (patch.mode === "remote") {
      st.virtualServer.latencyMs = 32;
      st.virtualServer.remote.offlineSyncedAt = Date.now();
    }
  }
  if (typeof patch.cpuCores === "number") st.virtualServer.local.cpuCores = Math.max(1, patch.cpuCores);
  if (typeof patch.memoryLimitGb === "number") st.virtualServer.local.memoryLimitGb = Math.max(1, patch.memoryLimitGb);
  if (typeof patch.diskLimitGb === "number") st.virtualServer.local.diskLimitGb = Math.max(8, patch.diskLimitGb);
  if (typeof patch.autoSleepIdle === "boolean") st.virtualServer.local.autoSleepIdle = patch.autoSleepIdle;
  if (typeof patch.remoteHost === "string") st.virtualServer.remote.host = patch.remoteHost.trim();
  if (typeof patch.remotePort === "number") st.virtualServer.remote.port = Math.max(1, patch.remotePort);
  if (typeof patch.remoteUser === "string") st.virtualServer.remote.username = patch.remoteUser.trim();
  if (typeof patch.remoteWorkDir === "string") st.virtualServer.remote.workDir = patch.remoteWorkDir.trim();
  return st.virtualServer;
}

export function runVirtualServerAction(
  st: PersistedBotState,
  action: BotServerActionKind,
  onActivity: (input: { title: string; description: string }) => void,
): BotServerActionResult {
  let message = "虚拟服务器状态已更新";
  if (action === "sleep") {
    st.virtualServer.lifecycle = "sleeping";
    st.virtualServer.local.cpuUsagePercent = 0;
    st.virtualServer.local.memoryUsedGb = 0.1;
    message = "虚拟服务器已进入休眠状态，已释放本机内存资源";
  } else if (action === "start" || action === "restart") {
    st.virtualServer.lifecycle = "running";
    st.virtualServer.local.cpuUsagePercent = 8;
    st.virtualServer.local.memoryUsedGb = 1.2;
    st.virtualServer.uptimeLabel = action === "restart" ? "刚刚重启 · 运行正常" : "运行中";
    message = action === "restart" ? "虚拟服务器已完成重启并恢复值守" : "虚拟服务器已唤醒并恢复运行";
  } else if (action === "reset-snapshot") {
    st.virtualServer.lifecycle = "running";
    st.virtualServer.local.diskUsedGb = 2.1;
    st.virtualServer.local.memoryUsedGb = 0.9;
    st.virtualServer.local.lastSnapshotAt = Date.now();
    onActivity({
      title: "恢复虚拟服务器初始纯净快照",
      description: "Reset virtual server environment while preserving SOUL.md, chat history, and long-term memory",
    });
    message = "虚拟服务器环境已恢复至纯净快照（SOUL 人格与长期记忆已完整保留）";
  } else if (action === "test-remote") {
    st.virtualServer.latencyMs = 29;
    message = "远端虚拟服务器连接测试正常（延迟 29ms）";
  } else if (action === "init-remote") {
    st.virtualServer.remote.initialized = true;
    st.virtualServer.mode = "remote";
    st.virtualServer.lifecycle = "running";
    st.virtualServer.latencyMs = 29;
    st.virtualServer.remote.offlineSyncedAt = Date.now();
    onActivity({
      title: "完成远端虚拟服务器初始化与离线追平",
      description: "Initialized remote 24/7 virtual server environment and synced offline messages",
    });
    message = "远端虚拟服务器已完成一键初始化，支持合盖关机 7×24h 全天候在线";
  }
  return { ok: true, message, virtualServer: st.virtualServer };
}
