/**
 * Settings modal host and default `settings.shell` implementation for `core-settings`
 * (`src/builtin-plugins/core-settings/CoreSettingsShell.tsx`).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  Boxes,
  Cpu,
  Layers,
  Maximize2,
  Minimize2,
  Palette,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  useClientContext,
  useClientContributions,
  useFrontendService,
  useNavigationState,
  useSessionState,
  useWorkspaceState,
  type ClientSettingsPageContribution,
  type ClientSettingsSectionContribution,
  type SettingsSlotContext,
} from "@qianji/client";
import {
  ClientSlotsService,
  SlotKernelErrorBoundary,
  clientSlotsRegistry,
  type CoreShellModalProps,
  type SettingsShellSlotProps,
  type SlotComponentProps,
  type SlotRegistry,
} from "@qianji/client-slots";
import { CoreSettingsNav, type SettingsNavEntry } from "./CoreSettingsNav";

export interface BuiltinSettingsPageMeta {
  readonly id: "general" | "appearance" | "providers" | "plugins" | "slots";
  readonly label: string;
  readonly heading: string;
  readonly subtitle: string;
  readonly wide: boolean;
}

export const BUILTIN_SETTINGS_PAGE_META: readonly BuiltinSettingsPageMeta[] = [
  { id: "general", label: "通用", heading: "通用", subtitle: "管理智能体模式、工具权限策略与工作区偏好", wide: false },
  { id: "appearance", label: "外观", heading: "外观", subtitle: "定制工作台明暗主题、界面显示比例与消息阅读密度", wide: false },
  { id: "providers", label: "模型", heading: "模型与密钥", subtitle: "配置当前对话模型与推理思考等级偏好", wide: false },
  { id: "plugins", label: "插件", heading: "扩展插件", subtitle: "统一管理扩展插件、核心能力、Agent 技能 (Skills) 与 MCP 工具服务", wide: true },
  {
    id: "slots",
    label: "槽位接管",
    heading: "核心槽位与接管",
    subtitle: "查看核心界面槽位归属、切换冲突胜出插件或一键恢复内置默认",
    wide: true,
  },
];

const BUILTIN_PAGE_ID_SET = new Set<string>(BUILTIN_SETTINGS_PAGE_META.map((item) => item.id));
const ICON_PROPS = { size: 15.5, strokeWidth: 1.85 } as const;

function renderBuiltinPageIcon(id: BuiltinSettingsPageMeta["id"]): ReactNode {
  switch (id) {
    case "general":
      return <SlidersHorizontal {...ICON_PROPS} />;
    case "appearance":
      return <Palette {...ICON_PROPS} />;
    case "providers":
      return <Cpu {...ICON_PROPS} />;
    case "plugins":
      return <Boxes {...ICON_PROPS} />;
    case "slots":
      return <Layers {...ICON_PROPS} />;
  }
}

/** Normalize legacy/bridge settings page identifiers (e.g. `"plugin:slots"` -> `"slots"`). */
export function normalizeSettingsPageKey(rawPage: string | undefined): string {
  const trimmed = rawPage?.trim() ?? "";
  if (trimmed === "") return "general";
  if (trimmed === "mcp" || trimmed === "skills") return "plugins";
  if (trimmed === "slots" || trimmed === "plugin:slots") return "slots";
  if (BUILTIN_PAGE_ID_SET.has(trimmed)) return trimmed;
  return trimmed;
}

function pluginSettingsPageId(page: string): string | undefined {
  return page.startsWith("plugin:") ? page.slice("plugin:".length) : undefined;
}

interface ResolvedSettingsNavEntry extends SettingsNavEntry {
  readonly legacyPluginPage?: ClientSettingsPageContribution;
}

function resolveRegistry(ctx: Context | undefined): SlotRegistry {
  const svc = (ctx as { get?(name: string): unknown } | undefined)?.get?.("slots");
  if (svc instanceof ClientSlotsService) return svc.registry;
  if (typeof svc === "object" && svc !== null && "registry" in svc) {
    return (svc as { registry: SlotRegistry }).registry;
  }
  return clientSlotsRegistry;
}

function LegacyRenderBridge({
  render,
  context,
}: {
  readonly render: (ctx: SettingsSlotContext) => ReactNode;
  readonly context: SettingsSlotContext;
}): ReactNode {
  return render(context);
}

function LegacyContributionHost({
  render,
  context,
  pluginId,
  entryId,
  slotKey,
}: {
  readonly render: (ctx: SettingsSlotContext) => ReactNode;
  readonly context: SettingsSlotContext;
  readonly pluginId: string;
  readonly entryId: string;
  readonly slotKey: string;
}): ReactElement {
  return (
    <SlotKernelErrorBoundary pluginId={pluginId} entryId={entryId} slotKey={slotKey}>
      <LegacyRenderBridge render={render} context={context} />
    </SlotKernelErrorBoundary>
  );
}

function matchingLegacySections(
  sections: readonly ClientSettingsSectionContribution[],
  pageId: string,
): ClientSettingsSectionContribution[] {
  const pluginPage = pluginSettingsPageId(pageId);
  return sections.filter(
    (section) =>
      section.page === pageId
      || (pageId === "plugins" && (section.page === "mcp" || section.page === "skills"))
      || (pluginPage !== undefined && section.page === pluginPage),
  );
}

type ModalHostProps = SlotComponentProps<CoreShellModalProps, "root">;
type ShellCompProps = SlotComponentProps<SettingsShellSlotProps, "root">;

export function CoreSettingsModalHost({ cwd, sessionFile, ctx, renderSlot }: ModalHostProps): ReactNode {
  const ambientCtx = useClientContext(ctx);
  const resolvedCtx = ctx ?? ambientCtx;
  const navigationState = useNavigationState(resolvedCtx);
  const sessionState = useSessionState(resolvedCtx);
  const workspaceState = useWorkspaceState(resolvedCtx);
  const navigationService = useFrontendService("navigationService", resolvedCtx);

  const handleClose = useCallback((): void => {
    navigationService?.closeSettings();
  }, [navigationService]);

  const handleSelectPage = useCallback(
    (nextPage: string): void => {
      navigationService?.openSettings(nextPage);
    },
    [navigationService],
  );

  if (navigationState?.settingsOpen !== true) return null;

  return renderSlot("settings.shell", {
    open: true,
    page: normalizeSettingsPageKey(navigationState.settingsPage),
    cwd: cwd ?? workspaceState?.cwd ?? sessionState?.cwd ?? "",
    sessionFile: sessionFile ?? sessionState?.sessionFile ?? null,
    onClose: handleClose,
    onSelectPage: handleSelectPage,
  });
}

export function CoreSettingsShell({
  open = true,
  page,
  cwd = "",
  sessionFile = null,
  onClose,
  onSelectPage,
  ctx,
  renderSlot,
}: ShellCompProps): ReactNode {
  const ambientCtx = useClientContext(ctx);
  const resolvedCtx = ctx ?? ambientCtx;
  const navigationService = useFrontendService("navigationService", resolvedCtx);
  const registry = useMemo(() => resolveRegistry(resolvedCtx), [resolvedCtx]);
  const registryVersion = useSyncExternalStore(registry.subscribe, registry.getVersion, registry.getVersion);
  const { settingsPages: legacyPages, settingsSections: legacySections } = useClientContributions();

  const [displayMode, setDisplayMode] = useState<"modal" | "page">("modal");
  const [uncontrolledPage, setUncontrolledPage] = useState<string>(() => normalizeSettingsPageKey(page));

  const requestedPage = onSelectPage !== undefined
    ? normalizeSettingsPageKey(page)
    : normalizeSettingsPageKey(uncontrolledPage);

  const closeSettings = useCallback((): void => {
    if (onClose !== undefined) {
      onClose();
      return;
    }
    navigationService?.closeSettings();
  }, [onClose, navigationService]);

  const selectPage = useCallback(
    (nextPage: string): void => {
      const normalized = normalizeSettingsPageKey(nextPage);
      if (onSelectPage !== undefined) onSelectPage(normalized);
      else setUncontrolledPage(normalized);
    },
    [onSelectPage],
  );

  useEffect(() => {
    if (!open || typeof window === "undefined") return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (typeof document !== "undefined" && document.querySelector("[data-escape-layer]") !== null) return;
      event.preventDefault();
      closeSettings();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, closeSettings]);

  const builtinNav = useMemo<ResolvedSettingsNavEntry[]>(
    () => BUILTIN_SETTINGS_PAGE_META.map((meta) => ({ ...meta, icon: renderBuiltinPageIcon(meta.id) })),
    [],
  );

  const extensionNav = useMemo<ResolvedSettingsNavEntry[]>(() => {
    void registryVersion;
    const items: ResolvedSettingsNavEntry[] = legacyPages.map((entry) => ({
      id: `plugin:${entry.id}`,
      label: entry.label,
      heading: entry.heading ?? entry.label,
      subtitle: entry.subtitle ?? "",
      icon: entry.icon ?? <Boxes {...ICON_PROPS} />,
      wide: entry.wide === true,
      legacyPluginPage: entry,
      contributedBy: entry.pluginId ?? "builtin",
    }));
    const knownIds = new Set<string>([...BUILTIN_PAGE_ID_SET, "plugin:slots", ...items.map((item) => item.id)]);
    for (const entry of registry.getEntries("settings.pages")) {
      for (const rawKey of entry.keys ?? []) {
        const key = rawKey.trim();
        if (key === "" || key === "*" || knownIds.has(key)) continue;
        knownIds.add(key);
        const label = key.startsWith("plugin:") ? key.slice("plugin:".length) : key;
        items.push({ id: key, label, heading: label, subtitle: "", icon: <Boxes {...ICON_PROPS} />, wide: false, contributedBy: entry.pluginId });
      }
    }
    return items;
  }, [legacyPages, registry, registryVersion]);

  if (!open) return null;

  const activeMeta = [...builtinNav, ...extensionNav].find((item) => item.id === requestedPage) ?? builtinNav[0];
  const shownPage = activeMeta?.id ?? "general";
  const isWideGrid = activeMeta?.wide === true;
  const isPage = displayMode === "page";
  const slotContext: SettingsSlotContext = { cwd, sessionFile, page: shownPage, closeSettings };
  const hasNativePageEntry = registry.getKeyedCandidates("settings.pages", shownPage).length > 0;
  const activeLegacySections = matchingLegacySections(legacySections, shownPage);

  return (
    <div
      className={`settings-backdrop ${isPage ? "is-page" : "is-modal"}`}
      data-testid="core-settings-backdrop"
      onMouseDown={(event) => {
        if (!isPage && event.target === event.currentTarget) closeSettings();
      }}
    >
      <div
        className={`settings-modal settings-center ${isPage ? "is-page" : "is-modal"}`}
        data-testid="core-settings-shell"
        data-settings-mode={displayMode}
        role={isPage ? "region" : "dialog"}
        aria-modal={isPage ? undefined : "true"}
        aria-label="设置"
      >
        <CoreSettingsNav
          isPage={isPage}
          shownPage={shownPage}
          builtinNav={builtinNav}
          extensionNav={extensionNav}
          onSelectPage={selectPage}
          onClose={closeSettings}
        />

        <main className="settings-content">
          <header className="settings-stage-header">
            <div className={`settings-stage-header-inner ${isWideGrid ? "is-wide" : ""}`}>
              <div className="settings-header-titles">
                <h1>{activeMeta?.heading ?? "设置"}</h1>
              </div>
              <div className="settings-header-actions">
                <button
                  type="button"
                  className="settings-mode-toggle-btn"
                  onClick={() => setDisplayMode((mode) => (mode === "page" ? "modal" : "page"))}
                  title={isPage ? "切换为居中弹窗展示" : "切换为独立页面展示"}
                  aria-label={isPage ? "切换为居中弹窗" : "切换为独立页面"}
                >
                  {isPage ? <Minimize2 size={13} strokeWidth={1.9} /> : <Maximize2 size={13} strokeWidth={1.9} />}
                  <span>{isPage ? "弹窗视图" : "页面视图"}</span>
                </button>
                {!isPage && (
                  <button
                    type="button"
                    className="settings-close-circle"
                    data-testid="core-settings-close"
                    onClick={closeSettings}
                    title="返回应用 (Esc)"
                    aria-label="返回应用"
                  >
                    <X size={15} strokeWidth={2} />
                  </button>
                )}
              </div>
            </div>
          </header>

          <div className="settings-page-scroll">
            <div className={`settings-page ${isWideGrid ? "is-wide" : ""}`} data-active-settings-page={shownPage}>
              {activeMeta?.subtitle !== undefined && activeMeta.subtitle !== "" && (
                <p className="settings-header-sub">{activeMeta.subtitle}</p>
              )}

              {activeMeta?.legacyPluginPage !== undefined && !hasNativePageEntry ? (
                <LegacyContributionHost
                  render={activeMeta.legacyPluginPage.render}
                  context={slotContext}
                  pluginId={activeMeta.legacyPluginPage.pluginId ?? "builtin"}
                  entryId={activeMeta.legacyPluginPage.id}
                  slotKey="settings.pages"
                />
              ) : (
                renderSlot("settings.pages", { cwd, sessionFile, page: shownPage, closeSettings }, { key: shownPage })
              )}

              {renderSlot("settings.sections", { cwd, sessionFile, page: shownPage, closeSettings })}

              {activeLegacySections.map((section) => (
                <section key={section.id} className="settings-layered-section settings-plugin-section">
                  {section.title !== undefined && section.title !== "" && <h2>{section.title}</h2>}
                  <div className="settings-soft-card settings-plugin-card">
                    <LegacyContributionHost
                      render={section.render}
                      context={slotContext}
                      pluginId={section.pluginId ?? "builtin"}
                      entryId={section.id}
                      slotKey="settings.sections"
                    />
                  </div>
                </section>
              ))}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
