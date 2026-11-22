/**
 * Built-in Host `bot` Cordis plugin (`packages/host/src/bot/index.ts`).
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  ErrorCode,
  type BotAvatarPresetId,
  type BotHandoffCompleteResult,
  type BotServerActionKind,
  type BotServerMode,
} from "@qianji/protocol";
import { RpcError } from "@qianji/rpc";
import "@qianji/agent";
import "@qianji/session";
import { SectionOrder } from "@qianji/system-prompt";
import "@qianji/tools";
import { BotStateStore, type BotStoreConfig } from "./store.ts";

export { BotStateStore, type BotStoreConfig };
export * from "./defaults.ts";

export const name = "qianji-bot";
export const inject = ["sessions", "systemPrompt", "tools"];

const EXTERNAL_SIDE_EFFECT_RE = /\b(?:gh\s+pr\s+(?:comment|merge|close|review|create)|gh\s+issue\s+(?:comment|create|close)|git\s+push|sendmail|msmtp)\b/i;

type Params = Record<string, unknown>;

function asObject(raw: unknown): Params {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new RpcError(ErrorCode.InvalidParams, "params must be an object");
  }
  return raw as Params;
}

function reqString(p: Params, key: string): string {
  const val = p[key];
  if (typeof val !== "string" || val.trim() === "") {
    throw new RpcError(ErrorCode.InvalidParams, `${key} must be a non-empty string`);
  }
  return val;
}

const VALID_SERVER_ACTIONS = new Set<BotServerActionKind>([
  "start",
  "sleep",
  "restart",
  "reset-snapshot",
  "test-remote",
  "init-remote",
]);

export function apply(ctx: Context, config: BotStoreConfig): void {
  const store = new BotStateStore(ctx.sessions, config);

  // 1. Inject SOUL.md exclusively into Bot-scoped sessions (`bot-main` & `bot-side`).
  ctx.systemPrompt.section(
    "bot-soul",
    (env) => {
      if (!store.isBotSession(env.sessionId)) return undefined;
      const soul = store.readSoul().trim();
      if (soul === "") return undefined;
      return `<bot_soul>\n${soul}\n</bot_soul>`;
    },
    { order: SectionOrder.guidelines + 10 },
  );

  // 2. Record real activity whenever a Bot session turn settles.
  ctx.on("agent/settled", async (session) => {
    if (!store.isBotSession(session.id)) return;
    await store.recordSettledTurn(session);
    ctx.rpc?.broadcast("bot/updated", { reason: "turn-settled", sessionId: session.id });
  });

  // 3. Queue external side-effect shell commands in Bot sessions into the Approvals inbox.
  ctx.on(
    "tools/pre-execute",
    async (call, env) => {
      if (!store.isBotSession(env.sessionId)) return undefined;
      if (call.name !== "bash" && call.name !== "powershell") return undefined;
      const cmd = typeof call.args.command === "string" ? call.args.command.trim() : "";
      if (cmd === "" || !EXTERNAL_SIDE_EFFECT_RE.test(cmd)) return undefined;

      const approval = await store.enqueueApproval(
        {
          title: `执行外部操作：${cmd.slice(0, 48)}`,
          commandSignature: `${cmd.slice(0, 64)} · 外部写操作`,
          summary: "分身请求执行具有外部影响的命令，已自动挂入右侧「批准」栏等待你的确认。",
          sessionId: env.sessionId,
        },
        cmd,
      );
      ctx.rpc?.broadcast("bot/updated", { reason: "approval-queued", approvalId: approval.id });
      return {
        deny: true,
        reason: `External write operation queued in Bot Approvals panel (id: ${approval.id}). Tell the user they can approve or deny it in the right-side 批准 tab.`,
      };
    },
    true,
  );

  // 4. Register JSON-RPC 2.0 `bot.*` methods whenever `rpc` service is mounted.
  ctx.inject(["rpc"], (rpcCtx) => {
    const notifyUpdated = (reason: string) => {
      rpcCtx.rpc.broadcast("bot/updated", { reason, ts: Date.now() });
    };

    rpcCtx.rpc.method("bot.getSnapshot", async () => store.snapshot());

    rpcCtx.rpc.method("bot.updateProfile", async (raw) => {
      const p = asObject(raw);
      const profile = await store.updateProfile({
        ...(typeof p.displayName === "string" ? { displayName: p.displayName } : {}),
        ...(typeof p.avatarPreset === "string" ? { avatarPreset: p.avatarPreset as BotAvatarPresetId } : {}),
        ...(typeof p.customAvatarDataUrl === "string" ? { customAvatarDataUrl: p.customAvatarDataUrl } : {}),
      });
      notifyUpdated("profile");
      return { profile };
    });

    rpcCtx.rpc.method("bot.sideChat.create", async (raw) => {
      const p = asObject(raw);
      const thread = await store.createSideChat(typeof p.title === "string" ? p.title : undefined);
      notifyUpdated("side-chat-created");
      return { thread };
    });

    rpcCtx.rpc.method("bot.sideChat.delete", async (raw) => {
      const p = asObject(raw);
      await store.deleteSideChat(reqString(p, "id"));
      notifyUpdated("side-chat-deleted");
      return { ok: true };
    });

    rpcCtx.rpc.method("bot.soul.get", async () => {
      const snap = await store.snapshot();
      return { content: snap.soulContent, updatedAt: snap.soulUpdatedAt };
    });

    rpcCtx.rpc.method("bot.soul.save", (raw) => {
      const p = asObject(raw);
      if (typeof p.content !== "string") {
        throw new RpcError(ErrorCode.InvalidParams, "content must be a string");
      }
      const saved = store.saveSoul(p.content);
      notifyUpdated("soul-saved");
      return saved;
    });

    rpcCtx.rpc.method("bot.approvals.resolve", async (raw) => {
      const p = asObject(raw);
      const id = reqString(p, "id");
      const decision = p.decision === "denied" ? "denied" : p.decision === "approved" ? "approved" : undefined;
      if (decision === undefined) {
        throw new RpcError(ErrorCode.InvalidParams, 'decision must be "approved" or "denied"');
      }
      const resolved = await store.resolveApproval(id, decision);
      notifyUpdated("approval-resolved");
      return { resolved };
    });

    rpcCtx.rpc.method("bot.spaces.create", async (raw) => {
      const p = asObject(raw);
      const space = await store.createSpace(
        reqString(p, "title"),
        typeof p.description === "string" ? p.description : undefined,
      );
      notifyUpdated("space-created");
      return { space };
    });

    rpcCtx.rpc.method("bot.spaces.delete", async (raw) => {
      const p = asObject(raw);
      await store.deleteSpace(reqString(p, "id"));
      notifyUpdated("space-deleted");
      return { ok: true };
    });

    rpcCtx.rpc.method("bot.goals.create", async (raw) => {
      const p = asObject(raw);
      const goal = await store.createGoal(
        reqString(p, "title"),
        typeof p.category === "string" ? p.category : "通用",
      );
      notifyUpdated("goal-created");
      return { goal };
    });

    rpcCtx.rpc.method("bot.goals.delete", async (raw) => {
      const p = asObject(raw);
      await store.deleteGoal(reqString(p, "id"));
      notifyUpdated("goal-deleted");
      return { ok: true };
    });

    rpcCtx.rpc.method("bot.feed.create", async (raw) => {
      const p = asObject(raw);
      const item = await store.createFeedItem(
        reqString(p, "title"),
        reqString(p, "body"),
        typeof p.seedPrompt === "string" ? p.seedPrompt : undefined,
      );
      notifyUpdated("feed-created");
      return { item };
    });

    rpcCtx.rpc.method("bot.inbox.enable", async () => {
      const res = await store.enableInbox();
      notifyUpdated("inbox-enabled");
      return res;
    });

    rpcCtx.rpc.method("bot.connector.toggle", async (raw) => {
      const p = asObject(raw);
      await store.toggleConnector(reqString(p, "id"));
      notifyUpdated("connector-toggled");
      return { ok: true };
    });

    rpcCtx.rpc.method("bot.server.configure", async (raw) => {
      const p = asObject(raw);
      const addFolder =
        p.sharedFolderAdd && typeof p.sharedFolderAdd === "object" && !Array.isArray(p.sharedFolderAdd)
          ? (p.sharedFolderAdd as { path?: unknown; access?: unknown })
          : undefined;
      const virtualServer = await store.configureVirtualServer({
        ...(p.mode === "local" || p.mode === "remote" ? { mode: p.mode as BotServerMode } : {}),
        ...(typeof p.cpuCores === "number" ? { cpuCores: p.cpuCores } : {}),
        ...(typeof p.memoryLimitGb === "number" ? { memoryLimitGb: p.memoryLimitGb } : {}),
        ...(typeof p.diskLimitGb === "number" ? { diskLimitGb: p.diskLimitGb } : {}),
        ...(typeof p.autoSleepIdle === "boolean" ? { autoSleepIdle: p.autoSleepIdle } : {}),
        ...(typeof p.remoteHost === "string" ? { remoteHost: p.remoteHost } : {}),
        ...(typeof p.remotePort === "number" ? { remotePort: p.remotePort } : {}),
        ...(typeof p.remoteUser === "string" ? { remoteUser: p.remoteUser } : {}),
        ...(typeof p.remoteWorkDir === "string" ? { remoteWorkDir: p.remoteWorkDir } : {}),
        ...(addFolder && typeof addFolder.path === "string"
          ? {
              sharedFolderAdd: {
                path: addFolder.path,
                access: addFolder.access === "read-only" ? "read-only" : "isolated-copy",
              },
            }
          : {}),
        ...(typeof p.sharedFolderRemove === "string" ? { sharedFolderRemove: p.sharedFolderRemove } : {}),
      });
      notifyUpdated("server-configured");
      return { virtualServer };
    });

    rpcCtx.rpc.method("bot.server.action", async (raw) => {
      const p = asObject(raw);
      const action = reqString(p, "action") as BotServerActionKind;
      if (!VALID_SERVER_ACTIONS.has(action)) {
        throw new RpcError(ErrorCode.InvalidParams, `Unknown server action: ${action}`);
      }
      const res = await store.performServerAction(action);
      notifyUpdated("server-action");
      return res;
    });

    rpcCtx.rpc.method("bot.data.reset", async () => {
      const snap = await store.resetAllBotData();
      notifyUpdated("data-reset");
      return snap;
    });

    rpcCtx.rpc.method("bot.handoff.complete", async (raw): Promise<BotHandoffCompleteResult> => {
      const p = asObject(raw);
      const activity = await store.completeHandoff({
        handoffId: typeof p.handoffId === "string" ? p.handoffId : "handoff",
        title: typeof p.title === "string" ? p.title : undefined,
        summary: reqString(p, "summary"),
      });
      notifyUpdated("handoff-completed");
      return { ok: true, activity };
    });
  });
}
