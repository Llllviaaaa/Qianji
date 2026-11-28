/**
 * Subprocess, mount-namespace script builder, and Windows-to-WSL path utilities
 * for `WslContainerRuntime`.
 */
import { spawn } from "node:child_process";
import { basename } from "node:path";

const MAX_EXEC_OUTPUT = 256 * 1024;

export interface WslExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

export function winPathToWslMount(rawPath: string): string {
  const normalized = rawPath.trim().replace(/\\/g, "/");
  const m = /^([a-zA-Z]):\/(.*)$/.exec(normalized);
  if (m && m[1] !== undefined) {
    return `/mnt/${m[1].toLowerCase()}/${m[2] ?? ""}`.replace(/\/+$/, "") || `/mnt/${m[1].toLowerCase()}`;
  }
  return normalized;
}

export function sharedFolderSlug(folderPath: string, index: number): string {
  const rawBase = basename(folderPath.replace(/[\\/]+$/, "")) || "folder";
  const safe = rawBase.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${index + 1}-${safe}`;
}

export function stripWslStderrNoise(raw: string): string {
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !/^wsl:\s/i.test(line.trim()))
    .join("\n");
}

export function runWslSubprocess(
  command: string,
  args: readonly string[],
  options: { timeoutMs?: number; stdin?: string } = {},
): Promise<WslExecResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 60_000;
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, WSL_UTF8: "1" },
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); } catch { /* Ignore */ }
      try { child.kill(); } catch { /* Ignore */ }
      if (process.platform === "win32" && child.pid !== undefined) {
        try {
          spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true, stdio: "ignore" }).unref();
        } catch {
          // Ignore best-effort tree termination.
        }
      }
      resolve({
        stdout,
        stderr: `${stderr}\nProcess timed out after ${timeoutMs}ms`.trim(),
        exitCode: null,
        durationMs: Date.now() - started,
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_EXEC_OUTPUT) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_EXEC_OUTPUT) stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, durationMs: Date.now() - started });
    });
    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: err.message, exitCode: null, durationMs: Date.now() - started });
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin, "utf8");
    }
    child.stdin.end();
  });
}

export function buildMountedExecScript(options: {
  guestCwd: string;
  workspaceMount: string;
  sharedMounts: ReadonlyArray<{ slug: string; sourceMount: string; readOnly: boolean }>;
  cpuCores: number;
  memoryLimitGb: number;
  b64Command: string;
}): string {
  const cpuQuotaUs = Math.max(1, options.cpuCores) * 100_000;
  const memMaxBytes = Math.max(1, options.memoryLimitGb) * 1024 * 1024 * 1024;
  const mountLines = options.sharedMounts
    .map((m) => {
      const target = `/shared/${m.slug}`;
      const base = `mkdir -p ${JSON.stringify(target)} && mount --bind ${JSON.stringify(m.sourceMount)} ${JSON.stringify(target)}`;
      return m.readOnly ? `${base} && mount -o remount,bind,ro ${JSON.stringify(target)}` : base;
    })
    .join("; ");

  return [
    `if [ ! -f /sys/fs/cgroup/cgroup.controllers ] && [ ! -d /sys/fs/cgroup/memory ]; then`,
    `  mkdir -p /sys/fs/cgroup 2>/dev/null || true`,
    `  mount -t cgroup2 none /sys/fs/cgroup 2>/dev/null || true`,
    `fi`,
    `if [ -f /sys/fs/cgroup/cgroup.controllers ]; then`,
    `  mkdir -p /sys/fs/cgroup/init.scope /sys/fs/cgroup/qianji-bot 2>/dev/null || true`,
    `  for p in $(cat /sys/fs/cgroup/cgroup.procs 2>/dev/null); do printf '%s\\n' "$p" > /sys/fs/cgroup/init.scope/cgroup.procs 2>/dev/null || true; done`,
    `  printf '+cpu +memory +pids\\n' > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || printf '+memory +pids\\n' > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true`,
    `  printf '%s %s\\n' '${cpuQuotaUs}' '100000' > /sys/fs/cgroup/qianji-bot/cpu.max 2>/dev/null || true`,
    `  printf '%s\\n' '${memMaxBytes}' > /sys/fs/cgroup/qianji-bot/memory.max 2>/dev/null || true`,
    `  printf '512\\n' > /sys/fs/cgroup/qianji-bot/pids.max 2>/dev/null || true`,
    `  printf '%s\\n' "$$" > /sys/fs/cgroup/qianji-bot/cgroup.procs 2>/dev/null || true`,
    `elif [ -d /sys/fs/cgroup/memory ]; then`,
    `  mkdir -p /sys/fs/cgroup/memory/qianji-bot /sys/fs/cgroup/cpu/qianji-bot /sys/fs/cgroup/pids/qianji-bot 2>/dev/null || true`,
    `  printf '%s\\n' '${memMaxBytes}' > /sys/fs/cgroup/memory/qianji-bot/memory.limit_in_bytes 2>/dev/null || true`,
    `  printf '100000\\n' > /sys/fs/cgroup/cpu/qianji-bot/cpu.cfs_period_us 2>/dev/null || true`,
    `  printf '%s\\n' '${cpuQuotaUs}' > /sys/fs/cgroup/cpu/qianji-bot/cpu.cfs_quota_us 2>/dev/null || true`,
    `  printf '512\\n' > /sys/fs/cgroup/pids/qianji-bot/pids.max 2>/dev/null || true`,
    `  printf '%s\\n' "$$" > /sys/fs/cgroup/memory/qianji-bot/cgroup.procs 2>/dev/null || true`,
    `  printf '%s\\n' "$$" > /sys/fs/cgroup/cpu/qianji-bot/cgroup.procs 2>/dev/null || true`,
    `  printf '%s\\n' "$$" > /sys/fs/cgroup/pids/qianji-bot/cgroup.procs 2>/dev/null || true`,
    `fi`,
    `mount --make-rprivate / 2>/dev/null || true`,
    `mkdir -p /workspace /shared`,
    `mount --bind ${JSON.stringify(options.workspaceMount)} /workspace`,
    `chown 1000:1000 /workspace 2>/dev/null || true`,
    mountLines,
    `for d in /mnt/[a-z]; do [ -d "$d" ] && umount -l "$d" 2>/dev/null || true; done`,
    `script_file="/tmp/.qj_cmd_$$.sh"`,
    `printf '%s' '${options.b64Command}' | base64 -d > "$script_file"`,
    `chmod 700 "$script_file" && chown 1000:1000 "$script_file" 2>/dev/null || true`,
    `cd ${JSON.stringify(options.guestCwd)} 2>/dev/null || cd /workspace`,
    `SHELL_BIN="/bin/sh"; [ -x /bin/bash ] && SHELL_BIN="/bin/bash"`,
    `if command -v su-exec >/dev/null 2>&1; then`,
    `  HOME=/home/bot USER=bot PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" su-exec 1000:1000 "$SHELL_BIN" "$script_file" </dev/null; rc=$?`,
    `else`,
    `  su -s "$SHELL_BIN" bot -c "HOME=/home/bot PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin $SHELL_BIN '$script_file'" </dev/null; rc=$?`,
    `fi`,
    `rm -f "$script_file"`,
    `exit $rc`,
  ]
    .filter(Boolean)
    .join("\n");
}
