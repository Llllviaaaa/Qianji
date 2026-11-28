/**
 * Persistent Stateful PTY Session Manager (`packages/host/src/bot/computer/pty-manager.ts`).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { posix, resolve } from "node:path";
import type {
  BotComputerEngineId,
  BotComputerEventNotification,
  BotComputerPtySessionInfo,
  BotRemoteComputerNode,
  BotSharedFolderRule,
} from "@qianji/protocol";
import type { WslContainerRuntime } from "../wsl-runtime.ts";
import type { RemoteNodesEngine } from "./remote-nodes-engine.ts";
import { computeFencedRoots, resolveFencedPath } from "./sentinel-fence.ts";

const MAX_OUTPUT_TAIL = 16_384;
const DONE_MARKER_RE = /\r?\n?__QJ_DONE_([0-9a-f]{8})__:([^\r\n]*)\r?\n?/g;

interface SubprocessPtyEntry {
  kind: "subprocess";
  sessionId: string;
  engine: BotComputerEngineId;
  shellKind: "sh" | "powershell";
  child: ChildProcessWithoutNullStreams;
  cwd: string;
  alive: boolean;
  outputTail: string;
  updatedAt: number;
  cols: number;
  rows: number;
  exitCode: number | null;
  carry: string;
  waiters: Map<string, () => void>;
}

interface RemoteSshPtyEntry {
  kind: "remote-ssh";
  sessionId: string;
  engine: BotComputerEngineId;
  cwd: string;
  envVars: Map<string, string>;
  alive: boolean;
  outputTail: string;
  updatedAt: number;
  cols: number;
  rows: number;
  exitCode: number | null;
}

type PtyEntry = SubprocessPtyEntry | RemoteSshPtyEntry;

function appendTail(prev: string, chunk: string): string {
  const combined = prev + chunk;
  return combined.length > MAX_OUTPUT_TAIL ? combined.slice(combined.length - MAX_OUTPUT_TAIL) : combined;
}

function toInfo(entry: PtyEntry): BotComputerPtySessionInfo {
  return {
    sessionId: entry.sessionId, engine: entry.engine, cwd: entry.cwd, alive: entry.alive,
    outputTail: entry.outputTail, updatedAt: entry.updatedAt, cols: entry.cols, rows: entry.rows, exitCode: entry.exitCode,
  };
}

function psQuote(val: string): string {
  return `'${val.replace(/'/g, "''")}'`;
}

export class PtySessionManager {
  private readonly sessions = new Map<string, PtyEntry>();
  private readonly engineActiveId = new Map<BotComputerEngineId, string>();

  constructor(
    private readonly deps: {
      getBotWorkspaceDir: () => string;
      getSharedFolders: () => readonly BotSharedFolderRule[];
      wsl: WslContainerRuntime;
      remoteEngine: RemoteNodesEngine;
      resolveRemoteNode: (engine: BotComputerEngineId) => BotRemoteComputerNode | undefined;
      emitEvent: (ev: BotComputerEventNotification) => void;
    },
  ) {}

  getActiveInfo(engine: BotComputerEngineId): BotComputerPtySessionInfo | undefined {
    const id = this.engineActiveId.get(engine);
    const entry = id ? this.sessions.get(id) : undefined;
    return entry ? toInfo(entry) : undefined;
  }

  private resolveEntry(sessionId?: string, engine?: BotComputerEngineId): PtyEntry | undefined {
    if (sessionId) {
      const exact = this.sessions.get(sessionId);
      if (exact) return exact;
    }
    const id = engine ? this.engineActiveId.get(engine) : undefined;
    return id ? this.sessions.get(id) : undefined;
  }

  async open(params: { engine: BotComputerEngineId; cwd?: string; cols?: number; rows?: number }): Promise<BotComputerPtySessionInfo> {
    const { engine, cols = 100, rows = 30 } = params;
    const existing = this.resolveEntry(undefined, engine);
    if (existing && existing.alive && !params.cwd) {
      existing.cols = cols;
      existing.rows = rows;
      return toInfo(existing);
    }
    if (existing && existing.alive) this.close({ sessionId: existing.sessionId });

    const sessionId = `pty-${engine}-${randomUUID().slice(0, 8)}`;
    if (engine === "remote-vm" || engine === "remote-pc") {
      const node = this.deps.resolveRemoteNode(engine);
      const baseCwd = params.cwd?.trim() || `${node?.workDir?.trim() || "~/.qianji-vm"}/workspace`;
      const entry: RemoteSshPtyEntry = {
        kind: "remote-ssh", sessionId, engine, cwd: baseCwd, envVars: new Map(),
        alive: true, outputTail: "", updatedAt: Date.now(), cols, rows, exitCode: null,
      };
      this.sessions.set(sessionId, entry);
      this.engineActiveId.set(engine, sessionId);
      return toInfo(entry);
    }

    const wsDir = resolve(this.deps.getBotWorkspaceDir());
    mkdirSync(wsDir, { recursive: true });
    const fencedTarget = resolveFencedPath(params.cwd, wsDir, this.deps.getSharedFolders());
    mkdirSync(fencedTarget.hostPath, { recursive: true });

    let child: ChildProcessWithoutNullStreams;
    let shellKind: "sh" | "powershell";
    let initialDisplayCwd = fencedTarget.hostPath;
    const wslRunning = engine === "local-linux" && this.deps.wsl.isSupported() && (await this.deps.wsl.inspect()).engineState === "running";

    if (wslRunning) {
      shellKind = "sh";
      initialDisplayCwd = fencedTarget.virtualPath;
      child = spawn("wsl.exe", ["-d", this.deps.wsl.distroName, "--cd", "/workspace", "-u", "bot", "--", "/bin/sh"], {
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, WSL_UTF8: "1" },
      });
    } else if (process.platform === "win32") {
      shellKind = "powershell";
      child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NoExit", "-Command", "-"], {
        cwd: fencedTarget.hostPath, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      shellKind = "sh";
      child = spawn("/bin/sh", [], { cwd: fencedTarget.hostPath, stdio: ["pipe", "pipe", "pipe"] });
    }

    const entry: SubprocessPtyEntry = {
      kind: "subprocess", sessionId, engine, shellKind, child, cwd: initialDisplayCwd,
      alive: true, outputTail: "", updatedAt: Date.now(), cols, rows, exitCode: null, carry: "", waiters: new Map(),
    };

    const handleChunk = (raw: string) => {
      const combined = entry.carry + raw;
      entry.carry = "";
      let cleaned = combined.replace(DONE_MARKER_RE, (_m, tok: string, nextCwd: string) => {
        if (nextCwd.trim() !== "") entry.cwd = nextCwd.trim();
        const doneFn = entry.waiters.get(tok);
        if (doneFn) { entry.waiters.delete(tok); doneFn(); }
        return "";
      });
      const partialIdx = cleaned.indexOf("__QJ_DONE_");
      if (partialIdx >= 0) {
        entry.carry = cleaned.slice(partialIdx);
        cleaned = cleaned.slice(0, partialIdx);
      }
      if (cleaned !== "") {
        entry.outputTail = appendTail(entry.outputTail, cleaned);
        entry.updatedAt = Date.now();
        this.deps.emitEvent({ kind: "pty", sessionId: entry.sessionId, engine: entry.engine, chunk: cleaned, alive: entry.alive, updatedAt: entry.updatedAt });
      }
    };

    child.stdout.on("data", (buf: Buffer) => handleChunk(buf.toString("utf8")));
    child.stderr.on("data", (buf: Buffer) => handleChunk(buf.toString("utf8")));
    child.on("close", (code) => {
      entry.alive = false;
      entry.exitCode = code;
      entry.updatedAt = Date.now();
      for (const fn of entry.waiters.values()) fn();
      entry.waiters.clear();
      this.deps.emitEvent({ kind: "pty", sessionId: entry.sessionId, engine: entry.engine, chunk: "", alive: false, updatedAt: entry.updatedAt });
    });
    child.on("error", () => {
      entry.alive = false;
      for (const fn of entry.waiters.values()) fn();
      entry.waiters.clear();
    });

    if (shellKind === "powershell") {
      const initScript = [
        "[Console]::InputEncoding = [System.Text.Encoding]::UTF8",
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
        "$OutputEncoding = [System.Text.Encoding]::UTF8",
        "function prompt { '' }",
        "function export { param([string]$kv) if ($kv -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { $k = $Matches[1]; $v = $Matches[2].Trim('\"', \"'\"); Set-Item -Path \"Env:$k\" -Value $v; Set-Variable -Name $k -Value $v -Scope Global } }",
      ].join("; ");
      child.stdin.write(`${initScript}\n`, "utf8");
    }

    this.sessions.set(sessionId, entry);
    this.engineActiveId.set(engine, sessionId);
    return toInfo(entry);
  }

  async write(params: { sessionId?: string; engine: BotComputerEngineId; data: string }): Promise<BotComputerPtySessionInfo> {
    let entry = this.resolveEntry(params.sessionId, params.engine);
    if (!entry || !entry.alive) {
      await this.open({ engine: params.engine });
      entry = this.resolveEntry(undefined, params.engine);
    }
    if (!entry) throw new Error(`Unable to initialize PTY session for engine ${params.engine}`);
    if (entry.kind === "remote-ssh") return this.writeRemote(entry, params.data);

    if (params.data === "\x03" || params.data === "\x04") {
      entry.child.stdin.write(params.data, "utf8");
      entry.updatedAt = Date.now();
      return toInfo(entry);
    }

    const cmdLine = params.data.replace(/\r?\n$/, "");
    const tok = randomBytes(4).toString("hex");
    const donePromise = new Promise<void>((resolveDone) => {
      const timer = setTimeout(() => { entry.waiters.delete(tok); resolveDone(); }, 2_500);
      entry.waiters.set(tok, () => { clearTimeout(timer); resolveDone(); });
    });

    if (entry.shellKind === "powershell") {
      const wsDir = resolve(this.deps.getBotWorkspaceDir());
      const roots = computeFencedRoots(wsDir, this.deps.getSharedFolders());
      const fenceSnippet = entry.engine === "local-win-pip"
        ? `$__roots = @(${roots.map((r) => psQuote(r.toLowerCase())).join(", ")}); $__cur = (Get-Location).ProviderPath; $__ok = $false; foreach ($__r in $__roots) { if ($__cur.ToLowerInvariant().StartsWith($__r)) { $__ok = $true; break } }; if (-not $__ok) { Set-Location -LiteralPath ${psQuote(wsDir)}; Write-Output '[Sentinel Fence] Directory outside fenced roots refused.' }; `
        : "";
      entry.child.stdin.write(`${cmdLine}\n${fenceSnippet}Write-Output "__QJ_DONE_${tok}__:$((Get-Location).ProviderPath)"\n`, "utf8");
    } else {
      entry.child.stdin.write(`${cmdLine}\nprintf '\\n__QJ_DONE_${tok}__:%s\\n' "$(pwd)"\n`, "utf8");
    }

    await donePromise;
    entry.updatedAt = Date.now();
    return toInfo(entry);
  }

  private async writeRemote(entry: RemoteSshPtyEntry, rawData: string): Promise<BotComputerPtySessionInfo> {
    const cmd = rawData.replace(/\r?\n$/, "").trim();
    const node = this.deps.resolveRemoteNode(entry.engine);
    if (!node || node.host.trim() === "") {
      const errChunk = `[Remote PTY] 请先配置并连接 ${entry.engine === "remote-pc" ? "远程个人电脑" : "远程 Linux 虚拟机"} 节点。\n`;
      entry.outputTail = appendTail(entry.outputTail, errChunk);
      entry.updatedAt = Date.now();
      this.deps.emitEvent({ kind: "pty", sessionId: entry.sessionId, engine: entry.engine, chunk: errChunk, alive: true, updatedAt: entry.updatedAt });
      return toInfo(entry);
    }

    for (const seg of cmd.split(/[;&]/)) {
      const m = /^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(seg.trim());
      if (m && m[1] !== undefined && m[2] !== undefined) entry.envVars.set(m[1], m[2].trim().replace(/^['"]|['"]$/g, ""));
    }
    const envExports = [...entry.envVars.entries()].map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join("; ");
    const envFile = `/tmp/.qj_pty_${entry.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.env`;
    const wrapped = [
      `[ -f ${envFile} ] && . ${envFile} 2>/dev/null || true`, envExports,
      `mkdir -p ${entry.cwd} 2>/dev/null || true`, `cd ${entry.cwd} 2>/dev/null || true`, cmd,
      `__rc=$?`, `export -p > ${envFile} 2>/dev/null || true`, `printf '\\n__QJ_REMOTE_PWD__:%s\\n' "$(pwd)"`, `exit $__rc`,
    ].filter(Boolean).join("\n");

    const res = await this.deps.remoteEngine.execOnNode(node, wrapped, entry.cwd, 30_000);
    let out = [res.stdout, res.stderr].filter(Boolean).join("");
    out = out.replace(/\r?\n?__QJ_REMOTE_PWD__:([^\r\n]*)\r?\n?/g, (_m, nextPwd: string) => {
      if (nextPwd.trim() !== "") entry.cwd = nextPwd.trim();
      return "\n";
    });
    const cdOnly = /^\s*cd\s+([^\s;&|]+)\s*$/.exec(cmd);
    if (cdOnly && cdOnly[1] && res.exitCode === 0 && !res.stdout.includes("__QJ_REMOTE_PWD__:")) {
      entry.cwd = cdOnly[1].startsWith("/") || cdOnly[1].startsWith("~") ? cdOnly[1] : posix.normalize(posix.join(entry.cwd, cdOnly[1]));
    }
    const chunk = out.endsWith("\n") || out === "" ? out : `${out}\n`;
    if (chunk !== "") entry.outputTail = appendTail(entry.outputTail, chunk);
    entry.updatedAt = Date.now();
    this.deps.emitEvent({ kind: "pty", sessionId: entry.sessionId, engine: entry.engine, chunk, alive: entry.alive, updatedAt: entry.updatedAt });
    return toInfo(entry);
  }

  resize(params: { sessionId?: string; engine?: BotComputerEngineId; cols: number; rows: number }): void {
    const entry = this.resolveEntry(params.sessionId, params.engine);
    if (!entry) return;
    entry.cols = Math.max(20, Math.round(params.cols));
    entry.rows = Math.max(5, Math.round(params.rows));
    entry.updatedAt = Date.now();
  }

  close(params: { sessionId?: string; engine?: BotComputerEngineId }): void {
    const entry = this.resolveEntry(params.sessionId, params.engine);
    if (!entry) return;
    entry.alive = false;
    entry.updatedAt = Date.now();
    if (entry.kind === "subprocess") {
      try { entry.child.kill(); } catch { /* Ignore */ }
      for (const fn of entry.waiters.values()) fn();
      entry.waiters.clear();
    }
    this.sessions.delete(entry.sessionId);
    if (this.engineActiveId.get(entry.engine) === entry.sessionId) this.engineActiveId.delete(entry.engine);
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close({ sessionId: id });
  }
}
