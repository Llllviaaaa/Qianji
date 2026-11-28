/**
 * JSON-RPC 2.0 `bot.sideChat.*` & `bot.activity.getTrace` endpoints
 * (`packages/host/src/bot/bot-threads-rpc.ts`).
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  ErrorCode,
  type BotActivityGetTraceResult,
  type BotSideChatUpdateResult,
} from "@qianji/protocol";
import { RpcError } from "@qianji/rpc";
import type { BotStateStore } from "./store.ts";

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

export function registerBotThreadsRpc(
  rpcCtx: Context,
  store: BotStateStore,
  notifyUpdated: (reason: string) => void,
): void {
  rpcCtx.rpc.method("bot.sideChat.create", async (raw) => {
    const p = asObject(raw);
    const thread = await store.createSideChat(typeof p.title === "string" ? p.title : undefined);
    notifyUpdated("side-chat-created");
    return { thread };
  });

  rpcCtx.rpc.method("bot.sideChat.update", async (raw): Promise<BotSideChatUpdateResult> => {
    const p = asObject(raw);
    const id = reqString(p, "id");
    const thread = await store.updateSideChat({
      id,
      ...(typeof p.title === "string" ? { title: p.title } : {}),
      ...(typeof p.pinned === "boolean" ? { pinned: p.pinned } : {}),
      ...(typeof p.archived === "boolean" ? { archived: p.archived } : {}),
    });
    if (thread !== null) {
      notifyUpdated("side-chat-updated");
    }
    return { thread };
  });

  rpcCtx.rpc.method("bot.sideChat.delete", async (raw) => {
    const p = asObject(raw);
    await store.deleteSideChat(reqString(p, "id"));
    notifyUpdated("side-chat-deleted");
    return { ok: true };
  });

  rpcCtx.rpc.method("bot.activity.getTrace", async (raw): Promise<BotActivityGetTraceResult> => {
    const p = asObject(raw);
    return store.getActivityTrace({
      ...(typeof p.activityId === "string" && p.activityId.trim() !== "" ? { activityId: p.activityId.trim() } : {}),
      ...(typeof p.sessionId === "string" && p.sessionId.trim() !== "" ? { sessionId: p.sessionId.trim() } : {}),
    });
  });
}
