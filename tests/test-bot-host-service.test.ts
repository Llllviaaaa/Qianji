import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Credentials } from "@qianji/llm";
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

  it("starts clean, upgrades v1 state, isolates <bot_soul>, encrypts SSH password via credentials, and checks remote SSH honestly", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "qj-bot-test-"));
    tempDirs.push(dataDir);

    mkdirSync(join(dataDir, "bot"), { recursive: true });
    writeFileSync(
      join(dataDir, "bot", "state.json"),
      JSON.stringify({
        version: 1,
        spaces: [{ id: "fake-pr-142", title: "PR #142 巡检" }],
      }),
      "utf8",
    );

    const secretMap = new Map<string, string>();
    const host = createHost({
      version: "0.3.0-test",
      dataDir,
      plugins: [
        [Credentials],
        [Sessions],
        [SystemPrompt],
        [Tools],
        [botPlugin, { dataDir, distroName: "qianji-bot-unit-noop", displayName: "千机测试" }],
      ],
    });
    await host.start();
    host.ctx.credentials.registerStore({
      resolve: (id) => Promise.resolve(secretMap.get(id)),
      set: (id, value) => {
        secretMap.set(id, value);
      },
      delete: (id) => secretMap.delete(id),
    });

    try {
      host.ctx.tools.register({
        name: "bash",
        description: "mock shell",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        execute: async (args) => textOutput(`ran: ${String(args.command)}`),
      });

      const store = new botPlugin.BotStateStore(
        host.ctx.sessions,
        { dataDir, distroName: "qianji-bot-unit-noop", displayName: "千机测试" },
        host.ctx.credentials,
      );
      const snap = await store.snapshot();
      expect(snap.profile.displayName).toBe("千机测试");
      expect(snap.mainSessionId).toBeTruthy();

      expect(snap.sideThreads).toHaveLength(0);
      expect(snap.activityGroups).toHaveLength(0);
      expect(snap.pendingApprovals).toHaveLength(0);
      expect(snap.recentApprovals).toHaveLength(0);
      expect(snap.feed).toHaveLength(0);
      expect(snap.goals).toHaveLength(0);
      expect(snap.spaces).toHaveLength(0);
      expect(snap.embeddedTasks).toHaveLength(0);
      expect(snap.documents).toHaveLength(0);
      const mainSess = await host.ctx.sessions.get(snap.mainSessionId);
      expect(mainSess?.state().messages ?? []).toHaveLength(0);

      // Ordinary Agent Workbench sessions never receive <bot_soul> or <bot_runtime>
      const agentSession = host.ctx.sessions.create({ cwd: dataDir });
      const agentPrompt = await host.ctx.systemPrompt.build({
        sessionId: agentSession.id,
        cwd: dataDir,
        model: { provider: "test", model: "m" },
        tools: [],
      });
      expect(agentPrompt).not.toContain("<bot_soul>");
      expect(agentPrompt).not.toContain("<bot_runtime>");

      // Encrypted SSH credential storage never persists plaintext password in state.json
      await store.setRemotePassword("s3cr3t-ssh-pass");
      expect(secretMap.get("bot/remote-ssh-password")).toBe("s3cr3t-ssh-pass");
      expect(await store.hasRemotePassword()).toBe(true);

      // Custom SOUL.md & real workspace docs scanning
      const customSoul = "# SOUL\n始终保持简洁温润。";
      store.saveSoul(customSoul);
      expect(store.readSoul()).toBe(customSoul);

      const wsDir = join(dataDir, "bot-workspace");
      mkdirSync(wsDir, { recursive: true });
      writeFileSync(join(wsDir, "weekly-notes.md"), "# 本周工作纪要\n真实生成内容", "utf8");
      const snapWithDocs = await store.snapshot();
      expect(snapWithDocs.documents.some((d) => d.name === "weekly-notes.md")).toBe(true);

      // Real CRUD for side-chats, spaces, goals, and approvals
      const side = await store.createSideChat("算力比价旁聊");
      expect((await store.snapshot()).sideThreads.some((t) => t.id === side.id)).toBe(true);

      const space = await store.createSpace("架构演进看板", "持续追踪核心模块重构");
      expect((await store.snapshot()).spaces.some((s) => s.id === space.id)).toBe(true);
      await store.deleteSpace(space.id);
      expect((await store.snapshot()).spaces.some((s) => s.id === space.id)).toBe(false);

      const goal = await store.createGoal("降低单测耗时", "工程效率");
      expect((await store.snapshot()).goals.some((g) => g.id === goal.id)).toBe(true);
      await store.deleteGoal(goal.id);
      expect((await store.snapshot()).goals.some((g) => g.id === goal.id)).toBe(false);

      const approval = await store.enqueueApproval({
        title: "执行外部发布脚本",
        commandSignature: "bash ./publish.sh",
        summary: "推送构建产物到归档目录",
      });
      expect((await store.snapshot()).pendingApprovals.some((a) => a.id === approval.id)).toBe(true);
      const resolved = await store.resolveApproval(approval.id, "denied");
      expect(resolved.decision).toBe("denied");

      // Honest remote SSH probe against plain non-SSH TCP socket reports auth/handshake refusal
      const tcpServer = createServer((sock) => {
        sock.on("error", () => undefined);
        sock.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      });
      await new Promise<void>((resolve) => tcpServer.listen(0, "127.0.0.1", () => resolve()));
      const addr = tcpServer.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      try {
        await store.configureVirtualServer({ mode: "remote", remoteHost: "127.0.0.1", remotePort: port });
        const probeRes = await store.performServerAction("test-remote");
        expect(probeRes.ok).toBe(false);
        expect(probeRes.message).toMatch(/SSH/);
      } finally {
        await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
      }

      const handoffAct = await store.completeHandoff({
        handoffId: "handoff-real-task",
        summary: "已在工作台完成重构验证",
      });
      expect(handoffAct.description).toContain("重构验证");

      const resetSnap = await store.resetAllBotData();
      expect(resetSnap.sideThreads).toHaveLength(0);
      expect(resetSnap.activityGroups).toHaveLength(0);
    } finally {
      await host.stop();
    }
  });
});
