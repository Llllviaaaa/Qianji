import { useCallback, useEffect, useMemo, useState } from "react";
import { Boxes, Layers, RefreshCw, ArrowLeft } from "lucide-react";
import type { PluginInfo, PluginListResult, PluginTier } from "@qianji/protocol";
import {
  useFrontendService,
  useWorkspaceState,
} from "@qianji/client";
import { Badge, Button, Card, Input, Switch } from "@qianji/client-primitives";
import type { HubPageSlotProps, SlotComponentProps } from "@qianji/client-slots";

type TierFilter = "all" | PluginTier;

const TIER_LABELS: Readonly<Record<PluginTier, string>> = {
  builtin: "内置",
  user: "用户",
  workspace: "工作区",
};

function tierBadgeVariant(tier: PluginTier): "neutral" | "brand" | "warning" {
  if (tier === "workspace") return "warning";
  if (tier === "user") return "brand";
  return "neutral";
}

export function PluginsHubPageView(props: SlotComponentProps<HubPageSlotProps, "root">) {
  const { ctx, renderFactory } = props;
  const navigationService = useFrontendService("navigationService", ctx);
  const workspaceSnap = useWorkspaceState(ctx);
  const cwd = props.cwd ?? workspaceSnap?.cwd ?? "";
  const handleClose = () => {
    if (props.onClose !== undefined) props.onClose();
    else navigationService?.setHubView(null);
  };

  return renderFactory(
    "host.hub.plugins",
    { cwd, onReturnToChat: handleClose },
    { fallback: <PluginsHubPageFallback {...props} /> },
  );
}

function PluginsHubPageFallback(props: SlotComponentProps<HubPageSlotProps, "root">) {
  const { ctx } = props;
  const rpcService = useFrontendService("rpcService", ctx);
  const navigationService = useFrontendService("navigationService", ctx);
  const workspaceSnap = useWorkspaceState(ctx);

  const cwd = props.cwd ?? workspaceSnap?.cwd ?? "";

  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [query, setQuery] = useState("");
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");
  const [reloading, setReloading] = useState(false);

  const fetchPlugins = useCallback(async () => {
    if (rpcService === undefined) return;
    try {
      const params = cwd.trim() !== "" ? { workspace: cwd.trim() } : {};
      const result = await rpcService.call<PluginListResult>("plugin.list", params);
      setPlugins(Array.isArray(result?.plugins) ? result.plugins : []);
    } catch {
      // Keep current list when Host is offline.
    }
  }, [cwd, rpcService]);

  useEffect(() => {
    if (rpcService === undefined) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const params = cwd.trim() !== "" ? { workspace: cwd.trim() } : {};
        const result = await rpcService.call<PluginListResult>("plugin.list", params);
        if (!cancelled) {
          setPlugins(Array.isArray(result?.plugins) ? result.plugins : []);
        }
      } catch {
        // Ignore offline errors on initial mount.
      }
    })();

    const offChanged = rpcService.onNotification("plugin/changed", () => {
      void fetchPlugins();
    });
    return () => {
      cancelled = true;
      offChanged();
    };
  }, [cwd, fetchPlugins, rpcService]);

  const filteredPlugins = useMemo(() => {
    const q = query.trim().toLowerCase();
    return plugins.filter((plugin) => {
      if (tierFilter !== "all" && plugin.tier !== tierFilter) return false;
      if (q === "") return true;
      const haystack = `${plugin.id} ${plugin.name ?? ""} ${plugin.description ?? ""}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [plugins, query, tierFilter]);

  const handleToggle = async (plugin: PluginInfo, nextEnabled: boolean) => {
    if (rpcService === undefined) return;
    const method = nextEnabled ? "plugin.enable" : "plugin.disable";
    try {
      await rpcService.call(method, {
        id: plugin.id,
        ...(cwd.trim() !== "" ? { workspace: cwd.trim() } : {}),
      });
      await fetchPlugins();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      navigationService?.showToast(`操作插件失败：${msg}`, "error");
    }
  };

  const handleReloadAll = async () => {
    if (rpcService === undefined) return;
    setReloading(true);
    try {
      await rpcService.call("plugin.reload", cwd.trim() !== "" ? { workspace: cwd.trim() } : {});
      await fetchPlugins();
      navigationService?.showToast("已重新加载插件", "info");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      navigationService?.showToast(`重载插件失败：${msg}`, "error");
    } finally {
      setReloading(false);
    }
  };

  return (
    <section className="plugins-hub-page" data-hub-page="plugins" data-core-plugin="core-hubs">
      <div className="plugins-hub-inner">
        <header className="plugins-hub-header">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <div>
              <h1>
                <Boxes size={18} style={{ display: "inline", marginRight: 8, verticalAlign: "text-bottom" }} />
                扩展插件
              </h1>
              <p>统一管理扩展插件、核心能力、Agent 技能 (Skills) 与 MCP 工具服务</p>
            </div>
            <div style={{ display: "inline-flex", gap: 8 }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => navigationService?.openSettings("slots")}
              >
                <Layers size={14} />
                槽位接管
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={reloading}
                onClick={() => void handleReloadAll()}
              >
                <RefreshCw size={14} />
                {reloading ? "重载中…" : "重载"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (props.onClose !== undefined) props.onClose();
                  else navigationService?.setHubView(null);
                }}
              >
                <ArrowLeft size={14} />
                返回对话
              </Button>
            </div>
          </div>
        </header>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14, alignItems: "center" }}>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索插件名称、ID 或描述…"
            aria-label="搜索插件"
            style={{ maxWidth: 280 }}
          />
          {([["all", "全部"], ["builtin", "内置"], ["user", "用户"], ["workspace", "工作区"]] as const).map(
            ([value, label]) => (
              <Button
                key={value}
                variant={tierFilter === value ? "primary" : "secondary"}
                size="sm"
                onClick={() => setTierFilter(value)}
              >
                {label}
              </Button>
            ),
          )}
        </div>

        <div style={{ display: "grid", gap: 10 }}>
          {filteredPlugins.length === 0 ? (
            <div className="plugins-hub-empty">暂无匹配的插件</div>
          ) : (
            filteredPlugins.map((plugin) => (
              <Card key={plugin.id} padding="md">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <strong>{plugin.name || plugin.id}</strong>
                      <Badge variant={tierBadgeVariant(plugin.tier)}>{TIER_LABELS[plugin.tier]}</Badge>
                      {plugin.hasClient && <Badge variant="brand">UI</Badge>}
                      {(plugin.error || plugin.clientError) && <Badge variant="danger">异常</Badge>}
                    </div>
                    {plugin.description && (
                      <div style={{ fontSize: 12, opacity: 0.78, marginTop: 4 }}>{plugin.description}</div>
                    )}
                    {(plugin.error || plugin.clientError) && (
                      <div style={{ fontSize: 12, color: "var(--qj-status-danger, #dc2626)", marginTop: 4 }}>
                        {plugin.error || plugin.clientError?.message}
                      </div>
                    )}
                  </div>
                  <Switch
                    checked={plugin.enabled !== false && plugin.status !== "disabled"}
                    disabled={plugin.canDisable === false}
                    aria-label={`启用插件 ${plugin.id}`}
                    onCheckedChange={(checked) => void handleToggle(plugin, checked)}
                  />
                </div>
              </Card>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
