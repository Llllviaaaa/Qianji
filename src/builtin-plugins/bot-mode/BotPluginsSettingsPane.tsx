/**
 * Bot Mode `设置 → 插件` management pane + reusable `BotPluginConfigModal`
 * (`src/builtin-plugins/bot-mode/BotPluginsSettingsPane.tsx`).
 *
 * Implements 2-layer Agent ⇄ Bot scope controls (`qianji.targets` ceiling +
 * independent user `Agent` / `Bot` toggles) and jumps to plugin-contributed Connectors.
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { ArrowUpRight, Blocks, RefreshCw, Settings2, X } from "lucide-react";
import { useFrontendService } from "@qianji/client";
import { Switch } from "@qianji/client-primitives";
import type { PluginInfo, PluginListResult, PluginTargetMode } from "@qianji/protocol";
import { openBotConnector, openHostSettingsFromBot } from "./botStore";

type FilterTab = "bot-capable" | "bot-active" | "connectors" | "agent-only";

interface SchemaPropSpec {
  key: string;
  title: string;
  description?: string;
  type: string;
  enumValues?: string[];
  defaultValue?: unknown;
}

function extractSchemaProps(schema?: Record<string, unknown>): SchemaPropSpec[] {
  if (!schema || typeof schema.properties !== "object" || schema.properties === null) return [];
  const props = schema.properties as Record<string, Record<string, unknown>>;
  return Object.entries(props).map(([key, spec]) => ({
    key,
    title: typeof spec?.title === "string" && spec.title.trim() ? spec.title : key,
    description: typeof spec?.description === "string" ? spec.description : undefined,
    type: typeof spec?.type === "string" ? spec.type : "string",
    enumValues: Array.isArray(spec?.enum)
      ? spec.enum.filter((v): v is string => typeof v === "string")
      : undefined,
    defaultValue: spec?.default,
  }));
}

export function BotPluginConfigModal({
  pluginId,
  pluginName,
  configSchema,
  initialConfig,
  ctx,
  hintMessage,
  onSaved,
  onClose,
}: {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly configSchema?: Record<string, unknown>;
  readonly initialConfig?: Record<string, unknown>;
  readonly ctx?: Context;
  readonly hintMessage?: string;
  readonly onSaved?: () => void | Promise<void>;
  readonly onClose: () => void;
}): ReactElement {
  const rpcService = useFrontendService("rpcService", ctx);
  const navigationService = useFrontendService("navigationService", ctx);
  const fields = extractSchemaProps(configSchema);

  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const base: Record<string, unknown> = { ...(initialConfig ?? {}) };
    for (const f of fields) {
      if (base[f.key] === undefined && f.defaultValue !== undefined) {
        base[f.key] = f.defaultValue;
      }
    }
    return base;
  });
  const [rawJson, setRawJson] = useState(() => JSON.stringify(initialConfig ?? {}, null, 2));
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!rpcService) return;
    setBusy(true);
    try {
      let nextCfg: Record<string, unknown>;
      if (fields.length > 0) {
        nextCfg = { ...(initialConfig ?? {}), ...values };
      } else {
        const parsed = JSON.parse(rawJson || "{}") as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("配置必须是 JSON 对象");
        }
        nextCfg = parsed as Record<string, unknown>;
      }
      await rpcService.call("plugin.configure", { id: pluginId, config: nextCfg });
      await onSaved?.();
      navigationService?.showToast(`已保存「${pluginName}」配置`, "info");
      onClose();
    } catch (err) {
      navigationService?.showToast(err instanceof Error ? err.message : "保存插件配置失败", "warning");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div className="qj-bot-modal-backdrop" data-escape-layer="" onClick={onClose} style={{ zIndex: 1120 }}>
      <div className="qj-bot-dialog qj-conn-modal" onClick={(e) => e.stopPropagation()} data-testid="bot-plugin-config-modal">
        <div className="qj-conn-modal-head">
          <h4>配置插件 · {pluginName}</h4>
          <button type="button" className="qj-muse-modal-close" aria-label="关闭" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <form onSubmit={(e) => void handleSubmit(e)} className="qj-conn-modal-body">
          {hintMessage && <p className="qj-conn-hint">{hintMessage}</p>}
          {fields.length > 0 ? (
            fields.map((f) => (
              <div key={f.key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label style={{ fontSize: 12.5, fontWeight: 540 }}>{f.title}</label>
                {f.description && <div className="qj-conn-hint">{f.description}</div>}
                {f.type === "boolean" ? (
                  <Switch
                    checked={Boolean(values[f.key])}
                    aria-label={f.title}
                    onCheckedChange={(checked) => setValues((p) => ({ ...p, [f.key]: checked }))}
                  />
                ) : f.enumValues && f.enumValues.length > 0 ? (
                  <select
                    aria-label={f.title}
                    value={String(values[f.key] ?? f.enumValues[0] ?? "")}
                    onChange={(e) => setValues((p) => ({ ...p, [f.key]: e.target.value }))}
                    className="qj-conn-input"
                  >
                    {f.enumValues.map((opt) => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={f.type === "number" || f.type === "integer" ? "number" : /secret|token|key|password/i.test(f.key) ? "password" : "text"}
                    aria-label={f.title}
                    value={String(values[f.key] ?? "")}
                    onChange={(e) =>
                      setValues((p) => ({
                        ...p,
                        [f.key]:
                          f.type === "number" || f.type === "integer"
                            ? Number(e.target.value)
                            : e.target.value,
                      }))
                    }
                    className="qj-conn-input"
                  />
                )}
              </div>
            ))
          ) : (
            <textarea
              aria-label="插件配置 JSON"
              rows={5}
              value={rawJson}
              onChange={(e) => setRawJson(e.target.value)}
              className="qj-conn-input mono"
            />
          )}
          <div className="qj-conn-modal-foot">
            <button type="button" className="qj-soft-btn qj-conn-pill-btn" onClick={onClose}>取消</button>
            <button type="submit" disabled={busy} className="qj-primary-pill-btn qj-conn-pill-btn">
              {busy ? "正在保存…" : "保存并生效"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const CORE_INFRA_IDS = new Set([
  "web-server", "rpc-gateway", "secret-store", "providers", "llm-openai-compat",
  "llm-openai-responses", "llm-anthropic", "llm-gemini", "pricing", "session-jsonl",
  "session-search-fts", "tool-fs", "tool-bash", "tool-output", "tool-guards", "sandbox",
  "sessions-rpc", "commands-rpc", "ui-rpc", "diagnostics", "llm-rpc", "provider-admin",
  "config-rpc", "bot-mode",
]);

export function BotPluginsSettingsPane({ ctx }: { readonly ctx?: Context }): ReactElement {
  const rpcService = useFrontendService("rpcService", ctx);
  const navigationService = useFrontendService("navigationService", ctx);
  const [plugins, setPlugins] = useState<readonly PluginInfo[]>([]);
  const [tab, setTab] = useState<FilterTab>("bot-capable");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingPlugin, setEditingPlugin] = useState<PluginInfo | null>(null);

  const load = useCallback(async () => {
    if (!rpcService) return;
    const res = await rpcService.call<PluginListResult>("plugin.list", {}).catch(() => null);
    if (Array.isArray(res?.plugins)) setPlugins(res.plugins);
  }, [rpcService]);

  useEffect(() => {
    if (!rpcService) return undefined;
    let cancelled = false;
    rpcService
      .call<PluginListResult>("plugin.list", {})
      .then((res) => {
        if (!cancelled && Array.isArray(res?.plugins)) setPlugins(res.plugins);
      })
      .catch(() => undefined);
    const off = rpcService.onNotification("plugin/changed", () => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [load, rpcService]);

  const toggleScope = async (p: PluginInfo, mode: PluginTargetMode, next: boolean) => {
    if (!rpcService) return;
    setBusyId(p.id);
    try {
      await rpcService.call("plugin.setScope", { id: p.id, mode, enabled: next });
      await load();
      navigationService?.showToast(
        `已${next ? "启用" : "停用"}「${p.name}」的 ${mode === "bot" ? "Bot 分身" : "Agent 工作台"} 权限`,
        "info",
      );
    } catch (err) {
      navigationService?.showToast(err instanceof Error ? err.message : "更新插件作用域失败", "warning");
    } finally {
      setBusyId(null);
    }
  };

  const userFacing = plugins.filter((p) => !CORE_INFRA_IDS.has(p.id));
  const filtered = userFacing.filter((p) => {
    const targets = p.targets ?? ["agent", "bot"];
    const supportsBot = targets.includes("bot");
    if (tab === "agent-only") return !supportsBot;
    if (!supportsBot) return false;
    if (tab === "bot-active") return p.enabled && p.scopes?.bot === true;
    if (tab === "connectors") return (p.connectors?.length ?? 0) > 0;
    return true;
  });

  return (
    <div className="qj-conn-dir-wrap" data-testid="bot-plugins-settings-pane">
      <div className="qj-conn-filter-row">
        <div className="qj-connector-cat-pills" role="tablist" aria-label="插件筛选">
          {([
            ["bot-capable", "支持分身"],
            ["bot-active", "已在分身启用"],
            ["connectors", "含连接器插件"],
            ["agent-only", "仅 Agent（已隔离）"],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`qj-connector-cat-pill${tab === id ? " active" : ""}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="qj-bset-text-link"
          onClick={() => openHostSettingsFromBot(navigationService, "plugins")}
        >
          <span>工作台扩展管理</span>
          <ArrowUpRight size={12.5} />
        </button>
      </div>

      <div className="qj-conn-list">
        {filtered.map((p) => {
          const targets = p.targets ?? ["agent", "bot"];
          const supportsAgent = targets.includes("agent");
          const supportsBot = targets.includes("bot");
          const botOn = p.enabled && p.scopes?.bot === true;
          const agentOn = p.enabled && p.scopes?.agent === true;
          const scopeLabel = supportsAgent && supportsBot ? "Agent + Bot 双端兼容" : supportsBot ? "仅 Bot 分身" : "仅 Agent 工作台 · 已隔离";

          return (
            <div key={p.id} className="qj-conn-section-card" style={{ gap: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                <div style={{ display: "flex", gap: 10, minWidth: 0 }}>
                  <span className="qj-conn-icon-tile" style={{ width: 38, height: 38, borderRadius: 11, background: "var(--qj-bg-surface)" }}>
                    <Blocks size={18} />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="qj-conn-row-title-line">
                      <span className="qj-conn-row-name">{p.name}</span>
                      <span className="qj-conn-row-perm">{scopeLabel}</span>
                      {p.tier !== "builtin" && <span className="qj-conn-meta-pill">{p.tier === "workspace" ? "工作区插件" : "外部插件"}</span>}
                    </div>
                    {p.description && <div className="qj-conn-row-sub" style={{ whiteSpace: "normal" }}>{p.description}</div>}
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                  {supportsBot && p.canDisable !== false && (
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                      <span>在分身启用</span>
                      <Switch
                        checked={botOn}
                        disabled={busyId === p.id}
                        aria-label={`在分身启用 ${p.name}`}
                        onCheckedChange={(checked) => void toggleScope(p, "bot", checked)}
                      />
                    </label>
                  )}
                  {supportsAgent && supportsBot && p.canDisable !== false && (
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--qj-text-secondary)" }}>
                      <span>Agent</span>
                      <Switch
                        checked={agentOn}
                        disabled={busyId === p.id}
                        aria-label={`在 Agent 启用 ${p.name}`}
                        onCheckedChange={(checked) => void toggleScope(p, "agent", checked)}
                      />
                    </label>
                  )}
                </div>
              </div>

              {((p.connectors && p.connectors.length > 0) || p.tier !== "builtin" || p.configSchema) && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {(p.connectors ?? []).map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className="qj-soft-btn qj-conn-pill-btn"
                        onClick={() => openBotConnector(c.id, "plugins")}
                      >
                        <span>连接器：{c.name}</span>
                        <ArrowUpRight size={12} />
                      </button>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {(p.configSchema || p.tier !== "builtin") && p.canDisable !== false && (
                      <button type="button" className="qj-soft-btn qj-conn-pill-btn" onClick={() => setEditingPlugin(p)}>
                        <Settings2 size={12} />
                        <span>参数配置</span>
                      </button>
                    )}
                    {p.tier !== "builtin" && (
                      <button
                        type="button"
                        className="qj-soft-btn qj-conn-pill-btn"
                        onClick={() => void rpcService?.call("plugin.reload", { id: p.id }).then(() => load())}
                      >
                        <RefreshCw size={12} />
                        <span>热重载</span>
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {filtered.length === 0 && (
          <div className="qj-soft-empty">当前分类下暂无匹配的插件</div>
        )}
      </div>

      {editingPlugin && (
        <BotPluginConfigModal
          pluginId={editingPlugin.id}
          pluginName={editingPlugin.name}
          configSchema={editingPlugin.configSchema}
          initialConfig={editingPlugin.config}
          ctx={ctx}
          onSaved={load}
          onClose={() => setEditingPlugin(null)}
        />
      )}
    </div>
  );
}
