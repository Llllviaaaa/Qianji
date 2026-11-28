/**
 * Meta Muse + ChatGPT + Grok Inspired Connected Apps Directory (`BotConnectorsConsole.tsx`).
 */
import { useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { Blocks, ChevronRight, Plus, Search } from "lucide-react";
import { useAppStore, useFrontendService } from "@qianji/client";
import type { BotPluginConnectorCatalogItem } from "@qianji/protocol";
import {
  CATEGORY_LABELS,
  getMergedConnectorCatalog,
  resolveConnectorState,
  type ConnectorCategoryId,
} from "./botConnectorCatalog";
import { BotConnectorDetailView } from "./BotConnectorDetailView";
import { ConnectorBrandIcon } from "./BotConnectorLogos";
import { BotCustomMcpSheet } from "./BotCustomMcpSheet";
import { patchBotUi, useBotSnapshot, useBotUiState } from "./botStore";

type FilterCat = "all" | ConnectorCategoryId;

const FILTER_PILLS: ReadonlyArray<{ readonly id: FilterCat; readonly label: string }> = [
  { id: "all", label: "全部" },
  { id: "office", label: CATEGORY_LABELS.office },
  { id: "dev", label: CATEGORY_LABELS.dev },
  { id: "automation", label: CATEGORY_LABELS.automation },
];

export function BotConnectorsConsole({ ctx }: { readonly ctx?: Context }): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const rpcService = useFrontendService("rpcService", ctx);
  const appSettings = useAppStore((s) => s.settings);

  const [scopeTab, setScopeTab] = useState<"available" | "connected">("available");
  const [category, setCategory] = useState<FilterCat>("all");
  const [searchQuery, setSearchQuery] = useState("");

  const reloadPluginCatalog = () => {
    if (!rpcService) return;
    rpcService
      .call<{ items?: BotPluginConnectorCatalogItem[] }>("bot.connector.pluginCatalog", {})
      .then((res) => {
        if (Array.isArray(res?.items)) patchBotUi({ pluginConnectors: res.items });
      })
      .catch(() => undefined);
  };

  const mcpServers = appSettings?.mcpServers ?? [];
  const customMcpServers = mcpServers.filter((s) => !s.id.startsWith("preset-mcp-"));
  const mcpStatus = ui.mcpStatus;
  const allCatalog = getMergedConnectorCatalog(ui.pluginConnectors);

  const handleConnectorBack = () => {
    if (ui.connectorOriginTab !== null && ui.connectorOriginTab !== "connectors") {
      patchBotUi({
        settingsTab: ui.connectorOriginTab,
        activeConnectorId: null,
        connectorOriginTab: null,
        serverFeedback: null,
      });
      return;
    }
    patchBotUi({ activeConnectorId: null, connectorOriginTab: null, serverFeedback: null });
  };

  if (ui.activeConnectorId === "custom-mcp") {
    return <BotCustomMcpSheet ctx={ctx} onBack={handleConnectorBack} />;
  }

  if (ui.activeConnectorId?.startsWith("mcp-srv:")) {
    const srvId = ui.activeConnectorId.slice("mcp-srv:".length);
    const found = mcpServers.find((s) => s.id === srvId);
    const st = mcpStatus.find((s) => s.id === srvId);
    return (
      <BotCustomMcpSheet
        ctx={ctx}
        existingServer={found}
        existingStatus={st}
        onBack={handleConnectorBack}
      />
    );
  }

  if (ui.activeConnectorId !== null) {
    const matchedEntry = allCatalog.find((x) => x.id === ui.activeConnectorId);
    return (
      <BotConnectorDetailView
        key={ui.activeConnectorId}
        connectorId={ui.activeConnectorId}
        pluginEntry={matchedEntry?.pluginItem ? matchedEntry : undefined}
        onPluginMutated={reloadPluginCatalog}
        ctx={ctx}
        mcpStatus={mcpStatus}
        onBack={handleConnectorBack}
      />
    );
  }

  const q = searchQuery.trim().toLowerCase();
  const entriesWithState = allCatalog.map((entry) => ({
    entry,
    state: resolveConnectorState(entry, snapshot, mcpStatus, mcpServers),
  }));

  const connectedCount =
    entriesWithState.filter((x) => x.state.connected).length +
    customMcpServers.filter((s) => s.enabled).length;

  const visibleEntries = entriesWithState.filter(({ entry, state }) => {
    if (scopeTab === "connected" && !state.connected) return false;
    if (category !== "all" && entry.category !== category) return false;
    if (q === "") return true;
    return `${entry.name} ${entry.tagline} ${entry.categoryLabel} ${entry.authLabel} ${entry.id}`.toLowerCase().includes(q);
  });

  const featuredEntries = entriesWithState.filter((x) => x.entry.featured);
  const showFeatured = scopeTab === "available" && category === "all" && q === "";
  const categoryOrder: readonly ConnectorCategoryId[] = ["office", "dev", "automation"];

  return (
    <div className="qj-conn-dir-wrap" data-testid="bot-connectors-directory">
      <div className="qj-conn-toolbar">
        <div className="qj-conn-search-row">
          <div className="qj-connector-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="text"
              aria-label="搜索连接器"
              placeholder="搜索 Gmail、Notion、Linear、Figma、GitHub 或 MCP…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <div className="qj-conn-toolbar-actions">
            <button
              type="button"
              data-testid="open-bot-plugins-btn"
              className="qj-bset-btn soft sm"
              onClick={() => patchBotUi({ settingsTab: "plugins", serverFeedback: null })}
            >
              <Blocks size={13.5} />
              <span>管理插件</span>
            </button>
            <button
              type="button"
              data-testid="open-custom-mcp-btn"
              className="qj-bset-btn primary sm"
              onClick={() => patchBotUi({ activeConnectorId: "custom-mcp", connectorOriginTab: null, serverFeedback: null })}
            >
              <Plus size={13.5} />
              <span>添加自定义 MCP</span>
            </button>
          </div>
        </div>

        <div className="qj-conn-filter-row">
          <div className="qj-conn-scope-pills" role="tablist" aria-label="连接器视图">
            <button
              type="button"
              role="tab"
              aria-selected={scopeTab === "available"}
              className={`qj-conn-scope-pill${scopeTab === "available" ? " active" : ""}`}
              onClick={() => setScopeTab("available")}
            >
              可用
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={scopeTab === "connected"}
              className={`qj-conn-scope-pill${scopeTab === "connected" ? " active" : ""}`}
              onClick={() => setScopeTab("connected")}
            >
              已连接 ({connectedCount})
            </button>
          </div>

          <div className="qj-connector-cat-pills" role="tablist" aria-label="连接器分类">
            {FILTER_PILLS.map((pill) => (
              <button
                key={pill.id}
                type="button"
                role="tab"
                aria-selected={category === pill.id}
                className={`qj-connector-cat-pill${category === pill.id ? " active" : ""}`}
                onClick={() => setCategory(pill.id)}
              >
                {pill.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {showFeatured && (
        <section aria-label="精选推荐">
          <div className="qj-conn-group-title">精选推荐</div>
          <div className="qj-conn-featured-grid">
            {featuredEntries.map(({ entry, state }) => (
              <button
                key={entry.id}
                type="button"
                className="qj-conn-featured-card"
                onClick={() => patchBotUi({ activeConnectorId: entry.id, serverFeedback: null })}
              >
                <div className="qj-conn-featured-top">
                  <ConnectorBrandIcon id={entry.id} icon={entry.icon} iconBg={entry.iconBg} size={40} />
                  <span className={`qj-conn-action-chip${state.connected ? " connected" : ""}`}>
                    {state.connected ? "查看" : "连接"}
                  </span>
                </div>
                <div className="qj-conn-featured-name">{entry.name}</div>
                <div className="qj-conn-featured-desc">{entry.tagline}</div>
              </button>
            ))}
          </div>
        </section>
      )}

      {categoryOrder.map((catId) => {
        const items = visibleEntries.filter((x) => x.entry.category === catId);
        if (items.length === 0) return null;
        return (
          <section key={catId} aria-label={CATEGORY_LABELS[catId]}>
            <div className="qj-conn-group-title">{CATEGORY_LABELS[catId]}</div>
            <div className="qj-conn-list">
              {items.map(({ entry, state }) => (
                <button
                  key={entry.id}
                  type="button"
                  data-connector-id={entry.id}
                  className="qj-conn-row"
                  onClick={() => patchBotUi({ activeConnectorId: entry.id, serverFeedback: null })}
                >
                  <ConnectorBrandIcon id={entry.id} icon={entry.icon} iconBg={entry.iconBg} size={38} />
                  <div className="qj-conn-row-copy">
                    <div className="qj-conn-row-title-line">
                      <span className="qj-conn-row-name">{entry.name}</span>
                      <span className="qj-conn-row-perm">{entry.authLabel}</span>
                    </div>
                    <div className="qj-conn-row-sub">{entry.tagline}</div>
                  </div>
                  <div className="qj-conn-row-right">
                    <span className={`qj-conn-action-chip${state.connected ? " connected" : ""}`}>
                      {state.connected ? state.statusLabel : "连接"}
                    </span>
                    <ChevronRight size={14} className="qj-conn-row-chevron" />
                  </div>
                </button>
              ))}
            </div>
          </section>
        );
      })}

      {(category === "all" || category === "automation") && customMcpServers.length > 0 && (
        <section aria-label="自定义 MCP 服务器">
          <div className="qj-conn-group-title">自定义 MCP 服务器</div>
          <div className="qj-conn-list">
            {customMcpServers
              .filter((s) => scopeTab === "available" || s.enabled)
              .filter((s) => q === "" || `${s.name} ${s.url} ${s.command}`.toLowerCase().includes(q))
              .map((srv) => {
                const st = mcpStatus.find((x) => x.id === srv.id);
                return (
                  <button
                    key={srv.id}
                    type="button"
                    className="qj-conn-row"
                    onClick={() => patchBotUi({ activeConnectorId: `mcp-srv:${srv.id}` })}
                  >
                    <ConnectorBrandIcon id="mcp" size={38} />
                    <div className="qj-conn-row-copy">
                      <div className="qj-conn-row-title-line">
                        <span className="qj-conn-row-name">{srv.name}</span>
                        <span className="qj-conn-row-perm">{srv.transport === "http" ? "Remote MCP" : "STDIO"}</span>
                      </div>
                      <div className="qj-conn-row-sub">{srv.url || `${srv.command} ${srv.args.join(" ")}`}</div>
                    </div>
                    <div className="qj-conn-row-right">
                      <span className={`qj-conn-action-chip${st?.connected ? " connected" : ""}`}>
                        {st?.connected ? `已连接 · ${st.toolCount} 工具` : srv.enabled ? "管理" : "已停用"}
                      </span>
                      <ChevronRight size={14} className="qj-conn-row-chevron" />
                    </div>
                  </button>
                );
              })}
          </div>
        </section>
      )}

      {visibleEntries.length === 0 && (scopeTab === "connected" || q !== "") && customMcpServers.length === 0 && (
        <div className="qj-soft-empty">
          {scopeTab === "connected" ? "暂无已连接的外部应用，切换到「可用」一键连接" : "没有找到匹配的连接器"}
        </div>
      )}
    </div>
  );
}
