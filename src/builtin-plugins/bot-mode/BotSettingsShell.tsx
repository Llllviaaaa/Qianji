/**
 * Dual-mode (`弹窗视图 ⇄ 页面视图`) Bot Settings Shell (`src/builtin-plugins/bot-mode/BotSettingsShell.tsx`).
 *
 * Provides grouped spatial navigation, live status indicators, a non-overlapping sticky
 * stage header with origin-aware connector breadcrumbs, and reversible sub-modal / host jumps.
 */
import { useEffect, useRef, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  ArrowLeft,
  ArrowUpRight,
  Blocks,
  Cpu,
  Database,
  Globe,
  HardDrive,
  KeyRound,
  LayoutGrid,
  Maximize2,
  MessageSquare,
  Mic,
  Minimize2,
  MonitorPlay,
  Plus,
  Settings,
  Shield,
  Sparkles,
  X,
} from "lucide-react";
import { useAppStore, useFrontendService } from "@qianji/client";
import type { BoundRenderFactoryFn } from "@qianji/client-slots";
import { getMergedConnectorCatalog, resolveConnectorState } from "./botConnectorCatalog";
import { BotSettingsPaneContent } from "./BotSettingsPanes";
import {
  formatVirtualServerStatus,
  openBotLiveView,
  openHostSettingsFromBot,
  patchBotUi,
  useBotSnapshot,
  useBotUiState,
  type BotSettingsTab,
} from "./botStore";
import { openLive2DShowcase } from "./live2d/live2dDirectorStore";

export interface BotSettingsTabMeta {
  readonly id: BotSettingsTab;
  readonly name: string;
  readonly heading: string;
  readonly subtitle: string;
  readonly group: "core" | "connect" | "guard";
  readonly wide?: boolean;
  readonly Icon: typeof Settings;
}

export const BOT_SETTINGS_TABS: readonly BotSettingsTabMeta[] = [
  {
    id: "general",
    name: "通用",
    heading: "通用",
    subtitle: "配置分身身份、外观主题、专属模型路由与主动巡检节奏",
    group: "core",
    Icon: Settings,
  },
  {
    id: "models",
    name: "模型与密钥",
    heading: "模型与服务商",
    subtitle: "在分身内直接配置模型服务商、API 密钥、自定义端点与专属模型路由",
    group: "core",
    wide: true,
    Icon: Cpu,
  },
  {
    id: "voice",
    name: "声音和虚拟形象",
    heading: "声音和虚拟形象",
    subtitle: "切换内置 4K Live2D 陪伴形象，或导入自定义 Cubism 4 模型包",
    group: "core",
    wide: true,
    Icon: Mic,
  },
  {
    id: "connectors",
    name: "连接器",
    heading: "连接器",
    subtitle: "一键通过官方 OAuth 2.1 或隔离浏览器连接常用工具，精细管控读写边界",
    group: "connect",
    wide: true,
    Icon: LayoutGrid,
  },
  {
    id: "channels",
    name: "消息渠道",
    heading: "消息渠道",
    subtitle: "管理分身专属收件箱、飞书机器人、Telegram 与工作区通讯通道",
    group: "connect",
    Icon: MessageSquare,
  },
  {
    id: "plugins",
    name: "插件",
    heading: "插件与双端共享",
    subtitle: "控制已装插件在 Agent 工作台与 Bot 分身之间的共享作用域及连接器扩展",
    group: "connect",
    wide: true,
    Icon: Blocks,
  },
  {
    id: "server",
    name: "虚拟服务器",
    heading: "虚拟服务器",
    subtitle: "分身在独立的 WSL2 容器或远端 SSH 服务器内执行工具与浏览器，隔离个人电脑",
    group: "guard",
    wide: true,
    Icon: HardDrive,
  },
  {
    id: "browser",
    name: "浏览器",
    heading: "浏览器会话隔离",
    subtitle: "使用与个人浏览器严格隔离的独立 Profile 检索网页与完成登录授权",
    group: "guard",
    Icon: Globe,
  },
  {
    id: "permissions",
    name: "权限",
    heading: "动作审批与权限策略",
    subtitle: "对外写操作强制进入审批边界，细粒度掌控每个已连接应用的执行级别",
    group: "guard",
    Icon: Shield,
  },
  {
    id: "vault",
    name: "安全存储",
    heading: "系统级密钥保险箱",
    subtitle: "所有模型 API Key 与连接器凭据均由 OS Keychain 加密托管，绝不明文落盘",
    group: "guard",
    Icon: KeyRound,
  },
  {
    id: "data",
    name: "数据控制",
    heading: "透明档案与数据控制",
    subtitle: "随时在线审阅或导出 SOUL.md 与 MEMORY.md 档案，或重置分身状态数据",
    group: "guard",
    Icon: Database,
  },
];

const NAV_GROUPS: ReadonlyArray<{ readonly id: BotSettingsTabMeta["group"]; readonly label: string }> = [
  { id: "core", label: "核心陪伴" },
  { id: "connect", label: "连接与扩展" },
  { id: "guard", label: "环境与守护" },
];

export function resolveBotSettingsTabLabel(tabId: BotSettingsTab | null): string {
  if (!tabId) return "连接器";
  return BOT_SETTINGS_TABS.find((t) => t.id === tabId)?.name ?? "设置";
}

export function BotSettingsShell({
  ctx,
  renderFactory,
  onClose,
}: {
  readonly ctx?: Context;
  readonly renderFactory?: BoundRenderFactoryFn;
  readonly onClose: () => void;
}): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const navigationService = useFrontendService("navigationService", ctx);
  const appSettings = useAppStore((s) => s.settings);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const activeMeta = BOT_SETTINGS_TABS.find((t) => t.id === ui.settingsTab) ?? BOT_SETTINGS_TABS[0];
  const isPage = ui.settingsPageMode;
  const isConnectorDrilldown = ui.settingsTab === "connectors" && ui.activeConnectorId !== null;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [ui.settingsTab, ui.activeConnectorId]);

  const mcpServers = appSettings?.mcpServers ?? [];
  const mergedCatalog = getMergedConnectorCatalog(ui.pluginConnectors);
  const connectedCatalogCount = mergedCatalog.filter(
    (entry) => resolveConnectorState(entry, snapshot, ui.mcpStatus, mcpServers).connected,
  ).length;
  const customMcpCount = mcpServers.filter((s) => !s.id.startsWith("preset-mcp-") && s.enabled).length;
  const totalConnectedCount = connectedCatalogCount + customMcpCount;
  const vsStatus = formatVirtualServerStatus(snapshot.virtualServer);
  const pendingApprovalsCount = snapshot.pendingApprovals.length;

  const activeConnectorTitle = (() => {
    const cid = ui.activeConnectorId;
    if (!cid) return "";
    if (cid === "custom-mcp") return "添加自定义 MCP 服务器";
    if (cid.startsWith("mcp-srv:")) {
      const srvId = cid.slice("mcp-srv:".length);
      return mcpServers.find((s) => s.id === srvId)?.name ?? "自定义 MCP 服务器";
    }
    return mergedCatalog.find((c) => c.id === cid)?.name ?? cid;
  })();

  const handleDrilldownBack = () => {
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

  const originBackLabel =
    ui.connectorOriginTab !== null && ui.connectorOriginTab !== "connectors"
      ? `返回${resolveBotSettingsTabLabel(ui.connectorOriginTab)}`
      : "返回连接器";

  return (
    <div
      className={`qj-bot-modal-backdrop qj-bset-backdrop${isPage ? " is-page" : " is-modal"}`}
      onMouseDown={(e) => {
        if (!isPage && e.target === e.currentTarget) onClose();
      }}
      data-testid="bot-settings-modal"
    >
      <div
        className={`qj-bot-dialog qj-bset-shell${isPage ? " is-page" : " is-modal"}`}
        role={isPage ? "region" : "dialog"}
        aria-modal={isPage ? undefined : "true"}
        aria-label="Bot 设置"
        onClick={(e) => e.stopPropagation()}
      >
        <aside className="qj-bset-rail" aria-label="Bot 设置分类">
          {isPage ? (
            <button
              type="button"
              className="qj-bset-rail-back"
              onClick={onClose}
              title="返回分身空间 (Esc)"
            >
              <ArrowLeft size={15} strokeWidth={1.9} />
              <span>返回分身</span>
            </button>
          ) : (
            <div className="qj-bset-rail-brand">设置</div>
          )}

          <nav className="qj-bset-rail-scroll" aria-label="设置分组导航">
            {NAV_GROUPS.map((group) => {
              const items = BOT_SETTINGS_TABS.filter((t) => t.group === group.id);
              return (
                <div key={group.id} className="qj-bset-nav-group">
                  <div className="qj-bset-nav-group-label">{group.label}</div>
                  {items.map(({ id, name, Icon }) => {
                    const active = ui.settingsTab === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        data-bot-settings-tab={id}
                        aria-current={active ? "page" : undefined}
                        onClick={() =>
                          patchBotUi({
                            settingsTab: id,
                            activeConnectorId: null,
                            connectorOriginTab: null,
                            serverFeedback: null,
                          })
                        }
                        className={`qj-bset-nav-item${active ? " active" : ""}`}
                      >
                        <Icon size={15.5} strokeWidth={active ? 2 : 1.8} className="qj-bset-nav-icon" />
                        <span className="qj-bset-nav-label">{name}</span>
                        {id === "connectors" && totalConnectedCount > 0 && (
                          <span className="qj-bset-nav-badge">{totalConnectedCount}</span>
                        )}
                        {id === "permissions" && pendingApprovalsCount > 0 && (
                          <span className="qj-bset-nav-badge warn">{pendingApprovalsCount}</span>
                        )}
                        {id === "server" && (
                          <span
                            className="qj-bset-nav-dot"
                            style={{ background: vsStatus.dotColor }}
                            title={vsStatus.label}
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </nav>

          <div className="qj-bset-rail-footer">
            <span className="qj-bset-rail-app">千机 · 分身设置</span>
            <kbd>Esc</kbd>
          </div>
        </aside>

        <main className="qj-bset-main">
          <header className="qj-bset-header">
            <div className={`qj-bset-header-inner${activeMeta?.wide ? " is-wide" : ""}`}>
              <div className="qj-bset-header-titles">
                {isConnectorDrilldown ? (
                  <div className="qj-bset-crumb-bar">
                    <button type="button" className="qj-bset-crumb-back" onClick={handleDrilldownBack}>
                      <ArrowLeft size={14} strokeWidth={1.9} />
                      <span>{originBackLabel}</span>
                    </button>
                    <span className="qj-bset-crumb-sep">/</span>
                    <h2 className="qj-bset-crumb-current">{activeConnectorTitle}</h2>
                  </div>
                ) : (
                  <>
                    <h2 className="qj-bset-heading">{activeMeta?.heading ?? "设置"}</h2>
                    {activeMeta?.subtitle && <p className="qj-bset-subtitle">{activeMeta.subtitle}</p>}
                  </>
                )}
              </div>

              <div className="qj-bset-header-actions">
                {(ui.settingsTab === "server" || ui.settingsTab === "browser") && (
                  <button
                    type="button"
                    className="qj-bset-head-cta"
                    onClick={() => openBotLiveView(undefined, { returnToCurrent: true })}
                  >
                    <MonitorPlay size={13.5} />
                    <span>查看实时画面</span>
                  </button>
                )}
                {ui.settingsTab === "voice" && (
                  <button
                    type="button"
                    data-testid="settings-open-live2d-showcase"
                    className="qj-bset-head-cta accent"
                    onClick={() => openLive2DShowcase()}
                  >
                    <Sparkles size={13.5} />
                    <span>角色与任务工坊</span>
                  </button>
                )}
                {ui.settingsTab === "plugins" && (
                  <button
                    type="button"
                    className="qj-bset-head-cta"
                    onClick={() => openHostSettingsFromBot(navigationService, "plugins")}
                  >
                    <Plus size={13.5} />
                    <span>安装 / 开发插件</span>
                    <ArrowUpRight size={12.5} />
                  </button>
                )}

                <button
                  type="button"
                  className="qj-bset-mode-toggle"
                  onClick={() => patchBotUi({ settingsPageMode: !isPage })}
                  title={isPage ? "切换为居中弹窗视图" : "切换为沉浸页面视图"}
                  aria-label={isPage ? "切换为居中弹窗" : "切换为页面视图"}
                >
                  {isPage ? <Minimize2 size={13} strokeWidth={1.9} /> : <Maximize2 size={13} strokeWidth={1.9} />}
                  <span>{isPage ? "弹窗视图" : "页面视图"}</span>
                </button>

                {!isPage && (
                  <button
                    type="button"
                    aria-label="关闭设置"
                    title="关闭设置 (Esc)"
                    className="qj-bset-close-btn"
                    onClick={onClose}
                  >
                    <X size={15.5} strokeWidth={2} />
                  </button>
                )}
              </div>
            </div>
          </header>

          <div ref={scrollRef} className="qj-bset-scroll">
            <div className={`qj-bset-stage${activeMeta?.wide ? " is-wide" : ""}`}>
              <BotSettingsPaneContent
                ctx={ctx}
                renderFactory={renderFactory}
                onClose={onClose}
              />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
