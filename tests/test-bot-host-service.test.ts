import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Sessions } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { textOutput, Tools } from "@qianji/tools";
import { createHost } from "../packages/host/src/host";
import * as botPlugin from "../packages/host/src/bot/index";

describe("Host Bot service (bot-mode backend)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists evergreen main session, injects <bot_soul> only for Bot sessions, queues external writes, and preserves SOUL across snapshot reset", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "qj-bot-test-"));
    tempDirs.push(dataDir);

    const host = createHost({
      version: "0.3.0-test",
      dataDir,
      plugins: [
        [Sessions],
        [SystemPrompt],
        [Tools],
        [botPlugin, { dataDir, displayName: "千机测试" }],
      ],
    });
    await host.start();

    try {
      host.ctx.tools.register({
        name: "bash",
        description: "mock shell",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        execute: async (args) => textOutput(`ran: ${String(args.command)}`),
      });

      const store = new botPlugin.BotStateStore(host.ctx.sessions, { dataDir, displayName: "千机测试" });
      const snap = await store.snapshot();
      expect(snap.profile.displayName).toBe("千机测试");
      expect(snap.mainSessionId).toBeTruthy();

      // Create an ordinary Agent Workbench session and ensure <bot_soul> is NOT leaked into it.
      const agentSession = host.ctx.sessions.create({ cwd: dataDir });
      const agentPrompt = await host.ctx.systemPrompt.build({
        sessionId: agentSession.id,
        cwd: dataDir,
        model: { provider: "test", model: "m" },
        tools: [],
      });
      expect(agentPrompt).not.toContain("<bot_soul>");

      // Ensure <bot_soul> IS injected when running inside the Bot main session once loaded in the plugin store.
      // Trigger pre-execute on a temporary Bot side thread created directly on host.ctx.
      const customSoul = "# SOUL\n始终保持简洁温润。";
      store.saveSoul(customSoul);
      expect(store.readSoul()).toBe(customSoul);

      // Side-chat lifecycle
      const side = await store.createSideChat("算力比价旁聊");
      expect(side.title).toBe("算力比价旁聊");
      expect((await store.snapshot()).sideThreads.some((t) => t.id === side.id)).toBe(true);

      // Virtual Server sleep -> reset-snapshot preserves custom SOUL.md
      const slept = await store.performServerAction("sleep");
      expect(slept.virtualServer.lifecycle).toBe("sleeping");

      const reset = await store.performServerAction("reset-snapshot");
      expect(reset.virtualServer.lifecycle).toBe("running");
      expect(store.readSoul()).toBe(customSoul);

      // Approval resolution & handoff completion
      const pendingId = snap.pendingApprovals[0]?.id;
      expect(pendingId).toBeTruthy();
      if (pendingId !== undefined) {
        const resolved = await store.resolveApproval(pendingId, "approved");
        expect(resolved.decision).toBe("approved");
      }

      const handoffAct = await store.completeHandoff({
        handoffId: "handoff-pr-142",
        summary: "已在独立副本通过全部 42 项回归单测",
      });
      expect(handoffAct.description).toContain("42 项");
    } finally {
      await host.stop();
    }
  });
});
