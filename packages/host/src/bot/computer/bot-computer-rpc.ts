/**
 * JSON-RPC 2.0 `bot.computer.*` endpoints (`packages/host/src/bot/computer/bot-computer-rpc.ts`).
 *
 * Implements every method in `BotComputerRpcMethodMap` (`@qianji/protocol`) and wires
 * live `bot/computer` and `bot/desktopNotification` broadcasts onto `store.computer`.
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  BOT_COMPUTER_ENGINES,
  BOT_COMPUTER_VIEW_TABS,
  ErrorCode,
  type BotComputerEngineActionKind,
  type BotComputerEngineId,
  type BotComputerInputKind,
  type BotComputerKeyModifier,
  type BotComputerMouseAction,
  type BotComputerMouseButton,
  type BotComputerStreamTab,
  type BotComputerViewTab,
  type BotRemoteAuthMethod,
  type BotRemoteNodeKind,
} from "@qianji/protocol";
import { RpcError } from "@qianji/rpc";
import type { BotStateStore } from "../store.ts";
import { SentinelFenceError } from "./sentinel-fence.ts";

type Params = Record<string, unknown>;

const VALID_ENGINES = new Set<BotComputerEngineId>(BOT_COMPUTER_ENGINES);
const VALID_TABS = new Set<BotComputerViewTab>(BOT_COMPUTER_VIEW_TABS);
const VALID_ACTIONS = new Set<BotComputerEngineActionKind>([
  "start",
  "stop",
  "restart",
  "provision-linux-gui",
  "enable-win-child-session",
  "open-native-desktop",
  "launch-app",
  "close-window",
  "connect-remote",
  "disconnect-remote",
  "sync-autonomy-lease",
]);
const VALID_INPUT_KINDS = new Set<BotComputerInputKind>(["mouse", "wheel", "key", "text", "paste"]);

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

function optEngine(raw: unknown): BotComputerEngineId | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !VALID_ENGINES.has(raw as BotComputerEngineId)) {
    throw new RpcError(ErrorCode.InvalidParams, `Invalid computer engine: ${String(raw)}`);
  }
  return raw as BotComputerEngineId;
}

function optTab(raw: unknown): BotComputerViewTab | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !VALID_TABS.has(raw as BotComputerViewTab)) {
    throw new RpcError(ErrorCode.InvalidParams, `Invalid computer view tab: ${String(raw)}`);
  }
  return raw as BotComputerViewTab;
}

function rethrowComputerError(err: unknown): never {
  if (err instanceof RpcError) throw err;
  if (err instanceof SentinelFenceError) {
    throw new RpcError(ErrorCode.InvalidParams, err.message);
  }
  throw new RpcError(ErrorCode.InternalError, err instanceof Error ? err.message : String(err));
}

export function registerBotComputerRpc(
  rpcCtx: Context,
  store: BotStateStore,
  notifyUpdated: (reason: string) => void,
): void {
  store.computer.attachBroadcaster((channel, payload) => {
    rpcCtx.rpc.broadcast(channel, payload);
  });
  rpcCtx.effect(() => () => {
    store.computer.attachBroadcaster(undefined);
  });

  rpcCtx.rpc.method("bot.computer.getSnapshot", async (raw) => {
    const p = asObject(raw);
    return store.computer
      .getSnapshot({
        engine: optEngine(p.engine),
        includeFrame: p.includeFrame === true,
      })
      .catch(rethrowComputerError);
  });

  rpcCtx.rpc.method("bot.computer.select", async (raw) => {
    const p = asObject(raw);
    const res = await store.computer
      .select({
        engine: optEngine(p.engine),
        tab: optTab(p.tab),
        ...(typeof p.autoFollow === "boolean" ? { autoFollow: p.autoFollow } : {}),
        ...(typeof p.activeRemoteNodeId === "string" ? { activeRemoteNodeId: p.activeRemoteNodeId } : {}),
      })
      .catch(rethrowComputerError);
    notifyUpdated("computer-selected");
    return res;
  });

  rpcCtx.rpc.method("bot.computer.action", async (raw) => {
    const p = asObject(raw);
    const engine = optEngine(p.engine);
    if (!engine) throw new RpcError(ErrorCode.InvalidParams, "engine is required");
    const actionRaw = reqString(p, "action") as BotComputerEngineActionKind;
    if (!VALID_ACTIONS.has(actionRaw)) {
      throw new RpcError(ErrorCode.InvalidParams, `Unknown computer action: ${actionRaw}`);
    }
    const res = await store.computer
      .performAction({
        engine,
        action: actionRaw,
        ...(typeof p.forceOpen === "boolean" ? { forceOpen: p.forceOpen } : {}),
        ...(typeof p.appOrUrl === "string" ? { appOrUrl: p.appOrUrl } : {}),
        ...(p.launchKind === "browser" || p.launchKind === "app" ? { launchKind: p.launchKind } : {}),
        ...(typeof p.hwnd === "string" ? { hwnd: p.hwnd } : {}),
        ...(typeof p.remoteNodeId === "string" ? { remoteNodeId: p.remoteNodeId } : {}),
      })
      .catch(rethrowComputerError);
    notifyUpdated("computer-action");
    return res;
  });

  rpcCtx.rpc.method("bot.computer.remoteNode.upsert", async (raw) => {
    const p = asObject(raw);
    const kind: BotRemoteNodeKind = p.kind === "companion-pc" ? "companion-pc" : "ssh-vm";
    const authMethod: BotRemoteAuthMethod | undefined =
      p.authMethod === "agent-or-key" || p.authMethod === "password" ? p.authMethod : undefined;
    const res = await store.computer
      .upsertRemoteNode({
        ...(typeof p.id === "string" && p.id.trim() !== "" ? { id: p.id.trim() } : {}),
        alias: typeof p.alias === "string" ? p.alias : "",
        kind,
        host: reqString(p, "host"),
        ...(typeof p.port === "number" ? { port: p.port } : {}),
        ...(typeof p.username === "string" ? { username: p.username } : {}),
        ...(typeof p.workDir === "string" ? { workDir: p.workDir } : {}),
        ...(authMethod ? { authMethod } : {}),
        ...(typeof p.privateKeyPath === "string" ? { privateKeyPath: p.privateKeyPath } : {}),
        ...(typeof p.password === "string" ? { password: p.password } : {}),
      })
      .catch(rethrowComputerError);
    notifyUpdated("computer-remote-node-upserted");
    return res;
  });

  rpcCtx.rpc.method("bot.computer.remoteNode.delete", async (raw) => {
    const p = asObject(raw);
    const res = await store.computer.deleteRemoteNode(reqString(p, "id")).catch(rethrowComputerError);
    notifyUpdated("computer-remote-node-deleted");
    return res;
  });

  rpcCtx.rpc.method("bot.computer.stream", async (raw) => {
    const p = asObject(raw);
    if (typeof p.active !== "boolean") {
      throw new RpcError(ErrorCode.InvalidParams, "active must be a boolean");
    }
    const streamTab: BotComputerStreamTab | undefined =
      p.tab === "desktop" || p.tab === "browser" ? p.tab : undefined;
    return store.computer
      .controlStream({
        active: p.active,
        engine: optEngine(p.engine),
        ...(streamTab ? { tab: streamTab } : {}),
        ...(typeof p.fps === "number" ? { fps: p.fps } : {}),
      })
      .catch(rethrowComputerError);
  });

  rpcCtx.rpc.method("bot.computer.input", async (raw) => {
    const p = asObject(raw);
    const kind = p.kind as BotComputerInputKind;
    if (!VALID_INPUT_KINDS.has(kind)) {
      throw new RpcError(ErrorCode.InvalidParams, `Invalid input kind: ${String(p.kind)}`);
    }
    const modifiers = Array.isArray(p.modifiers)
      ? p.modifiers.filter(
          (m): m is BotComputerKeyModifier =>
            m === "ctrl" || m === "shift" || m === "alt" || m === "meta",
        )
      : undefined;
    return store.computer
      .dispatchInput({
        engine: optEngine(p.engine),
        tab: optTab(p.tab),
        kind,
        ...(typeof p.mouseAction === "string" ? { mouseAction: p.mouseAction as BotComputerMouseAction } : {}),
        ...(typeof p.button === "string" ? { button: p.button as BotComputerMouseButton } : {}),
        ...(typeof p.x === "number" ? { x: p.x } : {}),
        ...(typeof p.y === "number" ? { y: p.y } : {}),
        ...(typeof p.endX === "number" ? { endX: p.endX } : {}),
        ...(typeof p.endY === "number" ? { endY: p.endY } : {}),
        ...(typeof p.deltaX === "number" ? { deltaX: p.deltaX } : {}),
        ...(typeof p.deltaY === "number" ? { deltaY: p.deltaY } : {}),
        ...(typeof p.viewportWidth === "number" ? { viewportWidth: p.viewportWidth } : {}),
        ...(typeof p.viewportHeight === "number" ? { viewportHeight: p.viewportHeight } : {}),
        ...(typeof p.key === "string" ? { key: p.key } : {}),
        ...(typeof p.text === "string" ? { text: p.text } : {}),
        ...(modifiers ? { modifiers } : {}),
      })
      .catch(rethrowComputerError);
  });

  rpcCtx.rpc.method("bot.computer.navigate", async (raw) => {
    const p = asObject(raw);
    return store.computer
      .navigate({ url: reqString(p, "url"), engine: optEngine(p.engine) })
      .catch(rethrowComputerError);
  });

  rpcCtx.rpc.method("bot.computer.takeover", async (raw) => {
    const p = asObject(raw);
    const action = p.action;
    if (action !== "request" && action !== "start" && action !== "release") {
      throw new RpcError(ErrorCode.InvalidParams, 'action must be "request", "start", or "release"');
    }
    const res = await store.computer
      .takeover({
        action,
        engine: optEngine(p.engine),
        tab: optTab(p.tab),
        ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
        ...(typeof p.targetUrlOrApp === "string" ? { targetUrlOrApp: p.targetUrlOrApp } : {}),
        ...(typeof p.sessionId === "string" ? { sessionId: p.sessionId } : {}),
      })
      .catch(rethrowComputerError);
    notifyUpdated("computer-takeover");
    return res;
  });

  rpcCtx.rpc.method("bot.computer.pty.open", async (raw) => {
    const p = asObject(raw);
    return store.computer
      .ptyOpen({
        engine: optEngine(p.engine),
        ...(typeof p.cwd === "string" ? { cwd: p.cwd } : {}),
        ...(typeof p.cols === "number" ? { cols: p.cols } : {}),
        ...(typeof p.rows === "number" ? { rows: p.rows } : {}),
      })
      .catch(rethrowComputerError);
  });

  rpcCtx.rpc.method("bot.computer.pty.write", async (raw) => {
    const p = asObject(raw);
    if (typeof p.data !== "string") {
      throw new RpcError(ErrorCode.InvalidParams, "data must be a string");
    }
    return store.computer
      .ptyWrite({
        ...(typeof p.sessionId === "string" ? { sessionId: p.sessionId } : {}),
        engine: optEngine(p.engine),
        data: p.data,
      })
      .catch(rethrowComputerError);
  });

  rpcCtx.rpc.method("bot.computer.pty.resize", (raw) => {
    const p = asObject(raw);
    if (typeof p.cols !== "number" || typeof p.rows !== "number") {
      throw new RpcError(ErrorCode.InvalidParams, "cols and rows must be numbers");
    }
    return store.computer.ptyResize({
      ...(typeof p.sessionId === "string" ? { sessionId: p.sessionId } : {}),
      engine: optEngine(p.engine),
      cols: p.cols,
      rows: p.rows,
    });
  });

  rpcCtx.rpc.method("bot.computer.pty.close", async (raw) => {
    const p = asObject(raw);
    return store.computer
      .ptyClose({
        ...(typeof p.sessionId === "string" ? { sessionId: p.sessionId } : {}),
        engine: optEngine(p.engine),
      })
      .catch(rethrowComputerError);
  });

  rpcCtx.rpc.method("bot.computer.files.list", async (raw) => {
    const p = asObject(raw);
    return store.computer
      .filesList({
        engine: optEngine(p.engine),
        ...(typeof p.path === "string" ? { path: p.path } : {}),
      })
      .catch(rethrowComputerError);
  });

  rpcCtx.rpc.method("bot.computer.files.read", async (raw) => {
    const p = asObject(raw);
    return store.computer
      .filesRead({
        engine: optEngine(p.engine),
        path: reqString(p, "path"),
        ...(typeof p.maxBytes === "number" ? { maxBytes: p.maxBytes } : {}),
      })
      .catch(rethrowComputerError);
  });
}
