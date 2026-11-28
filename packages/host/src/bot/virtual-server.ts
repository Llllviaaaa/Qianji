/**
 * Real Local (WSL2 Container) & Remote (OpenSSH) Virtual Server orchestrator
 * for `BotStateStore`.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { cpus } from "node:os";
import { join } from "node:path";
import type {
  BotRemoteAuthMethod,
  BotServerActionKind,
  BotServerActionResult,
  BotServerMode,
  BotVirtualServerStatus,
} from "@qianji/protocol";
import type { PersistedBotState } from "./defaults.ts";
import type { SshRemoteRuntime } from "./ssh-runtime.ts";
import type { WslContainerRuntime } from "./wsl-runtime.ts";

export interface VirtualServerPatch {
  mode?: BotServerMode;
  cpuCores?: number;
  memoryLimitGb?: number;
  diskLimitGb?: number;
  autoSleepIdle?: boolean;
  storageDir?: string;
  remoteHost?: string;
  remotePort?: number;
  remoteUser?: string;
  remoteWorkDir?: string;
  remoteAuthMethod?: BotRemoteAuthMethod;
  remotePrivateKeyPath?: string;
  sharedFolderAdd?: { path: string; access: "read-only" | "isolated-copy" };
  sharedFolderRemove?: string;
}

export interface ServerRuntimeDeps {
  botDir: string;
  botStorageDir: string;
  customStorageDir?: string;
  botWorkspaceDir: string;
  wsl: WslContainerRuntime;
  ssh: SshRemoteRuntime;
  getSoul: () => string;
  getMemory: () => string;
  getRemotePassword: () => Promise<string | undefined>;
  hasRemotePassword: () => Promise<boolean>;
}

const BOOT_TS = Date.now();

export function computeDirectoryBytes(dir: string, depth = 0): number {
  if (depth > 4 || !existsSync(dir)) return 0;
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += computeDirectoryBytes(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          total += statSync(full).size;
        } catch {
          // Ignore transient lock files.
        }
      }
    }
  } catch {
    return 0;
  }
  return total;
}

export function formatUptimeSeconds(seconds: number): string {
  const elapsedMin = Math.max(1, Math.floor(seconds / 60));
  if (elapsedMin < 60) return `已运行 ${elapsedMin} 分钟`;
  const hours = Math.floor(elapsedMin / 60);
  const mins = elapsedMin % 60;
  if (hours < 24) return `已运行 ${hours} 小时 ${mins} 分钟`;
  const days = Math.floor(hours / 24);
  return `已运行 ${days} 天 ${hours % 24} 小时`;
}

export async function refreshLiveLocalMetrics(
  st: PersistedBotState,
  deps: ServerRuntimeDeps,
  force = false,
): Promise<void> {
  const wslSnap = await deps.wsl.inspect(force);
  st.virtualServer.local.engine = wslSnap.engine;
  st.virtualServer.local.engineState = wslSnap.engineState;
  st.virtualServer.local.distroName = wslSnap.distroName;
  st.virtualServer.local.kernelVersion = wslSnap.kernelVersion;
  st.virtualServer.local.vhdxPath = wslSnap.vhdxPath;
  st.virtualServer.local.storageDir = deps.botStorageDir;
  st.virtualServer.local.customStorageDir = deps.customStorageDir ?? "";
  st.virtualServer.local.isolationSummary = wslSnap.isolationSummary;
  st.virtualServer.remote.hasStoredSecret = await deps.hasRemotePassword();

  const workspaceBytes = computeDirectoryBytes(deps.botWorkspaceDir);
  const totalBytes = wslSnap.vhdxBytes + workspaceBytes;
  st.virtualServer.local.diskUsedGb = Number(Math.max(0.01, totalBytes / 1024 ** 3).toFixed(2));

  const hostCores = Math.max(1, cpus().length);
  st.virtualServer.local.cpuCores = Math.min(Math.max(1, st.virtualServer.local.cpuCores || 2), hostCores);

  if (st.virtualServer.mode === "remote") {
    st.virtualServer.lifecycle = st.virtualServer.remote.initialized ? "running" : "offline";
    if (!st.virtualServer.remote.initialized) {
      st.virtualServer.uptimeLabel = "远端待连接";
    }
    return;
  }

  if (wslSnap.engine === "wsl2") {
    if (wslSnap.engineState === "not-installed") {
      st.virtualServer.lifecycle = "offline";
      st.virtualServer.uptimeLabel = "WSL2 容器待初始化";
      st.virtualServer.local.cpuUsagePercent = 0;
      st.virtualServer.local.memoryUsedGb = 0;
      return;
    }
    if (wslSnap.engineState === "provisioning") {
      st.virtualServer.lifecycle = "connecting";
      st.virtualServer.uptimeLabel = "正在创建 WSL2 容器…";
      return;
    }
    if (wslSnap.engineState === "stopped") {
      st.virtualServer.lifecycle = "sleeping";
      st.virtualServer.uptimeLabel = "休眠待命";
      st.virtualServer.local.cpuUsagePercent = 0;
      st.virtualServer.local.memoryUsedGb = 0;
      return;
    }
    st.virtualServer.lifecycle = "running";
    st.virtualServer.uptimeLabel = wslSnap.guestUptimeSec
      ? formatUptimeSeconds(wslSnap.guestUptimeSec)
      : "运行中";
    st.virtualServer.local.memoryUsedGb = wslSnap.cgroupMemoryBytes
      ? Number(Math.max(0.02, wslSnap.cgroupMemoryBytes / 1024 ** 3).toFixed(2))
      : 0.08;
    return;
  }

  // Fallback for non-Windows hosts
  if (st.virtualServer.lifecycle === "sleeping") {
    st.virtualServer.uptimeLabel = "休眠待命";
    st.virtualServer.local.cpuUsagePercent = 0;
    st.virtualServer.local.memoryUsedGb = 0.05;
    return;
  }
  const rssGb = Number((process.memoryUsage().rss / 1024 ** 3).toFixed(2));
  st.virtualServer.local.memoryUsedGb = Math.max(0.12, rssGb);
  st.virtualServer.uptimeLabel = formatUptimeSeconds((Date.now() - BOOT_TS) / 1000);
}

export function probeTcpEndpoint(
  host: string,
  port: number,
  timeoutMs = 3500,
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const trimmed = host.trim();
  if (trimmed === "") {
    return Promise.resolve({ ok: false, error: "请先填写远端虚拟服务器主机地址" });
  }
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection({ host: trimmed, port });
    const finish = (res: { ok: boolean; latencyMs?: number; error?: string }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(res);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      finish({ ok: true, latencyMs: Math.max(1, Date.now() - started) });
    });
    socket.once("timeout", () => {
      finish({ ok: false, error: `连接 ${trimmed}:${port} 超时（>${timeoutMs}ms）` });
    });
    socket.once("error", (err) => {
      finish({ ok: false, error: `无法连接 ${trimmed}:${port}：${err.message}` });
    });
  });
}

export function applyVirtualServerPatch(
  st: PersistedBotState,
  patch: VirtualServerPatch,
  botWorkspaceDir?: string,
): BotVirtualServerStatus {
  if (patch.mode === "local" || patch.mode === "remote") {
    st.virtualServer.mode = patch.mode;
    if (patch.mode === "remote") {
      st.virtualServer.lifecycle = st.virtualServer.remote.initialized ? "running" : "offline";
    }
  }
  if (typeof patch.cpuCores === "number") st.virtualServer.local.cpuCores = Math.max(1, patch.cpuCores);
  if (typeof patch.memoryLimitGb === "number") st.virtualServer.local.memoryLimitGb = Math.max(1, patch.memoryLimitGb);
  if (typeof patch.diskLimitGb === "number") st.virtualServer.local.diskLimitGb = Math.max(8, patch.diskLimitGb);
  if (typeof patch.autoSleepIdle === "boolean") st.virtualServer.local.autoSleepIdle = patch.autoSleepIdle;
  if (typeof patch.storageDir === "string") {
    const trimmed = patch.storageDir.trim();
    st.virtualServer.local.customStorageDir = trimmed !== "" ? trimmed : undefined;
  }
  if (typeof patch.remoteHost === "string") st.virtualServer.remote.host = patch.remoteHost.trim();
  if (typeof patch.remotePort === "number") st.virtualServer.remote.port = Math.max(1, patch.remotePort);
  if (typeof patch.remoteUser === "string") st.virtualServer.remote.username = patch.remoteUser.trim();
  if (typeof patch.remoteWorkDir === "string") st.virtualServer.remote.workDir = patch.remoteWorkDir.trim();
  if (patch.remoteAuthMethod === "agent-or-key" || patch.remoteAuthMethod === "password") {
    st.virtualServer.remote.authMethod = patch.remoteAuthMethod;
  }
  if (typeof patch.remotePrivateKeyPath === "string") {
    st.virtualServer.remote.privateKeyPath = patch.remotePrivateKeyPath.trim();
  }
  if (patch.sharedFolderAdd && patch.sharedFolderAdd.path.trim() !== "") {
    const cleanPath = patch.sharedFolderAdd.path.trim();
    const isSelf = botWorkspaceDir && cleanPath.toLowerCase() === botWorkspaceDir.toLowerCase();
    const exists = st.virtualServer.local.sharedFolders.some((f) => f.path === cleanPath);
    if (!exists && !isSelf) {
      st.virtualServer.local.sharedFolders.push({
        path: cleanPath,
        access: patch.sharedFolderAdd.access,
      });
    }
  }
  if (typeof patch.sharedFolderRemove === "string") {
    st.virtualServer.local.sharedFolders = st.virtualServer.local.sharedFolders.filter(
      (f) => f.path !== patch.sharedFolderRemove,
    );
  }
  return st.virtualServer;
}

export async function runVirtualServerAction(
  st: PersistedBotState,
  action: BotServerActionKind,
  deps: ServerRuntimeDeps,
  onActivity: (input: { title: string; description: string }) => void,
): Promise<BotServerActionResult> {
  if (action === "provision-local") {
    try {
      const wslRes = await deps.wsl.provision();
      await refreshLiveLocalMetrics(st, deps, true);
      onActivity({
        title: "创建并初始化本地 WSL2 隔离容器",
        description: `${wslRes.distroName} (${wslRes.kernelVersion ?? "Linux"}) · ${wslRes.vhdxPath ?? ""}`,
      });
      return {
        ok: wslRes.engineState === "running",
        message:
          wslRes.engine === "wsl2"
            ? `本地 WSL2 容器 (${wslRes.distroName}) 已就绪，支持独立内核、目录隔离与 cgroup 配额`
            : "当前系统不支持 WSL2，已启用宿主机隔离目录",
        virtualServer: st.virtualServer,
      };
    } catch (err) {
      await refreshLiveLocalMetrics(st, deps, true);
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        virtualServer: st.virtualServer,
      };
    }
  }

  if (action === "sleep") {
    await deps.wsl.sleep();
    st.virtualServer.lifecycle = "sleeping";
    await refreshLiveLocalMetrics(st, deps, true);
    return {
      ok: true,
      message: deps.wsl.isSupported()
        ? `已终止 WSL2 实例 (${deps.wsl.distroName})，真正释放宿主机内存`
        : "本地虚拟服务器已进入休眠待命",
      virtualServer: st.virtualServer,
    };
  }

  if (action === "start" || action === "restart") {
    if (action === "restart" && deps.wsl.isSupported()) {
      await deps.wsl.sleep();
    }
    try {
      if (deps.wsl.isSupported()) {
        await deps.wsl.wake();
      } else {
        st.virtualServer.lifecycle = "running";
      }
      await refreshLiveLocalMetrics(st, deps, true);
      return {
        ok: true,
        message: action === "restart" ? "本地虚拟服务器已重启并恢复运行" : "本地虚拟服务器已唤醒就绪",
        virtualServer: st.virtualServer,
      };
    } catch (err) {
      await refreshLiveLocalMetrics(st, deps, true);
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        virtualServer: st.virtualServer,
      };
    }
  }

  if (action === "reset-snapshot") {
    try {
      for (const name of ["tmp", "cache", ".temp"]) {
        rmSync(join(deps.botWorkspaceDir, name), { recursive: true, force: true });
      }
      mkdirSync(deps.botWorkspaceDir, { recursive: true });
      if (deps.wsl.isSupported()) {
        await deps.wsl.resetSnapshot();
      }
      st.virtualServer.local.lastSnapshotAt = Date.now();
      await refreshLiveLocalMetrics(st, deps, true);
      onActivity({
        title: "恢复虚拟服务器初始纯净快照",
        description: "已回滚容器镜像至纯净状态，/workspace、SOUL.md 与长期记忆完整保留",
      });
      return {
        ok: true,
        message: "虚拟服务器镜像已恢复至纯净快照（/workspace、SOUL.md 与记忆完整保留）",
        virtualServer: st.virtualServer,
      };
    } catch (err) {
      await refreshLiveLocalMetrics(st, deps, true);
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        virtualServer: st.virtualServer,
      };
    }
  }

  if (action === "test-remote") {
    const probe = await probeTcpEndpoint(st.virtualServer.remote.host, st.virtualServer.remote.port);
    if (!probe.ok) {
      st.virtualServer.lifecycle = st.virtualServer.mode === "remote" ? "offline" : st.virtualServer.lifecycle;
      return { ok: false, message: probe.error ?? "远端虚拟服务器不可达", virtualServer: st.virtualServer };
    }
    const password = await deps.getRemotePassword();
    const sshProbe = await deps.ssh.testConnection(st.virtualServer.remote, password);
    st.virtualServer.latencyMs = sshProbe.latencyMs || probe.latencyMs;
    st.virtualServer.remote.osSummary = sshProbe.osSummary;
    if (st.virtualServer.mode === "remote") {
      st.virtualServer.lifecycle = sshProbe.ok ? "running" : "offline";
      st.virtualServer.uptimeLabel = sshProbe.ok ? `SSH 在线 · ${st.virtualServer.latencyMs}ms` : "SSH 认证失败";
    }
    return { ok: sshProbe.ok, message: sshProbe.message, virtualServer: st.virtualServer };
  }

  if (action === "init-remote") {
    const password = await deps.getRemotePassword();
    const initRes = await deps.ssh.initEnvironment(
      st.virtualServer.remote,
      deps.getSoul(),
      deps.getMemory(),
      password,
    );
    if (!initRes.ok) {
      st.virtualServer.lifecycle = "offline";
      return { ok: false, message: initRes.message, virtualServer: st.virtualServer };
    }
    st.virtualServer.remote.initialized = true;
    st.virtualServer.remote.osSummary = initRes.osSummary;
    st.virtualServer.remote.offlineSyncedAt = Date.now();
    st.virtualServer.mode = "remote";
    st.virtualServer.lifecycle = "running";
    st.virtualServer.latencyMs = initRes.latencyMs;
    st.virtualServer.uptimeLabel = `远端守护中 · ${initRes.latencyMs}ms`;
    if (initRes.cpuCores) st.virtualServer.local.cpuCores = initRes.cpuCores;
    if (initRes.memoryLimitGb) st.virtualServer.local.memoryLimitGb = initRes.memoryLimitGb;
    if (initRes.memoryUsedGb) st.virtualServer.local.memoryUsedGb = initRes.memoryUsedGb;
    if (initRes.diskLimitGb) st.virtualServer.local.diskLimitGb = initRes.diskLimitGb;
    if (initRes.diskUsedGb) st.virtualServer.local.diskUsedGb = initRes.diskUsedGb;
    onActivity({
      title: "初始化并连接远端 SSH 虚拟服务器",
      description: `${st.virtualServer.remote.username}@${st.virtualServer.remote.host}:${st.virtualServer.remote.port} (${initRes.osSummary})`,
    });
    return { ok: true, message: initRes.message, virtualServer: st.virtualServer };
  }

  return { ok: true, message: "虚拟服务器状态已更新", virtualServer: st.virtualServer };
}
