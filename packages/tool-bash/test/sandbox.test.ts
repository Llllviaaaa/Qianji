import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BackgroundProcessManager,
  bindAsyncJobObjectDisposer,
  buildSandboxedEnv,
  findShell,
  generateDevContainerConfig,
  generateWindowsSandboxConfig,
  inspectSandboxedCommand,
  runCommand,
  shellArgs,
} from "../src/index.ts";

async function cleanupTempDir(dir: string): Promise<void> {
  // Recently killed sandboxed child trees on Windows can briefly hold cwd/temp handles (EPERM/EBUSY).
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  } catch {
    // Left for OS temp cleanup if a child handle outlives the retry window.
  }
}

describe("lightweight sandbox helpers", () => {
  it("scrubs secret environment variables and redirects temp directories into workspace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pid-sandbox-test-"));
    try {
      const env = buildSandboxedEnv(
        {
          PATH: process.env.PATH ?? "",
          OPENAI_API_KEY: "sk-secret",
          GITHUB_TOKEN: "ghp_secret",
          CUSTOM_DB_PASSWORD: "hunter2",
          AWS_SECRET_ACCESS_KEY: "aws-secret",
          NODE_ENV: "test",
        },
        dir,
      );
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.CUSTOM_DB_PASSWORD).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.NODE_ENV).toBe("test");
      expect(env.QIANJI_SANDBOX).toBe("1");
      expect(env.TMP).toBe(join(dir, ".qianji", "sandbox-tmp"));
      expect(env.TEMP).toBe(join(dir, ".qianji", "sandbox-tmp"));
    } finally {
      await cleanupTempDir(dir);
    }
  });

  it("blocks system-tampering commands while allowing normal developer commands", () => {
    expect(inspectSandboxedCommand("npm test && git status")).toBeUndefined();
    expect(inspectSandboxedCommand("reg add HKCU\\Software\\Test /v Foo /d Bar")).toMatch(/Registry/);
    expect(inspectSandboxedCommand("schtasks /create /tn Backdoor /tr cmd.exe /sc once /st 00:00")).toMatch(
      /Scheduled Task/,
    );
    expect(inspectSandboxedCommand("echo pwn > C:\\Windows\\System32\\drivers\\etc\\hosts")).toMatch(
      /Windows system directory/,
    );
    expect(inspectSandboxedCommand("powershell -c \"Start-Process cmd -Verb RunAs\"")).toMatch(/UAC elevation/);
    expect(inspectSandboxedCommand("taskkill /F /IM qianji.exe")).toMatch(/已拦截针对千机自身进程/);
    expect(inspectSandboxedCommand(`kill -9 ${process.pid}`)).toMatch(/已拦截针对千机自身进程/);
  });

  it("runs sandboxed commands without leaking scrubbed secrets", async () => {
    const shell = findShell();
    if (shell === undefined) return;
    const dir = mkdtempSync(join(tmpdir(), "pid-sandbox-exec-"));
    try {
      const result = await runCommand(
        shell,
        "printf '%s|%s' \"${OPENAI_API_KEY:-missing}\" \"${QIANJI_SANDBOX:-0}\"",
        dir,
        10_000,
        new AbortController().signal,
        {
          sandbox: true,
          env: {
            ...process.env,
            OPENAI_API_KEY: "placeholder-should-not-leak",
          },
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe("missing|1");
    } finally {
      await cleanupTempDir(dir);
    }
  });

  it("generates valid Windows Sandbox (.wsb) and Dev Container configs", () => {
    const wsb = generateWindowsSandboxConfig("D:\\repo\\A&B");
    expect(wsb).toContain("<Configuration>");
    expect(wsb).toContain("A&amp;B");
    expect(wsb).toContain("<ProtectedClient>Enable</ProtectedClient>");

    const devcontainer = JSON.parse(generateDevContainerConfig("D:\\repo\\my-app")) as {
      name: string;
      image: string;
    };
    expect(devcontainer.name).toBe("Qianji (my-app)");
    expect(devcontainer.image).toContain("devcontainers/base");
  });

  it("handles async Job Object attachment races on fast exit, pre-resolution stop/abort, and rejection", async () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    // 1. Normal lifecycle: attachment resolves before cleanup, disposer runs once on dispose.
    const normalPending = deferred<(() => void) | undefined>();
    const normalDisposer = vi.fn();
    const normalStopped = vi.fn();
    const normalBinding = bindAsyncJobObjectDisposer(normalPending.promise, {
      onStoppedResolve: normalStopped,
    });
    normalPending.resolve(normalDisposer);
    await normalBinding.settled;
    expect(normalDisposer).not.toHaveBeenCalled();
    normalBinding.dispose();
    normalBinding.dispose({ stopped: true });
    expect(normalDisposer).toHaveBeenCalledTimes(1);
    expect(normalStopped).not.toHaveBeenCalled();

    // 2. Fast-exit race: process exits and calls dispose() before attachment resolves.
    const fastPending = deferred<(() => void) | undefined>();
    const fastDisposer = vi.fn();
    const fastStopped = vi.fn();
    const fastBinding = bindAsyncJobObjectDisposer(fastPending.promise, {
      onStoppedResolve: fastStopped,
    });
    fastBinding.dispose();
    expect(fastDisposer).not.toHaveBeenCalled();
    fastPending.resolve(fastDisposer);
    await fastBinding.settled;
    fastBinding.dispose();
    expect(fastDisposer).toHaveBeenCalledTimes(1);
    expect(fastStopped).not.toHaveBeenCalled();

    // 3. Pre-resolution stop/abort race: stop() runs before attachment resolves.
    let settledFlag = false;
    let stoppedFlag = false;
    const abortPending = deferred<(() => void) | undefined>();
    const abortDisposer = vi.fn();
    const abortLateKill = vi.fn();
    const abortBinding = bindAsyncJobObjectDisposer(abortPending.promise, {
      isDisposed: () => settledFlag || stoppedFlag,
      isStopped: () => stoppedFlag,
      onStoppedResolve: abortLateKill,
    });
    stoppedFlag = true;
    abortBinding.dispose({ stopped: true });
    expect(abortDisposer).not.toHaveBeenCalled();
    abortPending.resolve(abortDisposer);
    await abortBinding.settled;
    settledFlag = true;
    abortBinding.dispose();
    expect(abortDisposer).toHaveBeenCalledTimes(1);
    expect(abortLateKill).toHaveBeenCalledTimes(1);

    // 4. External state flag race before dispose() is called directly.
    const flagPending = deferred<(() => void) | undefined>();
    const flagDisposer = vi.fn();
    let externalExited = false;
    const flagBinding = bindAsyncJobObjectDisposer(flagPending.promise, {
      isDisposed: () => externalExited,
    });
    externalExited = true;
    flagPending.resolve(flagDisposer);
    await flagBinding.settled;
    flagBinding.dispose();
    expect(flagDisposer).toHaveBeenCalledTimes(1);

    // 5. Rejected attachment promise is swallowed safely.
    const failedPending = deferred<(() => void) | undefined>();
    const failedBinding = bindAsyncJobObjectDisposer(failedPending.promise);
    failedPending.reject(new Error("attach failed"));
    await expect(failedBinding.settled).resolves.toBeUndefined();
  });

  it("completes sandboxed pre-aborted runCommand and background stop cleanly without hanging", async () => {
    const shell = findShell();
    if (shell === undefined) return;
    const dir = mkdtempSync(join(tmpdir(), "pid-sandbox-race-"));
    const manager = new BackgroundProcessManager();
    try {
      const preAborted = new AbortController();
      preAborted.abort();
      const abortedRes = await runCommand(shell, "sleep 5", dir, 5_000, preAborted.signal, { sandbox: true });
      expect(abortedRes.aborted).toBe(true);

      const started = manager.start({
        sessionId: "s-race",
        shellPath: shell,
        shellArgs: shellArgs(shell, "sleep 5"),
        command: "sleep 5",
        cwd: dir,
        sandbox: true,
      });
      const stopped = await manager.stop("s-race", started.id);
      expect(stopped?.status).toBe("exited");
    } finally {
      await manager.stopAll();
      await cleanupTempDir(dir);
    }
  });
});
