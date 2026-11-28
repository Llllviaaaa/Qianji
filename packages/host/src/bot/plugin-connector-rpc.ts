/**
 * Host RPC & policy helpers bridging `PluginManager` + `HostConnectorsService`
 * (`ctx.connectors` / `qianji.connectors`) with Bot Mode's Connectors directory,
 * 4-tier policies, per-tool approvals, and Heartbeat patrol.
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  ErrorCode,
  type BotMcpDiscoveredTool,
  type BotPluginConnectorCatalogItem,
  type PluginConnectorManifest,
} from "@qianji/protocol";
import { RpcError } from "@qianji/rpc";
import type { ToolDefinition } from "@qianji/tools";
import type { HostConnectorsService } from "../plugin-connectors.ts";
import type { PluginManager } from "../plugin-manager.ts";
import type { BotStateStore } from "./store.ts";

function asObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

function reqString(p: Record<string, unknown>, key: string): string {
  const val = p[key];
  if (typeof val !== "string" || val.trim() === "") {
    throw new RpcError(ErrorCode.InvalidParams, `${key} must be a non-empty string`);
  }
  return val.trim();
}

function hasMissingRequiredConfig(
  configSchema: Record<string, unknown> | undefined,
  config: Record<string, unknown> | undefined,
): boolean {
  if (!configSchema) return false;
  const req = Array.isArray(configSchema.required) ? configSchema.required : [];
  for (const key of req) {
    if (typeof key !== "string") continue;
    const val = config?.[key];
    if (val === undefined || val === null || (typeof val === "string" && val.trim() === "")) {
      return true;
    }
  }
  return false;
}

export function listConnectorsForPlugin(
  pluginId: string,
  pluginName: string,
  manifestConnectors: readonly PluginConnectorManifest[] | undefined,
  connectorsSvc: HostConnectorsService | undefined,
): PluginConnectorManifest[] {
  const byId = new Map<string, PluginConnectorManifest>();
  for (const m of manifestConnectors ?? []) {
    byId.set(m.id, m);
  }
  for (const reg of connectorsSvc?.listByPlugin(pluginId) ?? []) {
    const existing = byId.get(reg.id);
    const runtimeManifest = connectorsSvc?.toManifest(reg, pluginName);
    if (runtimeManifest) {
      byId.set(reg.id, existing ? { ...runtimeManifest, ...existing } : runtimeManifest);
    }
  }
  return [...byId.values()];
}

export function resolvePluginConnectorIdForTool(
  def: ToolDefinition,
  manager: PluginManager | undefined,
  connectorsSvc: HostConnectorsService | undefined,
): string | undefined {
  if (def.connectorId) return def.connectorId;
  if (!def.pluginId) return undefined;
  const candidate = manager?.getCandidate(def.pluginId);
  const connectors = listConnectorsForPlugin(
    def.pluginId,
    candidate?.name ?? def.pluginId,
    candidate?.connectors,
    connectorsSvc,
  );
  return connectors[0]?.id;
}

export function registerBotPluginConnectorRpc(
  rpcCtx: Context,
  store: BotStateStore,
  getManager: () => PluginManager | undefined,
  notifyUpdated: (reason: string) => void,
): void {
  const getConnectorsSvc = (): HostConnectorsService | undefined =>
    rpcCtx.get("connectors") as HostConnectorsService | undefined;

  const listPluginTools = (pluginId: string, connectorId: string): BotMcpDiscoveredTool[] => {
    const all = rpcCtx.get("tools")?.listDefinitions() ?? [];
    return all
      .filter((t) => t.pluginId === pluginId && (!t.connectorId || t.connectorId === connectorId))
      .map((t) => ({
        name: t.name,
        rawName: t.name,
        description: t.description,
        readOnly: t.readOnly === true,
      }));
  };

  rpcCtx.rpc.method("bot.connector.pluginCatalog", async () => {
    const manager = getManager();
    const connectorsSvc = getConnectorsSvc();
    const plugins = manager ? await manager.list() : [];
    const items: BotPluginConnectorCatalogItem[] = [];
    const seenIds = new Set<string>();

    for (const plugin of plugins) {
      const merged = listConnectorsForPlugin(plugin.id, plugin.name, plugin.connectors, connectorsSvc);
      for (const conn of merged) {
        if (seenIds.has(conn.id)) continue;
        seenIds.add(conn.id);
        const reg = connectorsSvc?.get(conn.id);
        let runtimeStatus: { connected: boolean; accountLabel?: string; error?: string } | undefined;
        if (reg?.status && plugin.enabled && plugin.scopes?.bot !== false) {
          try {
            runtimeStatus = await reg.status();
          } catch (err) {
            runtimeStatus = { connected: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
        items.push({
          pluginId: plugin.id,
          pluginName: plugin.name,
          pluginEnabled: plugin.enabled,
          pluginBotEnabled: plugin.scopes?.bot === true,
          ...(plugin.configSchema ? { configSchema: plugin.configSchema } : {}),
          ...(plugin.config ? { config: plugin.config } : {}),
          connector: conn,
          tools: listPluginTools(plugin.id, conn.id),
          ...(runtimeStatus !== undefined ? { runtimeConnected: runtimeStatus.connected } : {}),
          ...(runtimeStatus?.accountLabel ? { runtimeAccountLabel: runtimeStatus.accountLabel } : {}),
          ...(runtimeStatus?.error ? { runtimeError: runtimeStatus.error } : {}),
        });
      }
    }

    // Also include runtime-registered connectors in standalone hosts without PluginManager.
    if (!manager && connectorsSvc) {
      for (const reg of connectorsSvc.list()) {
        if (seenIds.has(reg.id)) continue;
        const conn = connectorsSvc.toManifest(reg, reg.pluginId);
        items.push({
          pluginId: reg.pluginId,
          pluginName: reg.pluginId,
          pluginEnabled: true,
          pluginBotEnabled: true,
          connector: conn,
          tools: listPluginTools(reg.pluginId, conn.id),
        });
      }
    }

    return { items };
  });

  rpcCtx.rpc.method("bot.connector.pluginConnect", async (raw) => {
    const p = asObject(raw);
    const pluginId = reqString(p, "pluginId");
    const connectorId = reqString(p, "connectorId");
    const forceInteractive = p.forceInteractive === true;

    const manager = getManager();
    if (manager) {
      const cand = manager.getCandidate(pluginId);
      if (!cand) throw new RpcError(ErrorCode.InvalidParams, `未找到插件：${pluginId}`);
      if (!cand.targets.includes("bot")) {
        throw new RpcError(ErrorCode.InvalidParams, `插件「${cand.name}」仅支持 Agent 工作台，不支持分身形态`);
      }
      if (!cand.enabled || !cand.scopes.bot) {
        await manager.setScope(pluginId, "bot", true);
      }
      const updated = manager.getCandidate(pluginId);
      if (hasMissingRequiredConfig(updated?.configSchema, updated?.publicConfig)) {
        return { status: "needs_config", message: "请先完成连接所需的插件配置项" };
      }
    }

    const connectorsSvc = getConnectorsSvc();
    const reg = connectorsSvc?.get(connectorId);
    const currentCfg = (manager?.getCandidate(pluginId)?.publicConfig ?? {}) as Record<string, unknown>;
    let accountLabel = `${manager?.getCandidate(pluginId)?.name ?? pluginId}（插件已连接）`;

    if (reg?.connect) {
      const res = await reg.connect({ config: currentCfg, forceInteractive }).catch((err: unknown) => {
        throw new RpcError(ErrorCode.InternalError, err instanceof Error ? err.message : String(err));
      });
      if (res.requireConfigModal) {
        return { status: "needs_config", message: res.message };
      }
      if (res.connected === false) {
        throw new RpcError(ErrorCode.InternalError, res.message || "插件连接未完成");
      }
      if (res.accountLabel) accountLabel = res.accountLabel;
    } else if (reg?.status) {
      const st = await Promise.resolve(reg.status()).catch(() => null);
      if (st?.accountLabel) accountLabel = st.accountLabel;
    }

    const tools = listPluginTools(pluginId, connectorId);
    const hasWrite = tools.some((t) => !t.readOnly);
    const snapshot = await store.configureProactive({
      appPolicies: {
        [connectorId]: {
          connected: true,
          authKind: "plugin",
          accountLabel,
          connectedAt: Date.now(),
          policy: hasWrite ? "low-risk-auto" : "read-only-auto",
          backgroundSync: true,
        },
      },
    });
    notifyUpdated("plugin-connector-connected");
    return { status: "connected", accountLabel, snapshot };
  });

  rpcCtx.rpc.method("bot.connector.pluginDisconnect", async (raw) => {
    const p = asObject(raw);
    const connectorId = reqString(p, "connectorId");
    const reg = getConnectorsSvc()?.get(connectorId);
    if (reg?.disconnect) {
      await Promise.resolve(reg.disconnect()).catch(() => undefined);
    }
    const snapshot = await store.configureProactive({
      appPolicies: { [connectorId]: null },
    });
    notifyUpdated("plugin-connector-disconnected");
    return { ok: true, snapshot };
  });
}
