/**
 * Dedicated WSL2 Linux container runtime (`qianji-bot-vm`) for Qianji Local Virtual Server.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BotLocalEngineKind, BotLocalEngineState, BotSharedFolderRule } from "@qianji/protocol";
import { syncIsolatedCopyWithWorktree } from "./computer/local-linux-engine.ts";
import { migrateStorageSubdirs } from "./storage-paths.ts";
import {
  buildMountedExecScript,
  runWslSubprocess,
  sharedFolderSlug,
  stripWslStderrNoise,
  winPathToWslMount,
  type WslExecResult,
} from "./wsl-exec-helpers.ts";

export { runWslSubprocess, sharedFolderSlug, stripWslStderrNoise, winPathToWslMount, type WslExecResult };

const ALPINE_VERSION = "3.21.3";
const CACHE_TTL_MS = 3_000;
let hostWslSupportedCache: boolean | undefined;

export function isWslStatusProbeOk(probe: {
  readonly error?: Error | undefined;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
}): boolean {
  return probe.error === undefined && probe.status === 0 && probe.signal === null;
}

export interface WslInspectSnapshot {
  engine: BotLocalEngineKind;
  engineState: BotLocalEngineState;
  distroName: string;
  kernelVersion?: string;
  vhdxPath?: string;
  vhdxBytes: number;
  cgroupMemoryBytes?: number;
  guestUptimeSec?: number;
  isolationSummary: string;
}

export interface WslRuntimeOptions {
  dataDir: string;
  botDir: string;
  botWorkspaceDir: string;
  distroName?: string;
  wslSupported?: boolean;
}

export class WslContainerRuntime {
  readonly distroName: string;

  private storageDir: string;
  private botWorkspaceDir: string;
  private supportedCache: boolean | undefined;
  private provisioning = false;
  private cachedSnapshot: { ts: number; value: WslInspectSnapshot } | undefined;
  private lastKernelVersion: string | undefined;
  private keepaliveChild: ChildProcess | null = null;

  constructor(opts: WslRuntimeOptions) {
    this.distroName = opts.distroName ?? "qianji-bot-vm";
    this.storageDir = resolve(opts.botDir);
    this.botWorkspaceDir = resolve(opts.botWorkspaceDir);
    this.supportedCache = opts.wslSupported;
  }

  get instanceDir(): string {
    return join(this.storageDir, "wsl-instance");
  }

  get cacheDir(): string {
    return join(this.storageDir, "vm-cache");
  }

  get sharedCopiesDir(): string {
    return join(this.storageDir, "shared-copies");
  }

  get vhdxPath(): string {
    return join(this.instanceDir, "ext4.vhdx");
  }

  get goldenTarPath(): string {
    return join(this.cacheDir, "golden-rootfs.tar");
  }

  setPaths(next: { storageDir: string; botWorkspaceDir: string }): void {
    const nextStorage = resolve(next.storageDir);
    const nextWs = resolve(next.botWorkspaceDir);
    if (this.storageDir !== nextStorage) {
      this.storageDir = nextStorage;
      this.invalidateCache();
    }
    this.botWorkspaceDir = nextWs;
  }

  async relocateStorage(nextStorageDir: string, nextWorkspaceDir: string): Promise<void> {
    const targetStorage = resolve(nextStorageDir);
    const targetWs = resolve(nextWorkspaceDir);
    if (this.storageDir.toLowerCase() === targetStorage.toLowerCase()) {
      this.setPaths({ storageDir: targetStorage, botWorkspaceDir: targetWs });
      return;
    }

    const prevStorage = this.storageDir;
    const prevInstanceDir = this.instanceDir;
    mkdirSync(targetStorage, { recursive: true });

    if (this.isSupported()) {
      const distros = await this.listDistros();
      const installed = distros.some((d) => d.name.toLowerCase() === this.distroName.toLowerCase());
      if (installed) {
        await this.sleep();
        const nextCacheDir = join(targetStorage, "vm-cache");
        const nextInstanceDir = join(targetStorage, "wsl-instance");
        mkdirSync(nextCacheDir, { recursive: true });
        mkdirSync(nextInstanceDir, { recursive: true });
        const exportTar = join(nextCacheDir, "relocated-rootfs.tar");
        const exp = await runWslSubprocess("wsl.exe", ["--export", this.distroName, exportTar], { timeoutMs: 120_000 });
        if (exp.exitCode !== 0) {
          throw new Error(`导出 WSL2 容器镜像失败：${stripWslStderrNoise(exp.stderr) || exp.stdout}`);
        }
        await runWslSubprocess("wsl.exe", ["--unregister", this.distroName], { timeoutMs: 20_000 });
        rmSync(prevInstanceDir, { recursive: true, force: true });
        const imp = await runWslSubprocess(
          "wsl.exe",
          ["--import", this.distroName, nextInstanceDir, exportTar, "--version", "2"],
          { timeoutMs: 120_000 },
        );
        rmSync(exportTar, { force: true });
        if (imp.exitCode !== 0) {
          throw new Error(`迁移导入 WSL2 容器失败：${stripWslStderrNoise(imp.stderr) || imp.stdout}`);
        }
      } else {
        rmSync(prevInstanceDir, { recursive: true, force: true });
      }
    } else {
      rmSync(prevInstanceDir, { recursive: true, force: true });
    }

    migrateStorageSubdirs(prevStorage, targetStorage);
    this.setPaths({ storageDir: targetStorage, botWorkspaceDir: targetWs });
    this.invalidateCache();
  }

  invalidateCache(): void {
    this.cachedSnapshot = undefined;
  }

  private startKeepalive(): void {
    if (!this.isSupported() || this.keepaliveChild !== null) return;
    const child = spawn(
      "wsl.exe",
      ["-d", this.distroName, "--cd", "/", "-u", "bot", "--", "/bin/sh", "-c", "exec sleep 86400"],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, WSL_UTF8: "1" },
      },
    );
    child.on("exit", () => {
      if (this.keepaliveChild === child) this.keepaliveChild = null;
    });
    child.on("error", () => {
      if (this.keepaliveChild === child) this.keepaliveChild = null;
    });
    child.unref();
    this.keepaliveChild = child;
  }

  private stopKeepalive(): void {
    if (this.keepaliveChild !== null) {
      try {
        this.keepaliveChild.kill();
      } catch {
        // Ignore already-exited keepalive child.
      }
      this.keepaliveChild = null;
    }
  }

  isSupported(): boolean {
    if (this.supportedCache !== undefined) return this.supportedCache;
    if (hostWslSupportedCache !== undefined) {
      this.supportedCache = hostWslSupportedCache;
      return this.supportedCache;
    }
    if (process.platform !== "win32") {
      this.supportedCache = false;
      hostWslSupportedCache = false;
      return false;
    }
    const probe = spawnSync("wsl.exe", ["--status"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3_000,
      env: { ...process.env, WSL_UTF8: "1" },
    });
    const supported = isWslStatusProbeOk(probe);
    this.supportedCache = supported;
    hostWslSupportedCache = supported;
    return supported;
  }

  private async listDistros(): Promise<Array<{ name: string; state: string; version: string }>> {
    const res = await runWslSubprocess("wsl.exe", ["--list", "--verbose"], { timeoutMs: 8_000 });
    const cleanStdout = res.stdout.replace(/\0/g, "").replace(/^\ufeff/, "");
    if (res.exitCode !== 0 && cleanStdout.trim() === "") return [];
    const lines = cleanStdout.split(/\r?\n/).slice(1);
    const out: Array<{ name: string; state: string; version: string }> = [];
    for (const raw of lines) {
      const cleaned = raw.replace(/^\s*\*?\s*/, "").trim();
      if (cleaned === "") continue;
      const parts = cleaned.split(/\s{2,}/);
      if (parts.length >= 3 && parts[0] && parts[1] && parts[2]) {
        out.push({ name: parts[0].trim(), state: parts[1].trim(), version: parts[2].trim() });
      }
    }
    return out;
  }

  async inspect(force = false): Promise<WslInspectSnapshot> {
    if (!force && this.cachedSnapshot && Date.now() - this.cachedSnapshot.ts < CACHE_TTL_MS) {
      return this.cachedSnapshot.value;
    }
    if (!this.isSupported()) {
      return {
        engine: "host-fallback",
        engineState: "unavailable",
        distroName: this.distroName,
        vhdxBytes: 0,
        isolationSummary: "当前系统不支持 WSL2，使用宿主机隔离目录运行",
      };
    }

    const vhdxBytes = existsSync(this.vhdxPath) ? statSync(this.vhdxPath).size : 0;
    if (this.provisioning) {
      return {
        engine: "wsl2",
        engineState: "provisioning",
        distroName: this.distroName,
        vhdxPath: this.vhdxPath,
        vhdxBytes,
        isolationSummary: "正在下载并初始化独立 Alpine WSL2 容器...",
      };
    }

    const distros = await this.listDistros();
    const match = distros.find((d) => d.name.toLowerCase() === this.distroName.toLowerCase());
    if (!match) {
      const snap: WslInspectSnapshot = {
        engine: "wsl2",
        engineState: "not-installed",
        distroName: this.distroName,
        vhdxPath: this.vhdxPath,
        vhdxBytes: 0,
        isolationSummary: "WSL2 就绪 · 点击下方按钮一键创建专属隔离 Linux 容器",
      };
      this.cachedSnapshot = { ts: Date.now(), value: snap };
      return snap;
    }

    const running = match.state.toLowerCase() === "running";
    let guestUptimeSec: number | undefined;
    let cgroupMemoryBytes: number | undefined;
    if (running) {
      const probe = await runWslSubprocess(
        "wsl.exe",
        ["-d", this.distroName, "--cd", "/", "-u", "root", "--", "/bin/sh", "-s"],
        {
          timeoutMs: 6_000,
          stdin: "uname -sr\ncut -d' ' -f1 /proc/uptime\ncat /sys/fs/cgroup/qianji-bot/memory.current 2>/dev/null || cat /sys/fs/cgroup/memory/qianji-bot/memory.usage_in_bytes 2>/dev/null || echo 0\n",
        },
      );
      const lines = probe.stdout.trim().split(/\r?\n/);
      if (lines[0]) this.lastKernelVersion = lines[0].trim();
      const upNum = Number.parseFloat(lines[1] ?? "0");
      if (Number.isFinite(upNum)) guestUptimeSec = Math.max(1, Math.floor(upNum));
      const memNum = Number.parseInt(lines[2] ?? "0", 10);
      if (Number.isFinite(memNum) && memNum > 0) cgroupMemoryBytes = memNum;
    }

    const snap: WslInspectSnapshot = {
      engine: "wsl2",
      engineState: running ? "running" : "stopped",
      distroName: this.distroName,
      kernelVersion: this.lastKernelVersion,
      vhdxPath: this.vhdxPath,
      vhdxBytes,
      cgroupMemoryBytes,
      guestUptimeSec,
      isolationSummary: "WSL2 独立 VHDX · interop=off · unshare -m · cgroup v2 · uid=1000(bot)",
    };
    this.cachedSnapshot = { ts: Date.now(), value: snap };
    return snap;
  }

  private async ensureRootfsTarball(): Promise<string> {
    mkdirSync(this.cacheDir, { recursive: true });
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
    const fileName = `alpine-minirootfs-${ALPINE_VERSION}-${arch}.tar.gz`;
    const tarball = join(this.cacheDir, fileName);

    if (existsSync(tarball) && statSync(tarball).size > 2_000_000) {
      const hdr = readFileSync(tarball).subarray(0, 2);
      if (hdr[0] === 0x1f && hdr[1] === 0x8b) return tarball;
    }

    const urls = [
      `https://mirrors.aliyun.com/alpine/v3.21/releases/${arch}/${fileName}`,
      `https://mirrors.tuna.tsinghua.edu.cn/alpine/v3.21/releases/${arch}/${fileName}`,
      `https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/${arch}/${fileName}`,
    ];
    let lastErr = "下载失败";
    for (const url of urls) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) {
          lastErr = `HTTP ${res.status} (${url})`;
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 2_000_000 || buf[0] !== 0x1f || buf[1] !== 0x8b) {
          lastErr = `镜像文件校验失败 (${url})`;
          continue;
        }
        const tmp = `${tarball}.${process.pid}.tmp`;
        writeFileSync(tmp, buf);
        renameSync(tmp, tarball);
        return tarball;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
    }
    throw new Error(`无法下载 Alpine 容器基础镜像：${lastErr}`);
  }

  private async configureGuestSystem(): Promise<void> {
    const setupScript = [
      `mkdir -p /etc /home/bot /workspace /shared`,
      `printf '[interop]\\nenabled = false\\nappendWindowsPath = false\\n\\n[user]\\ndefault = bot\\n' > /etc/wsl.conf`,
      `id bot >/dev/null 2>&1 || (addgroup -g 1000 -S bot 2>/dev/null || true; adduser -D -u 1000 -G bot -h /home/bot -s /bin/sh bot 2>/dev/null || true)`,
      `chown -R 1000:1000 /home/bot`,
      `(apk update >/dev/null 2>&1 && apk add --no-cache bash su-exec coreutils findutils grep sed gawk curl git ca-certificates python3 ripgrep >/dev/null 2>&1) || true`,
      `if [ -x /bin/bash ]; then sed -i 's|^bot:\\(.*\\):/bin/sh$|bot:\\1:/bin/bash|' /etc/passwd 2>/dev/null || true; fi`,
    ].join("\n");

    const res = await runWslSubprocess(
      "wsl.exe",
      ["-d", this.distroName, "--cd", "/", "-u", "root", "--", "/bin/sh", "-s"],
      { timeoutMs: 120_000, stdin: `${setupScript}\n` },
    );
    if (res.exitCode !== 0) {
      throw new Error(`容器内部初始化失败：${stripWslStderrNoise(res.stderr) || res.stdout}`);
    }
    await runWslSubprocess("wsl.exe", ["--terminate", this.distroName], { timeoutMs: 10_000 });
    await runWslSubprocess("wsl.exe", ["-d", this.distroName, "--cd", "/", "-u", "root", "--", "true"], { timeoutMs: 15_000 });
  }

  async provision(): Promise<WslInspectSnapshot> {
    if (!this.isSupported()) return this.inspect(true);
    if (this.provisioning) throw new Error("WSL2 容器正在初始化中，请稍候");
    this.provisioning = true;
    this.invalidateCache();
    try {
      const existing = await this.listDistros();
      if (!existing.some((d) => d.name.toLowerCase() === this.distroName.toLowerCase())) {
        const tarball = await this.ensureRootfsTarball();
        mkdirSync(this.instanceDir, { recursive: true });
        const imp = await runWslSubprocess(
          "wsl.exe",
          ["--import", this.distroName, this.instanceDir, tarball, "--version", "2"],
          { timeoutMs: 120_000 },
        );
        if (imp.exitCode !== 0) {
          throw new Error(`WSL2 导入失败：${stripWslStderrNoise(imp.stderr) || imp.stdout}`);
        }
      }
      await this.configureGuestSystem();
      if (!existsSync(this.goldenTarPath)) {
        await runWslSubprocess("wsl.exe", ["--terminate", this.distroName], { timeoutMs: 10_000 });
        await runWslSubprocess("wsl.exe", ["--export", this.distroName, this.goldenTarPath], { timeoutMs: 90_000 });
        await runWslSubprocess("wsl.exe", ["-d", this.distroName, "--cd", "/", "-u", "root", "--", "true"], { timeoutMs: 15_000 });
      }
      this.startKeepalive();
      this.provisioning = false;
      this.invalidateCache();
      return await this.inspect(true);
    } finally {
      this.provisioning = false;
      this.invalidateCache();
    }
  }

  syncIsolatedSharedCopy(rule: BotSharedFolderRule, slug: string): string {
    return syncIsolatedCopyWithWorktree(rule, join(this.sharedCopiesDir, slug));
  }

  async exec(
    command: string,
    options: {
      guestCwd?: string;
      cpuCores: number;
      memoryLimitGb: number;
      sharedFolders: readonly BotSharedFolderRule[];
      timeoutMs?: number;
    },
  ): Promise<WslExecResult> {
    const status = await this.inspect();
    if (status.engineState === "not-installed") {
      await this.provision();
    }
    const sharedMounts = options.sharedFolders
      .filter((r) => existsSync(r.path))
      .map((rule, idx) => {
        const slug = sharedFolderSlug(rule.path, idx);
        const hostPath = rule.access === "isolated-copy" ? this.syncIsolatedSharedCopy(rule, slug) : rule.path;
        return { slug, sourceMount: winPathToWslMount(hostPath), readOnly: rule.access === "read-only" };
      });

    const script = buildMountedExecScript({
      guestCwd: options.guestCwd ?? "/workspace",
      workspaceMount: winPathToWslMount(this.botWorkspaceDir),
      sharedMounts,
      cpuCores: options.cpuCores,
      memoryLimitGb: options.memoryLimitGb,
      b64Command: Buffer.from(command, "utf8").toString("base64"),
    });

    const res = await runWslSubprocess(
      "wsl.exe",
      ["-d", this.distroName, "--cd", "/", "-u", "root", "--", "unshare", "-m", "/bin/sh", "-s"],
      { timeoutMs: options.timeoutMs ?? 60_000, stdin: `${script}\n` },
    );
    this.invalidateCache();
    return { stdout: res.stdout, stderr: stripWslStderrNoise(res.stderr), exitCode: res.exitCode, durationMs: res.durationMs };
  }

  async sleep(): Promise<void> {
    if (!this.isSupported()) return;
    this.stopKeepalive();
    await runWslSubprocess("wsl.exe", ["--terminate", this.distroName], { timeoutMs: 12_000 });
    this.invalidateCache();
  }

  async wake(): Promise<WslInspectSnapshot> {
    const cur = await this.inspect(true);
    if (cur.engineState === "not-installed") return this.provision();
    if (cur.engine === "wsl2" && cur.engineState === "stopped") {
      await runWslSubprocess("wsl.exe", ["-d", this.distroName, "--cd", "/", "-u", "root", "--", "true"], { timeoutMs: 15_000 });
    }
    this.startKeepalive();
    return this.inspect(true);
  }

  async resetSnapshot(): Promise<WslInspectSnapshot> {
    if (!this.isSupported()) return this.inspect(true);
    this.stopKeepalive();
    this.invalidateCache();
    if (existsSync(this.goldenTarPath)) {
      await runWslSubprocess("wsl.exe", ["--terminate", this.distroName], { timeoutMs: 10_000 });
      await runWslSubprocess("wsl.exe", ["--unregister", this.distroName], { timeoutMs: 20_000 });
      rmSync(this.instanceDir, { recursive: true, force: true });
      mkdirSync(this.instanceDir, { recursive: true });
      const imp = await runWslSubprocess(
        "wsl.exe",
        ["--import", this.distroName, this.instanceDir, this.goldenTarPath, "--version", "2"],
        { timeoutMs: 90_000 },
      );
      if (imp.exitCode === 0) {
        await runWslSubprocess("wsl.exe", ["-d", this.distroName, "--cd", "/", "-u", "root", "--", "true"], { timeoutMs: 15_000 });
        this.startKeepalive();
        return this.inspect(true);
      }
    }
    await runWslSubprocess("wsl.exe", ["--unregister", this.distroName], { timeoutMs: 15_000 });
    rmSync(this.instanceDir, { recursive: true, force: true });
    return this.provision();
  }

  async unregister(): Promise<void> {
    if (!this.isSupported()) return;
    this.stopKeepalive();
    await runWslSubprocess("wsl.exe", ["--terminate", this.distroName], { timeoutMs: 8_000 });
    await runWslSubprocess("wsl.exe", ["--unregister", this.distroName], { timeoutMs: 15_000 });
    rmSync(this.instanceDir, { recursive: true, force: true });
    this.invalidateCache();
  }
}
