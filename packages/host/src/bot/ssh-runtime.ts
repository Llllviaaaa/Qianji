/**
 * Real OpenSSH remote execution runtime for Qianji Remote Virtual Server.
 *
 * Uses system OpenSSH (`ssh` / `ssh.exe`) with either SSH key / agent authentication
 * or encrypted password via `SSH_ASKPASS` + temporary self-cleaning helper script.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotRemoteAuthMethod } from "@qianji/protocol";

export interface SshEndpointConfig {
  host: string;
  port: number;
  username: string;
  workDir: string;
  authMethod?: BotRemoteAuthMethod;
  privateKeyPath?: string;
}

export interface SshExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

export interface SshInitResult {
  ok: boolean;
  latencyMs: number;
  osSummary: string;
  cpuCores?: number;
  memoryLimitGb?: number;
  memoryUsedGb?: number;
  diskLimitGb?: number;
  diskUsedGb?: number;
  message: string;
}

const MAX_OUTPUT = 256 * 1024;

function writeTempAskpassHelper(password: string): string {
  const isWin = process.platform === "win32";
  const filename = `qj-askpass-${randomBytes(8).toString("hex")}${isWin ? ".cmd" : ".sh"}`;
  const filePath = join(tmpdir(), filename);
  if (isWin) {
    // Escape cmd special characters minimally for plain echo inside ASKPASS
    const safe = password.replace(/[&|<>^()%!]/g, (ch) => `^${ch}`);
    writeFileSync(filePath, `@echo off\r\necho ${safe}\r\n`, "utf8");
  } else {
    writeFileSync(filePath, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(password)}\n`, { encoding: "utf8", mode: 0o700 });
  }
  return filePath;
}

export class SshRemoteRuntime {
  async exec(
    remote: SshEndpointConfig,
    command: string,
    options: { cwd?: string; password?: string; timeoutMs?: number } = {},
  ): Promise<SshExecResult> {
    const host = remote.host.trim();
    const user = remote.username.trim() || "ubuntu";
    const port = Math.max(1, remote.port || 22);
    if (host === "") {
      return { stdout: "", stderr: "请先配置远端虚拟服务器主机地址", exitCode: 1, durationMs: 0 };
    }

    const args: string[] = [
      "-p",
      String(port),
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=8",
      "-o",
      "ServerAliveInterval=15",
    ];

    let askpassPath: string | undefined;
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (remote.authMethod === "password" && options.password) {
      askpassPath = writeTempAskpassHelper(options.password);
      env.SSH_ASKPASS = askpassPath;
      env.SSH_ASKPASS_REQUIRE = "force";
      env.DISPLAY = "qianji:0";
      args.push("-o", "PubkeyAuthentication=no", "-o", "NumberOfPasswordPrompts=1");
    } else {
      args.push("-o", "BatchMode=yes");
      if (remote.privateKeyPath && remote.privateKeyPath.trim() !== "") {
        args.push("-i", remote.privateKeyPath.trim());
      }
    }

    const b64 = Buffer.from(command, "utf8").toString("base64");
    const targetDir = options.cwd ?? `${remote.workDir.trim() || "~/.qianji-vm"}/workspace`;
    const remoteScript = [
      `mkdir -p ${targetDir} 2>/dev/null || true`,
      `cd ${targetDir} 2>/dev/null || true`,
      `tmpf="/tmp/.qj_ssh_$$.sh"`,
      `printf '%s' '${b64}' | base64 -d > "$tmpf"`,
      `SHELL_BIN="/bin/sh"; [ -x /bin/bash ] && SHELL_BIN="/bin/bash"`,
      `"$SHELL_BIN" "$tmpf"; rc=$?; rm -f "$tmpf"; exit $rc`,
    ].join("; ");

    args.push(`${user}@${host}`, remoteScript);

    const started = Date.now();
    const timeoutMs = options.timeoutMs ?? 45_000;
    try {
      return await new Promise<SshExecResult>((resolve) => {
        const child = spawn("ssh", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill();
          resolve({ stdout, stderr: `${stderr}\nSSH timed out (${timeoutMs}ms)`.trim(), exitCode: null, durationMs: Date.now() - started });
        }, timeoutMs);

        child.stdout.on("data", (chunk: Buffer) => {
          if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          if (stderr.length < MAX_OUTPUT) stderr += chunk.toString("utf8");
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ stdout, stderr, exitCode: code, durationMs: Date.now() - started });
        });
        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ stdout, stderr: err.message, exitCode: null, durationMs: Date.now() - started });
        });
      });
    } finally {
      if (askpassPath !== undefined) {
        try {
          rmSync(askpassPath, { force: true });
        } catch {
          // Ignore transient lock
        }
      }
    }
  }

  async testConnection(
    remote: SshEndpointConfig,
    password?: string,
  ): Promise<{ ok: boolean; latencyMs: number; osSummary?: string; message: string }> {
    const res = await this.exec(remote, "uname -srm", { cwd: "~", password, timeoutMs: 12_000 });
    if (res.exitCode !== 0) {
      return {
        ok: false,
        latencyMs: res.durationMs,
        message: `SSH 认证或连接失败：${res.stderr.trim() || "请检查主机地址、端口或密钥/密码配置"}`,
      };
    }
    const osSummary = res.stdout.trim() || "Linux";
    return {
      ok: true,
      latencyMs: Math.max(1, res.durationMs),
      osSummary,
      message: `远端 SSH 连接正常（${osSummary} · ${res.durationMs}ms）`,
    };
  }

  async initEnvironment(
    remote: SshEndpointConfig,
    soulContent: string,
    memoryContent: string,
    password?: string,
  ): Promise<SshInitResult> {
    const baseDir = remote.workDir.trim() || "~/.qianji-vm";
    const soulB64 = Buffer.from(soulContent, "utf8").toString("base64");
    const memB64 = Buffer.from(memoryContent, "utf8").toString("base64");
    const script = [
      `mkdir -p ${baseDir}/workspace ${baseDir}/system`,
      `printf '%s' '${soulB64}' | base64 -d > ${baseDir}/system/SOUL.md`,
      `printf '%s' '${memB64}' | base64 -d > ${baseDir}/system/MEMORY.md`,
      `echo "OS=$(uname -srm)"`,
      `echo "CPU=$(nproc 2>/dev/null || echo 2)"`,
      `free -b 2>/dev/null | awk '/Mem:/ {printf "MEM=%s,%s\\n", $2, $3}' || true`,
      `df -B1 ${baseDir} 2>/dev/null | awk 'NR==2 {printf "DISK=%s,%s\\n", $2, $3}' || true`,
    ].join("\n");

    const res = await this.exec(remote, script, { cwd: "~", password, timeoutMs: 25_000 });
    if (res.exitCode !== 0) {
      return {
        ok: false,
        latencyMs: res.durationMs,
        osSummary: "",
        message: `远端环境初始化失败：${res.stderr.trim() || res.stdout.trim()}`,
      };
    }

    const lines = res.stdout.split(/\r?\n/);
    const get = (prefix: string) => lines.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim() ?? "";
    const osSummary = get("OS=") || "Linux";
    const cpuCores = Number.parseInt(get("CPU="), 10) || undefined;
    const [memTotal, memUsed] = get("MEM=").split(",").map(Number);
    const [diskTotal, diskUsed] = get("DISK=").split(",").map(Number);
    const toGb = (bytes: number | undefined) =>
      bytes && Number.isFinite(bytes) && bytes > 0 ? Number((bytes / 1024 ** 3).toFixed(2)) : undefined;

    return {
      ok: true,
      latencyMs: Math.max(1, res.durationMs),
      osSummary,
      cpuCores,
      memoryLimitGb: toGb(memTotal),
      memoryUsedGb: toGb(memUsed),
      diskLimitGb: toGb(diskTotal),
      diskUsedGb: toGb(diskUsed),
      message: `远端虚拟服务器环境已初始化（${osSummary} · ${res.durationMs}ms），SOUL.md 与记忆已同步`,
    };
  }
}
