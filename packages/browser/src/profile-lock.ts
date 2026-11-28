/**
 * Persistent browser profile lock, live-process verification, and orphaned
 * DevTools browser recovery for `@qianji/browser`.
 */
import { spawn } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
    return code !== "ESRCH";
  }
}

export function terminateWindowsProcessTree(processId: number, force: boolean): Promise<void> {
  return new Promise((resolve) => {
    const args = ["/PID", String(processId), "/T", ...(force ? ["/F"] : [])];
    const killer = spawn("taskkill", args, { windowsHide: true, stdio: "ignore" });
    const timeout = setTimeout(resolve, 3_000);
    killer.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    killer.once("error", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

export async function waitForBrowserShutdown(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (!response.ok) return true;
    } catch {
      return true;
    }
    await delay(100);
  }
  return false;
}

async function sendAdminCommand<T>(socket: WebSocket, id: number, method: string, timeoutMs = 5_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out running browser command ${method}`));
    }, timeoutMs);
    const onMessage = (event: MessageEvent) => {
      let msg: { id?: number; result?: T; error?: { message?: string } };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.id !== id) return;
      cleanup();
      if (msg.error) reject(new Error(msg.error.message || "Browser command failed"));
      else resolve(msg.result as T);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Browser connection closed"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.send(JSON.stringify({ id, method, params: {} }));
  });
}

export async function closeBrowser(port: number): Promise<number | null> {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error("Browser debugging endpoint did not return version information");
  const version = (await response.json()) as { webSocketDebuggerUrl?: string };
  if (!version.webSocketDebuggerUrl) {
    throw new Error("Browser debugging endpoint did not provide a browser connection");
  }
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to browser")), 5_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not connect to browser debugging endpoint"));
    }, { once: true });
  });
  try {
    const processes = await sendAdminCommand<{ processInfo?: Array<{ type?: string; id?: number }> }>(
      socket,
      1,
      "SystemInfo.getProcessInfo",
    ).catch(() => ({ processInfo: [] }));
    const browserProcessId = processes.processInfo?.find((info) => info.type === "browser")?.id ?? null;
    await sendAdminCommand(socket, 2, "Browser.close", 5_000).catch(() => undefined);
    return browserProcessId;
  } finally {
    socket.close();
  }
}

export async function cleanupOrphanedBrowserProfile(directory: string): Promise<void> {
  const lockPath = join(directory, ".qianji-browser.lock");
  const activePortPath = join(directory, "DevToolsActivePort");
  const ownerPid = await readFile(lockPath, "utf8")
    .then((raw) => Number.parseInt(raw.trim(), 10))
    .catch(() => 0);

  if (ownerPid > 0 && ownerPid !== process.pid && isProcessAlive(ownerPid)) {
    throw new Error("The persistent Qianji browser profile is already in use by another task");
  }

  const activePort = await readFile(activePortPath, "utf8")
    .then((raw) => Number(raw.split(/\r?\n/)[0]))
    .catch(() => 0);

  if (activePort > 0) {
    const browserPid = await closeBrowser(activePort).catch(() => null);
    const stopped = await waitForBrowserShutdown(activePort, 2_000);
    if (!stopped && browserPid && process.platform === "win32") {
      await terminateWindowsProcessTree(browserPid, true);
      await waitForBrowserShutdown(activePort, 3_000);
    }
  }

  await unlink(activePortPath).catch(() => undefined);
  await unlink(lockPath).catch(() => undefined);
}

export async function acquireProfileLock(directory: string): Promise<string> {
  const lockPath = join(directory, ".qianji-browser.lock");
  try {
    await writeFile(lockPath, `${process.pid}\n`, { flag: "wx" });
    return lockPath;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
  }

  await cleanupOrphanedBrowserProfile(directory);
  await writeFile(lockPath, `${process.pid}\n`, { flag: "wx" });
  return lockPath;
}
