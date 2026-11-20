/**
 * Plugins settings page and the convenience `settings.sections` shortcut card
 * on `"plugins"` linking directly to `"slots"` via `openSettingsPage("slots")`.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from "react";
import { ArrowRight, Layers, RefreshCw, ShieldAlert } from "lucide-react";
import type { PluginInfo, PluginListResult, PluginMutationResult, PluginToggleParams } from "@qianji/protocol";
import {
  callHostRpc,
  openSettingsPage,
  useClientContext,
  useClientContributions,
  useFrontendService,
  useRpcState,
  useSafeMode,
  useSlotOverrides,
  useWorkspaceState,
} from "@qianji/client";
import {
  ClientSlotsService,
  clientSlotsRegistry,
  type SettingsPageSlotProps,
  type SettingsSectionSlotProps,
  type SlotComponentProps,
  type SlotRegistry,
} from "@qianji/client-slots";
import { Badge, Button, Card, Switch } from "@qianji/client-primitives";
import { buildSlotOwnershipRows } from "./slotCatalogMetadata";

type PageCompProps = SlotComponentProps<SettingsPageSlotProps, "root">;
type SectionCompProps = SlotComponentProps<SettingsSectionSlotProps, "root">;

function buildWorkspaceParams(workspace: string): Record<string, unknown> {
  const trimmed = workspace.trim();
  return trimmed !== "" ? { workspace: trimmed } : {};
}

export function PluginsSettingsSlotPage({ ctx, cwd, renderFactory }: PageCompProps): ReactElement {
  const workspaceState = useWorkspaceState(ctx);
  const rpcState = useRpcState(ctx);
  const rpcService = useFrontendService("rpcService", ctx);
  const safeMode = useSafeMode();
  const contributions = useClientContributions();
  const hostConnected = rpcState?.hostStatus === "connected" || workspaceState?.hostConnected === true;
  const effectiveCwd = workspaceState?.cwd || cwd || "";

  const [plugins, setPlugins] = useState<readonly PluginInfo[]>([]);

  const invokeRpc = useCallback(
    async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
      if (rpcService !== undefined) {
        return rpcService.call<T>(method, params);
      }
      return callHostRpc<T>(method, params);
    },
    [rpcService],
  );

  const loadPlugins = useCallback(async (): Promise<void> => {
    if (!hostConnected) return;
    try {
      const result = await invokeRpc<PluginListResult>("plugin.list", buildWorkspaceParams(effectiveCwd));
      setPlugins(Array.isArray(result?.plugins) ? result.plugins : []);
    } catch {
      // Keep last known snapshot when Host RPC is unavailable or offline.
    }
  }, [effectiveCwd, hostConnected, invokeRpc]);

  useEffect(() => {
    if (!hostConnected) return undefined;
    let cancelled = false;
    void invokeRpc<PluginListResult>("plugin.list", buildWorkspaceParams(effectiveCwd))
      .then((result) => {
        if (!cancelled) {
          setPlugins(Array.isArray(result?.plugins) ? result.plugins : []);
        }
      })
      .catch(() => undefined);
    const offChanged = rpcService?.onNotification("plugin/changed", () => {
      if (!cancelled) void loadPlugins();
    }, { eagerConnect: false });
    return () => {
      cancelled = true;
      offChanged?.();
    };
  }, [effectiveCwd, hostConnected, invokeRpc, loadPlugins, rpcService]);

  const handleTogglePlugin = useCallback(
    async (plugin: PluginInfo, nextEnabled: boolean): Promise<void> => {
      const method = nextEnabled ? "plugin.enable" : "plugin.disable";
      const params: PluginToggleParams = {
        id: plugin.id,
        ...(effectiveCwd.trim() !== "" ? { workspace: effectiveCwd.trim() } : {}),
      };
      await invokeRpc<PluginMutationResult>(method, { ...params });
      await loadPlugins();
    },
    [effectiveCwd, invokeRpc, loadPlugins],
  );

  const fallback = (
    <div data-testid="settings-page-plugins" style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {safeMode.active && (
        <Card variant="subtle" padding="sm">
          <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12.5px", color: "var(--qj-status-warning)" }}>
            <ShieldAlert size={15} />
            <span>安全模式生效中：外部用户与工作区客户端插件已暂停加载。</span>
          </div>
        </Card>
      )}

      <Card variant="subtle" padding="md">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <Badge variant={hostConnected ? "success" : "neutral"}>
              {hostConnected ? "Host 已连接" : "离线 / 仅内置核心"}
            </Badge>
            <Badge variant="neutral">扩展设置页 {contributions.settingsPages.length}</Badge>
            <Badge variant="neutral">扩展分区 {contributions.settingsSections.length}</Badge>
            <Badge variant="neutral">动态主题 {contributions.themes.length}</Badge>
          </div>
          {hostConnected && (
            <Button type="button" size="sm" variant="secondary" onClick={() => void loadPlugins()}>
              <RefreshCw size={12} />
              <span>刷新列表</span>
            </Button>
          )}
        </div>
      </Card>

      {plugins.length > 0 && (
        <div data-testid="settings-plugins-list" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {plugins.map((plugin) => (
            <Card key={plugin.id} variant="default" padding="sm" data-testid={`settings-plugin-row-${plugin.id}`}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                    <strong style={{ fontSize: "13px", color: "var(--qj-text-primary)" }}>{plugin.name || plugin.id}</strong>
                    <Badge variant="neutral">{plugin.tier}</Badge>
                    <Badge variant={plugin.status === "active" ? "success" : plugin.status === "errored" ? "danger" : "neutral"}>
                      {plugin.status}
                    </Badge>
                  </div>
                  {plugin.description !== undefined && plugin.description !== "" && (
                    <span style={{ fontSize: "12px", color: "var(--qj-text-secondary)" }}>{plugin.description}</span>
                  )}
                </div>
                <Switch
                  data-testid={`settings-plugin-toggle-${plugin.id}`}
                  aria-label={`启用或停用插件 ${plugin.id}`}
                  checked={plugin.enabled !== false && plugin.status !== "disabled"}
                  disabled={plugin.canDisable === false}
                  onCheckedChange={(checked) => void handleTogglePlugin(plugin, checked)}
                />
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <>
      {renderFactory("host.settings.plugins", { cwd: effectiveCwd }, { fallback })}
    </>
  );
}

/** Convenience `settings.sections` card on `"plugins"` linking directly to `"slots"`. */
export function PluginsSlotsShortcutSection({ page, ctx }: SectionCompProps): ReactElement | null {
  const ambientCtx = useClientContext(ctx);
  const resolvedCtx = ctx ?? ambientCtx;
  const navigationService = useFrontendService("navigationService", resolvedCtx);
  const registry = useMemo<SlotRegistry>(() => {
    const svc = (resolvedCtx as { get?(name: string): unknown } | undefined)?.get?.("slots");
    if (svc instanceof ClientSlotsService) return svc.registry;
    if (typeof svc === "object" && svc !== null && "registry" in svc) {
      return (svc as { registry: SlotRegistry }).registry;
    }
    return clientSlotsRegistry;
  }, [resolvedCtx]);

  const version = useSyncExternalStore(registry.subscribe, registry.getVersion, registry.getVersion);
  const overrides = useSlotOverrides(registry.overrides);

  const summary = useMemo(() => {
    void version;
    const rows = buildSlotOwnershipRows(registry, overrides);
    return {
      total: rows.length,
      external: rows.filter((r) => r.isExternallyOwned).length,
      abdicated: rows.filter((r) => r.hasAbdication).length,
      overrides: Object.keys(overrides).length,
    };
  }, [registry, version, overrides]);

  const handleOpenSlots = useCallback((): void => {
    const handledByBridge = openSettingsPage("slots");
    const currentNavPage = navigationService?.getSnapshot().settingsPage;
    if (!handledByBridge || currentNavPage !== "plugin:slots") {
      navigationService?.openSettings("slots");
    }
  }, [navigationService]);

  if (page !== "plugins") {
    return null;
  }

  return (
    <section className="settings-layered-section settings-plugin-section" data-testid="plugins-slots-shortcut-section">
      <h2>核心槽位与接管</h2>
      <Card variant="default" padding="md">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px", flex: "1 1 280px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <Layers size={15} style={{ color: "var(--qj-brand-primary)" }} />
              <strong style={{ fontSize: "13.5px", color: "var(--qj-text-primary)" }}>
                核心界面槽位归属与冲突治理
              </strong>
            </div>
            <p style={{ margin: 0, fontSize: "12.5px", color: "var(--qj-text-secondary)", lineHeight: 1.45 }}>
              查看全量核心槽位当前接管插件、排查渲染异常退让记录，或手动锁定胜出插件并一键恢复内置默认。
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
              <Badge variant="neutral">槽位 {summary.total}</Badge>
              <Badge variant={summary.external > 0 ? "brand" : "neutral"}>外部接管 {summary.external}</Badge>
              <Badge variant={summary.overrides > 0 ? "brand" : "neutral"}>手动锁定 {summary.overrides}</Badge>
              {summary.abdicated > 0 && <Badge variant="danger">异常退让 {summary.abdicated}</Badge>}
            </div>
          </div>

          <Button
            type="button"
            size="md"
            variant="primary"
            data-testid="plugins-open-slots-btn"
            onClick={handleOpenSlots}
          >
            <span>管理槽位接管</span>
            <ArrowRight size={14} />
          </Button>
        </div>
      </Card>
    </section>
  );
}
