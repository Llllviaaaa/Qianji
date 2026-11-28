/**
 * JSON-RPC 2.0 `bot.*` endpoint registration (`packages/host/src/bot/bot-rpc.ts`).
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Credentials } from "@qianji/llm";
import {
  ErrorCode,
  type BotAvatarPresetId,
  type BotHandoffCompleteResult,
  type BotRemoteAuthMethod,
  type BotServerActionKind,
  type BotServerMode,
} from "@qianji/protocol";
import { RpcError } from "@qianji/rpc";
import { McpOAuthTokenStore } from "../mcp-oauth-store.ts";
import type { PluginManager } from "../plugin-manager.ts";
import { registerBotConnectorRpcMethods } from "./bot-connector-rpc.ts";
import { registerBotDiscoveryRpc } from "./bot-discovery-rpc.ts";
import { registerBotThreadsRpc } from "./bot-threads-rpc.ts";
import { registerBotComputerRpc } from "./computer/bot-computer-rpc.ts";
import type { ProactivePulseEngine } from "./harness/bot-proactive-pulse.ts";
import { registerBotPluginConnectorRpc } from "./plugin-connector-rpc.ts";
import type { BotProactivePatch } from "./store-proactive.ts";
import type { BotStateStore } from "./store.ts";

function rethrowRpcError(err: unknown): never {
  if (err instanceof RpcError) throw err;
  throw new RpcError(ErrorCode.InternalError, err instanceof Error ? err.message : String(err));
}

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
  "provision-local",
  "reset-snapshot",
  "test-remote",
  "init-remote",
]);

export function registerBotRpcMethods(
  rpcCtx: Context,
  store: BotStateStore,
  pulse: ProactivePulseEngine,
  getPluginManager: () => PluginManager | undefined = () => undefined,
  mcpOAuthStore: McpOAuthTokenStore = new McpOAuthTokenStore(
    () => rpcCtx.get("credentials") as Credentials | undefined,
  ),
): void {
  const notifyUpdated = (reason: string) => {
    rpcCtx.rpc.broadcast("bot/updated", { reason, ts: Date.now() });
  };

  registerBotPluginConnectorRpc(rpcCtx, store, getPluginManager, notifyUpdated);
  registerBotConnectorRpcMethods(rpcCtx, store, mcpOAuthStore, notifyUpdated);
  registerBotThreadsRpc(rpcCtx, store, notifyUpdated);
  registerBotDiscoveryRpc(rpcCtx, store, pulse, notifyUpdated);
  registerBotComputerRpc(rpcCtx, store, notifyUpdated);

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

  rpcCtx.rpc.method("bot.configure", async (raw) => {
    const p = asObject(raw);
    const snapshot = await store.configureProactive(p as BotProactivePatch);
    notifyUpdated("proactive-configured");
    return { snapshot };
  });

  rpcCtx.rpc.method("bot.patrol.runNow", async (raw) => {
    const p = asObject(raw);
    const res = await pulse.runPatrol({ force: p.force !== false });
    const snapshot = await store.snapshot();
    return { ...res, snapshot };
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
    if (typeof p.remotePassword === "string") {
      await store.setRemotePassword(p.remotePassword);
    }
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
      ...(typeof p.storageDir === "string" ? { storageDir: p.storageDir } : {}),
      ...(typeof p.remoteHost === "string" ? { remoteHost: p.remoteHost } : {}),
      ...(typeof p.remotePort === "number" ? { remotePort: p.remotePort } : {}),
      ...(typeof p.remoteUser === "string" ? { remoteUser: p.remoteUser } : {}),
      ...(typeof p.remoteWorkDir === "string" ? { remoteWorkDir: p.remoteWorkDir } : {}),
      ...(p.remoteAuthMethod === "agent-or-key" || p.remoteAuthMethod === "password"
        ? { remoteAuthMethod: p.remoteAuthMethod as BotRemoteAuthMethod }
        : {}),
      ...(typeof p.remotePrivateKeyPath === "string" ? { remotePrivateKeyPath: p.remotePrivateKeyPath } : {}),
      ...(addFolder && typeof addFolder.path === "string"
        ? { sharedFolderAdd: { path: addFolder.path, access: addFolder.access === "read-only" ? "read-only" : "isolated-copy" } }
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

  rpcCtx.rpc.method("bot.liveView.snapshot", async () => {
    const snap = await store.snapshot();
    return store.liveView.getSnapshot(snap.virtualServer).catch(rethrowRpcError);
  });

  rpcCtx.rpc.method("bot.liveView.navigate", async (raw) => {
    const p = asObject(raw);
    const snap = await store.snapshot();
    return store.liveView.navigate(reqString(p, "url"), snap.virtualServer).catch(rethrowRpcError);
  });

  rpcCtx.rpc.method("bot.liveView.click", async (raw) => {
    const p = asObject(raw);
    const snap = await store.snapshot();
    return store.liveView.click(Number(p.x ?? 0), Number(p.y ?? 0), snap.virtualServer).catch(rethrowRpcError);
  });

  rpcCtx.rpc.method("bot.liveView.scroll", async (raw) => {
    const p = asObject(raw);
    const snap = await store.snapshot();
    return store.liveView.scroll(Number(p.deltaX ?? 0), Number(p.deltaY ?? 0), snap.virtualServer).catch(rethrowRpcError);
  });

  rpcCtx.rpc.method("bot.liveView.type", async (raw) => {
    const p = asObject(raw);
    const snap = await store.snapshot();
    return store.liveView
      .typeOrPress(
        {
          ...(typeof p.text === "string" ? { text: p.text } : {}),
          ...(typeof p.key === "string" ? { key: p.key } : {}),
        },
        snap.virtualServer,
      )
      .catch(rethrowRpcError);
  });

  rpcCtx.rpc.method("bot.liveView.execDiag", async (raw) => {
    const p = asObject(raw);
    const snap = await store.snapshot();
    return store.liveView.execDiag(reqString(p, "command"), snap.virtualServer).catch(rethrowRpcError);
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
}
