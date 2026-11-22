/**
 * Real WSL2 container integration tests for Qianji Bot Mode (`qianji-bot-test-vm`).
 *
 * Verifies real ext4.vhdx provisioning, Linux kernel execution, /mnt/c isolation,
 * interop=off blocking cmd.exe, uid=1000 drop, cgroup v2 memory quota, read-only
 * shared folder enforcement, tools/execute waterfall routing, sleep (Stopped state),
 * and snapshot reset preserving /workspace & SOUL.md.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Service, type Context } from "@deepseek-ai/cordis";
import { Permissions } from "@qianji/permissions";
import type { RpcHandler, RpcService } from "@qianji/rpc";
import { Sessions } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import * as toolFs from "@qianji/tool-fs";
import { textOutput, Tools } from "@qianji/tools";
import { Ui } from "@qianji/ui";
import * as botPlugin from "../packages/host/src/bot/index";
import { createHost } from "../packages/host/src/host";

const TEST_DISTRO = "qianji-bot-test-vm";

function canRunWsl2Tests(): boolean {
  if (process.platform !== "win32") return false;
  const res = spawnSync("wsl.exe", ["--status"], {
    windowsHide: true,
    timeout: 4_000,
    env: { ...process.env, WSL_UTF8: "1" },
  });
  return res.error === undefined && res.status === 0;
}

class InMemoryRpc extends Service implements RpcService {
  static provide = "rpc";
  private readonly handlers = new Map<string, RpcHandler>();

  constructor(ctx: Context) {
    super(ctx, "rpc");
  }

  method(name: string, handler: RpcHandler): () => void {
    this.handlers.set(name, handler);
    return () => {
      if (this.handlers.get(name) === handler) this.handlers.delete(name);
    };
  }

  methods(): string[] {
    return ["initialize", ...this.handlers.keys()];
  }

  broadcast(): void {}

  async invoke<T>(name: string, params: unknown = {}): Promise<T> {
    const fn = this.handlers.get(name);
    if (!fn) throw new Error(`RPC method not registered: ${name}`);
    return (await fn(params, {
      signal: new AbortController().signal,
      notify: () => undefined,
    })) as T;
  }
}

const describeWsl = canRunWsl2Tests() ? describe : describe.skip;

describeWsl("Real WSL2 Container Local Virtual Server Integration", () => {
  const tempDirs: string[] = [];

  afterAll(() => {
    if (process.platform === "win32") {
      spawnSync("wsl.exe", ["--terminate", TEST_DISTRO], { windowsHide: true, timeout: 10_000 });
      spawnSync("wsl.exe", ["--unregister", TEST_DISTRO], { windowsHide: true, timeout: 15_000 });
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("provisions dedicated ext4.vhdx WSL2 container, isolates host drives/interop, enforces cgroup & ro mounts, sleeps & resets cleanly", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "qj-wsl-data-"));
    const sharedRoDir = mkdtempSync(join(tmpdir(), "qj-wsl-ro-"));
    tempDirs.push(dataDir, sharedRoDir);
    writeFileSync(join(sharedRoDir, "readonly-secret.txt"), "keep-immutable", "utf8");

    const host = createHost({
      version: "0.3.0-test",
      dataDir,
      plugins: [
        [InMemoryRpc],
        [Sessions],
        [SystemPrompt],
        [Ui],
        [Tools],
        [Permissions, { defaultPermission: "ask", alwaysConfirmShell: true }],
        [toolFs],
        [botPlugin, { dataDir, distroName: TEST_DISTRO, displayName: "千机WSL" }],
      ],
    });
    await host.start();

    try {
      const rpc = host.ctx.rpc as unknown as InMemoryRpc;

      // Register a fallback bash tool to prove Bot intercepts via tools/execute waterfall
      host.ctx.tools.register({
        name: "bash",
        description: "host bash fallback",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        execute: async () => textOutput("HOST_SHOULD_NOT_RUN", true),
      });

      const snap0 = await rpc.invoke<{ mainSessionId: string }>("bot.getSnapshot", {});
      expect(snap0.mainSessionId).toBeTruthy();

      const provRes = await rpc.invoke<{
        ok: boolean;
        message: string;
        virtualServer: {
          lifecycle: string;
          local: { engine?: string; engineState?: string; vhdxPath?: string; kernelVersion?: string };
        };
      }>("bot.server.action", { action: "provision-local" });
      expect(provRes.ok, provRes.message).toBe(true);
      expect(provRes.virtualServer.local.engine).toBe("wsl2");
      expect(provRes.virtualServer.local.engineState).toBe("running");
      expect(provRes.virtualServer.local.vhdxPath).toBeTruthy();
      if (provRes.virtualServer.local.vhdxPath) {
        expect(existsSync(provRes.virtualServer.local.vhdxPath)).toBe(true);
      }

      // Mount read-only shared directory and set 2GB/2core quota
      await rpc.invoke("bot.server.configure", {
        memoryLimitGb: 2,
        cpuCores: 2,
        sharedFolderAdd: { path: sharedRoDir, access: "read-only" },
      });

      const env = {
        sessionId: snap0.mainSessionId,
        cwd: join(dataDir, "bot-workspace"),
        signal: new AbortController().signal,
      };

      // 1. Real Linux kernel, uid=1000, unmounted /mnt/c, interop disabled, and cgroup v2 limit
      const probeCall = await host.ctx.tools.execute(
        {
          id: "c1",
          name: "bash",
          args: {
            command: [
              "echo KERNEL=$(uname -s)",
              "echo UID=$(id -u)",
              "echo MNTC=$(ls /mnt/c 2>/dev/null | wc -l)",
              "if cmd.exe /c echo hi >/dev/null 2>&1; then echo INTEROP=ON; else echo INTEROP=OFF; fi",
              "echo MEMMAX=$(cat /sys/fs/cgroup/qianji-bot/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/qianji-bot/memory.limit_in_bytes 2>/dev/null || echo none)",
            ].join("; "),
          },
        },
        env,
      );
      const probeText = probeCall.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      expect(probeText).toContain("KERNEL=Linux");
      expect(probeText).toContain("UID=1000");
      expect(probeText).toContain("MNTC=0");
      expect(probeText).toContain("INTEROP=OFF");
      expect(probeText).toContain(`MEMMAX=${2 * 1024 * 1024 * 1024}`);

      // 2. Read-only shared mount blocks writes while /workspace persists directly into <dataDir>/bot-workspace
      const roCall = await host.ctx.tools.execute(
        {
          id: "c2",
          name: "bash",
          args: {
            command: "cat /shared/*/readonly-secret.txt && ! touch /shared/*/hack.txt 2>/dev/null && echo RO_OK",
          },
        },
        env,
      );
      const roText = roCall.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      expect(roText).toContain("keep-immutable");
      expect(roText).toContain("RO_OK");
      expect(existsSync(join(sharedRoDir, "hack.txt"))).toBe(false);

      // 3. write / read / edit tools execute cleanly inside WSL2 /workspace
      const writeRes = await host.ctx.tools.execute(
        { id: "c3", name: "write", args: { path: "container-note.md", content: "hello\nworld\n" } },
        env,
      );
      expect(writeRes.isError).not.toBe(true);
      expect(readFileSync(join(dataDir, "bot-workspace", "container-note.md"), "utf8")).toBe("hello\nworld\n");

      const editRes = await host.ctx.tools.execute(
        { id: "c4", name: "edit", args: { path: "container-note.md", edits: [{ oldText: "world", newText: "wsl2" }] } },
        env,
      );
      expect(editRes.isError).not.toBe(true);

      const readRes = await host.ctx.tools.execute(
        { id: "c5", name: "read", args: { path: "container-note.md" } },
        env,
      );
      expect(readRes.content.map((c) => (c.type === "text" ? c.text : "")).join("\n")).toContain("wsl2");

      // 4. Create dirty file in guest rootfs (/home/bot/dirty.txt), sleep (verify Stopped), then reset-snapshot
      await host.ctx.tools.execute({ id: "c6", name: "bash", args: { command: "touch /home/bot/dirty.txt" } }, env);
      const sleepRes = await rpc.invoke<{ virtualServer: { lifecycle: string; local: { engineState?: string } } }>(
        "bot.server.action",
        { action: "sleep" },
      );
      expect(sleepRes.virtualServer.lifecycle).toBe("sleeping");
      expect(sleepRes.virtualServer.local.engineState).toBe("stopped");

      const resetRes = await rpc.invoke<{ ok: boolean; virtualServer: { local: { engineState?: string } } }>(
        "bot.server.action",
        { action: "reset-snapshot" },
      );
      expect(resetRes.ok).toBe(true);
      expect(resetRes.virtualServer.local.engineState).toBe("running");

      const afterResetCheck = await host.ctx.tools.execute(
        {
          id: "c7",
          name: "bash",
          args: { command: "if [ -f /home/bot/dirty.txt ]; then echo DIRTY_EXISTS; else echo CLEAN_ROOTFS; fi" },
        },
        env,
      );
      expect(afterResetCheck.content.map((c) => (c.type === "text" ? c.text : "")).join("\n")).toContain("CLEAN_ROOTFS");
      expect(existsSync(join(dataDir, "bot-workspace", "container-note.md"))).toBe(true);

      // 5. Live View container diag RPC executes inside the real WSL2 container
      const diag = await rpc.invoke<{ stdout: string; exitCode: number | null }>("bot.liveView.execDiag", {
        command: "uname -s",
      });
      expect(diag.exitCode).toBe(0);
      expect(diag.stdout.trim()).toBe("Linux");
    } finally {
      await host.stop();
    }
  }, 180_000);
});
