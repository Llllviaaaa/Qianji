/**
 * The shell tool: run a command in the session's cwd. Output is stdout and
 * stderr interleaved, keeping the tail.
 *
 * - `bash`: /bin/bash elsewhere; on Windows Git Bash (never WSL's
 *   System32\bash.exe).
 * - `powershell`: on Windows without Git Bash, the tool is registered under
 *   this name instead, running PowerShell 7 when installed or Windows
 *   PowerShell 5.1, which ships with Windows (ADR 0021).
 *
 * `Config.shell` overrides the choice; a PowerShell executable there selects
 * the `powershell` tool.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath, win32 } from "node:path";
import { Service, type Context } from "@deepseek-ai/cordis";
import "@qianji/agent";
import { ErrorCode, type SandboxConfigKind, type SandboxGenerateConfigResult } from "@qianji/protocol";
import { RpcError } from "@qianji/rpc";
import "@qianji/session";
import { textOutput, type ToolDefinition } from "@qianji/tools";
import { BackgroundProcessManager, bgProcessTool, bindAsyncJobObjectDisposer } from "./background.ts";
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_BUFFER_BYTES,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_LINES,
  POST_EXIT_PIPE_DRAIN_MS,
  POST_KILL_GRACE_MS,
  killTree,
  tail,
} from "./proc.ts";
import {
  attachWindowsJobObject,
  buildSandboxedEnv,
  generateDevContainerConfig,
  generateWindowsSandboxConfig,
  inspectSelfKillCommand,
} from "./sandbox.ts";
import { createProgressReporter, spillTruncatedOutput } from "./spill.ts";
import { isReadOnlyShellCommand } from "./readonly-shell.ts";

export {
  BackgroundProcessManager,
  bgProcessTool,
  bindAsyncJobObjectDisposer,
  type AsyncJobObjectBinding,
  type BgProcessArgs,
  type BgProcessSnapshot,
  type BgStartOptions,
  type BgWaitResult,
} from "./background.ts";
export * from "./sandbox.ts";
export * from "./spill.ts";
export { isReadOnlyShellCommand } from "./readonly-shell.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    bashSandbox?: BashSandbox;
  }
}

export class BashSandbox extends Service {
  readonly enabled: boolean;

  constructor(ctx: Context, config: { enabled?: boolean } = {}) {
    super(ctx, "bashSandbox");
    this.enabled = config.enabled !== false;
  }
}

export const name = "qianji-tool-bash";
export const inject = ["tools"];

export interface Config {
  /** Shell executable: one taking `-c <command>`, or `pwsh.exe` / `powershell.exe`. */
  shell?: string;
  /** Upper bound for the `timeout` argument, in seconds. */
  maxTimeoutSeconds?: number;
  /** Force lightweight sandbox containment on every bash invocation. */
  sandbox?: boolean;
  /** Directory where full truncated foreground outputs are saved. */
  spillDir?: string;
}

function gitBashCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  const where = spawnSync("where", ["git"], { encoding: "utf8", windowsHide: true });
  for (const git of where.status === 0 ? where.stdout.split(/\r?\n/).filter(Boolean) : []) {
    // <Git>\cmd\git.exe or <Git>\bin\git.exe → <Git>\bin\bash.exe
    candidates.push(join(dirname(dirname(git)), "bin", "bash.exe"));
  }
  for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs")]) {
    if (root) candidates.push(join(root, "Git", "bin", "bash.exe"));
  }
  return candidates;
}

/** The shell to run commands with, or undefined when none is found. */
export function findShell(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (platform === "win32") return gitBashCandidates(env).find((candidate) => existsSync(candidate));
  return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

export type ShellKind = "bash" | "powershell";

export function isPowerShell(shell: string): boolean {
  return /^(?:pwsh|powershell)(?:\.exe)?$/.test(win32.basename(shell).toLowerCase());
}

/** PowerShell 7 when installed, else Windows PowerShell 5.1; undefined when neither exists. */
export function findPowerShell(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? "";
  for (const dir of pathValue.split(";").filter(Boolean)) {
    const candidate = win32.join(dir, "pwsh.exe");
    if (exists(candidate)) return candidate;
  }
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES;
  if (programFiles) {
    const pwsh = win32.join(programFiles, "PowerShell", "7", "pwsh.exe");
    if (exists(pwsh)) return pwsh;
  }
  const legacy = win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return exists(legacy) ? legacy : undefined;
}

/**
 * Which shell tool to register: `Config.shell` when set; otherwise bash, except
 * on Windows without Git Bash, where PowerShell takes its place.
 */
export function chooseShell(
  config: Config = {},
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  find: { bash?: typeof findShell; powershell?: typeof findPowerShell } = {},
): { kind: ShellKind; path?: string } {
  if (config.shell !== undefined) return { kind: isPowerShell(config.shell) ? "powershell" : "bash", path: config.shell };
  const bash = (find.bash ?? findShell)(platform, env);
  if (bash !== undefined || platform !== "win32") return bash === undefined ? { kind: "bash" } : { kind: "bash", path: bash };
  const powershell = (find.powershell ?? findPowerShell)(env);
  return powershell === undefined ? { kind: "bash" } : { kind: "powershell", path: powershell };
}

/** Make PowerShell write UTF-8, so the output decodes the same on every code page. */
const POWERSHELL_UTF8 = "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}\n";
/**
 * Windows PowerShell 5.1 turns a native command's redirected stderr into error
 * records and sets `$?` to false, so `git push 2>&1` looks failed although git
 * exited 0 (PowerShell 7 does not). Exit 0 when the last error is only such a
 * record and the native command succeeded; otherwise the usual -Command rule.
 * The lone `;` keeps an unfinished last statement (`Get-ChildItem |`) a parse
 * error rather than running into this suffix. The idea follows Pi's PowerShell tool.
 */
const POWERSHELL_5_EXIT = "\n;\nif ($?) { exit 0 }\nif ($LASTEXITCODE -eq 0 -and \"$($Error[0].FullyQualifiedErrorId)\".StartsWith('NativeCommandError')) { exit 0 }\nexit 1";

/**
 * The argv after the executable. PowerShell gets the command as
 * `-EncodedCommand` (UTF-16LE in base64), which no quoting can break.
 */
export function shellArgs(shell: string, command: string): string[] {
  if (!isPowerShell(shell)) return ["-c", command];
  const legacy = win32.basename(shell).toLowerCase().startsWith("powershell");
  // A trailing backtick would continue the command's last line into the suffix.
  const suffix = legacy && !command.trimEnd().endsWith("`") ? POWERSHELL_5_EXIT : "";
  const script = `${POWERSHELL_UTF8}${command}${suffix}`;
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

export interface RunResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}

export interface RunCommandOptions {
  sandbox?: boolean;
  env?: NodeJS.ProcessEnv;
  onProgress?: (text: string) => void;
}

export function runCommand(
  shell: string,
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  options: RunCommandOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const baseEnv = options.env ?? process.env;
    const childEnv = options.sandbox === true ? buildSandboxedEnv(baseEnv, cwd) : baseEnv;
    const child = spawn(shell, shellArgs(shell, command), {
      cwd,
      env: childEnv,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let stopped = false;
    let recordedExitCode: number | null = null;
    let exitDrainTimer: ReturnType<typeof setTimeout> | undefined;
    let killGraceTimer: ReturnType<typeof setTimeout> | undefined;

    const childPid = child.pid;
    const jobBinding = options.sandbox === true && childPid !== undefined
      ? bindAsyncJobObjectDisposer(attachWindowsJobObject(childPid), {
          isDisposed: () => settled || stopped,
          isStopped: () => stopped,
          onStoppedResolve: () => killTree(childPid),
        })
      : undefined;
    const disposeJob = () => {
      jobBinding?.dispose({ stopped });
    };

    const reporter = createProgressReporter(options.onProgress);
    const chunks: Buffer[] = [];
    let buffered = 0;
    const collect = (chunk: Buffer) => {
      chunks.push(chunk);
      buffered += chunk.length;
      while (buffered > MAX_BUFFER_BYTES && chunks.length > 1) {
        const dropped = chunks.shift();
        if (dropped !== undefined) buffered -= dropped.length;
      }
      reporter.push(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const cleanup = () => {
      clearTimeout(timer);
      if (exitDrainTimer !== undefined) clearTimeout(exitDrainTimer);
      if (killGraceTimer !== undefined) clearTimeout(killGraceTimer);
      signal.removeEventListener("abort", onAbort);
      reporter.dispose();
      disposeJob();
    };

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      reporter.flush();
      cleanup();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ output: Buffer.concat(chunks).toString("utf8"), exitCode, timedOut, aborted });
    };

    const stop = () => {
      stopped = true;
      disposeJob();
      if (child.pid !== undefined) killTree(child.pid);
      child.stdout.destroy();
      child.stderr.destroy();
      if (killGraceTimer === undefined) {
        killGraceTimer = setTimeout(() => finish(recordedExitCode), POST_KILL_GRACE_MS);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("exit", (exitCode) => {
      recordedExitCode = exitCode;
      if (settled || exitDrainTimer !== undefined) return;
      // Background grandchildren (`Start-Process`, `node app.js &`) can inherit
      // stdout/stderr handles and prevent `"close"` from firing after the shell exits.
      exitDrainTimer = setTimeout(() => finish(recordedExitCode), POST_EXIT_PIPE_DRAIN_MS);
    });
    child.once("close", (exitCode) => {
      finish(exitCode ?? recordedExitCode);
    });
  });
}

function powershellLabel(shell: string | undefined): string {
  if (shell === undefined) return "PowerShell";
  return win32.basename(shell).toLowerCase().startsWith("pwsh") ? "PowerShell 7" : "Windows PowerShell 5.1";
}

export type ShellToolArgs = {
  command: string;
  timeout?: number;
  background?: boolean;
  waitMs?: number;
};

export interface ShellToolOptions {
  manager?: BackgroundProcessManager;
  ctx?: Context;
}

/** The shell tool for `kind`; `shellPath` is its executable when already known. */
export function shellTool(
  kind: ShellKind,
  config: Config = {},
  isSandboxed?: () => boolean,
  shellPath?: string,
  options?: ShellToolOptions,
): ToolDefinition<ShellToolArgs> {
  const maxTimeout = config.maxTimeoutSeconds ?? 600;
  let shell = shellPath ?? config.shell;
  let fallbackManager: BackgroundProcessManager | undefined;
  const limits = `the last ${MAX_OUTPUT_LINES} lines or ${MAX_OUTPUT_BYTES / 1024} KB`;
  const timing = `Times out after \`timeout\` seconds (default ${DEFAULT_TIMEOUT_SECONDS}, at most ${maxTimeout}). Use \`background: true\` for long-running servers/watchers, then manage them via \`bg_process\`.`;
  const description = kind === "bash"
    ? `Run a bash command in the working directory and return its combined stdout and stderr (${limits}). ${timing}`
    : `Run a PowerShell command in the working directory and return its combined output (${limits}). There is no bash on this machine: write ${powershellLabel(shell)} syntax (Get-ChildItem, Select-String, $env:NAME, ; between commands). ${timing}`;
  const protectedPids = new Set<number>(
    [process.pid, process.ppid].filter((pid): pid is number => Number.isInteger(pid) && pid > 1),
  );
  return {
    name: kind,
    // Bounded by its own `timeout` argument (ADR 0020).
    timeoutMs: 0,
    ...(kind === "bash"
      ? { isConcurrencySafe: ({ command, background }) => background !== true && typeof command === "string" && isReadOnlyShellCommand(command) }
      : {}),
    description,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line" },
        timeout: { type: "number", description: "Timeout in seconds (foreground mode)" },
        background: { type: "boolean", description: "Run detached in the background and manage via bg_process" },
        waitMs: { type: "number", description: "Initial ms to wait for startup output when background=true (100-30000, default 1500)" },
      },
      required: ["command"],
    },
    async execute({ command, timeout, background, waitMs }, env) {
      const selfKillReason = inspectSelfKillCommand(command, protectedPids);
      if (selfKillReason !== undefined) return textOutput(selfKillReason, true);
      shell ??= kind === "bash" ? findShell() : findPowerShell();
      if (shell === undefined) {
        return textOutput(kind === "bash" ? "No bash found. Install Git for Windows or set the bash tool's shell." : "No PowerShell found.", true);
      }
      const sandbox = config.sandbox === true || isSandboxed?.() === true;

      if (background === true) {
        const bgManager = options?.manager ?? (fallbackManager ??= new BackgroundProcessManager());
        const initialWaitMs = Math.min(Math.max(100, Math.floor(waitMs ?? 1_500)), 30_000);
        let started;
        try {
          started = bgManager.start({
            sessionId: env.sessionId,
            shellPath: shell,
            shellArgs: shellArgs(shell, command),
            command,
            cwd: env.cwd,
            sandbox,
          });
        } catch (error) {
          return textOutput(error instanceof Error ? error.message : String(error), true);
        }
        const settled = await bgManager.wait(env.sessionId, started.id, initialWaitMs, env.signal, { tailLines: 200 });
        if (env.signal.aborted) {
          await bgManager.stop(env.sessionId, started.id);
          return textOutput("[Aborted; background process was stopped.]", true);
        }
        options?.ctx?.get("tools")?.activate(env.sessionId, ["bg_process"]);
        const snap = settled?.snapshot ?? started;
        const pidPart = snap.pid === undefined ? "" : ` pid=${snap.pid}`;
        const exitPart = snap.status === "exited" ? ` exitCode=${snap.exitCode ?? snap.signal ?? "unknown"}` : "";
        const header = `[Background process ${snap.id}] status=${snap.status}${pidPart}${exitPart}`;
        const hint = snap.status === "running"
          ? "Use `bg_process` (`logs`, `wait`, `stop`, `list`) to inspect or stop this process."
          : "Process exited during initial wait window.";
        const preview = settled?.output ?? "";
        const body = [header, hint, preview === "" ? "(no output yet)" : preview].join("\n");
        return {
          content: [{ type: "text", text: body }],
          isError: snap.status === "exited" && snap.exitCode !== 0,
          details: { id: snap.id, pid: snap.pid, status: snap.status, exitCode: snap.exitCode },
        };
      }

      const seconds = Math.min(Math.max(1, timeout ?? DEFAULT_TIMEOUT_SECONDS), maxTimeout);
      const result = await runCommand(shell, command, env.cwd, seconds * 1000, env.signal, {
        sandbox,
        onProgress: env.onProgress,
      });
      const { text, truncated } = tail(result.output);
      const notes: string[] = [];
      let spillPath: string | undefined;
      if (truncated) {
        spillPath = spillTruncatedOutput(config.spillDir, env.sessionId, env.callId, result.output);
        notes.push(
          spillPath === undefined
            ? "[Output truncated; showing the end.]"
            : `[Output truncated; showing the end. Full output saved to ${spillPath} — use read(offset, limit) or grep to inspect earlier lines.]`,
        );
      }
      if (result.timedOut) notes.push(`[Timed out after ${seconds}s; the command was killed.]`);
      if (result.aborted) notes.push("[Aborted; the command was killed.]");
      if (!result.timedOut && !result.aborted && result.exitCode !== 0) notes.push(`[Exit code ${result.exitCode}]`);
      const body = [truncated ? notes.shift() : undefined, text === "" ? "(no output)" : text, ...notes].filter((part) => part !== undefined).join("\n");
      return {
        content: [{ type: "text", text: body }],
        isError: result.timedOut || result.aborted || result.exitCode !== 0,
        details: spillPath === undefined ? { exitCode: result.exitCode } : { exitCode: result.exitCode, spillPath },
      };
    },
  };
}

export function bashTool(config: Config = {}, isSandboxed?: () => boolean, options?: ShellToolOptions): ToolDefinition<ShellToolArgs> {
  return shellTool("bash", config, isSandboxed, undefined, options);
}

export function powershellTool(
  config: Config = {},
  isSandboxed?: () => boolean,
  shellPath?: string,
  options?: ShellToolOptions,
): ToolDefinition<ShellToolArgs> {
  return shellTool("powershell", config, isSandboxed, shellPath, options);
}

export function apply(ctx: Context, config: Config = {}): void {
  // Decided once per load: a machine that gains Git Bash gets the bash tool on the next reload.
  const chosen = chooseShell(config);
  const manager = new BackgroundProcessManager();
  ctx.effect(
    () => ctx.tools.register(shellTool(chosen.kind, config, () => ctx.get("bashSandbox")?.enabled === true, chosen.path, { manager, ctx })),
    `${name}: ${chosen.kind}`,
  );
  ctx.effect(() => ctx.tools.register(bgProcessTool(manager)), `${name}: bg_process`);
  ctx.on("session/deleted", (sessionId) => manager.stopSession(sessionId));
  ctx.on("session/unloaded", (sessionId) => manager.stopSession(sessionId));
  ctx.on("agent/settled", async (session) => {
    if (session.header.parent !== undefined) manager.stopSession(session.id);
  });
  ctx.effect(() => () => manager.stopAll(), `${name}: bg-cleanup`);

  ctx.inject(["rpc"], (rpcCtx) => {
    rpcCtx.effect(
      () =>
        rpcCtx.rpc.method("sandbox.generateConfig", (params): SandboxGenerateConfigResult => {
          if (params !== undefined && params !== null && (typeof params !== "object" || Array.isArray(params))) {
            throw new RpcError(ErrorCode.InvalidParams, "params must be an object");
          }
          const p = (params ?? {}) as Record<string, unknown>;
          const requiredStr = (key: string): string => {
            const raw = p[key];
            if (typeof raw !== "string" || raw.trim() === "") {
              throw new RpcError(ErrorCode.InvalidParams, `${key} must be a non-empty string`);
            }
            return raw.trim();
          };
          const kindRaw = requiredStr("kind");
          if (kindRaw !== "wsb" && kindRaw !== "devcontainer") {
            throw new RpcError(ErrorCode.InvalidParams, "kind must be 'wsb' or 'devcontainer'");
          }
          const kind: SandboxConfigKind = kindRaw;
          const cwd = resolvePath(requiredStr("cwd"));
          const overwrite = p.overwrite === true;
          if (kind === "wsb") {
            const target = join(cwd, ".qianji", "sandbox.wsb");
            const content = generateWindowsSandboxConfig(cwd);
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, content, "utf8");
            return { kind, path: target, content };
          }
          const primaryTarget = join(cwd, ".devcontainer", "devcontainer.json");
          const target = !overwrite && existsSync(primaryTarget)
            ? join(cwd, ".qianji", "devcontainer.generated.json")
            : primaryTarget;
          const content = generateDevContainerConfig(cwd);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, content, "utf8");
          return { kind, path: target, content };
        }),
      `${name}: sandbox.generateConfig`,
    );
  });
}
