import { Boxes } from "lucide-react";
import type {
  ClientSettingsSectionContribution,
  SettingsSlotContext,
} from "../../lib/clientContributions";
import { SlotEntryHost } from "../common/ErrorBoundary";
import {
  PluginSettingsContent,
  sectionsForSettingsPage,
  type SettingsNavItem,
} from "../settings/settingsNavigation";

export interface PluginsSubTabsBarProps {
  pluginNav: readonly SettingsNavItem[];
  activeSubPage: SettingsNavItem | undefined;
  onSelectSubPage: (pluginPageId: string | null) => void;
}

/**
 * Secondary tab bar inside `PluginsSettingsPanel` (DSH `settings.plugins.tab` pattern),
 * keeping plugin-contributed settings pages inside the Plugins surface instead of
 * extending the top-level Settings sidebar.
 */
export function PluginsSubTabsBar({
  pluginNav,
  activeSubPage,
  onSelectSubPage,
}: PluginsSubTabsBarProps) {
  if (pluginNav.length === 0) return null;

  return (
    <div className="plugins-subtabs-bar" role="tablist" aria-label="插件视图切换">
      <button
        type="button"
        role="tab"
        aria-selected={activeSubPage === undefined}
        className={activeSubPage === undefined ? "plugins-subtab-btn active" : "plugins-subtab-btn"}
        onClick={() => onSelectSubPage(null)}
      >
        <Boxes size={14} strokeWidth={1.85} aria-hidden="true" />
        <span>已安装与管理</span>
      </button>
      {pluginNav.map((item) => {
        const pluginPageId = item.plugin?.id;
        if (pluginPageId === undefined) return null;
        const isActive = activeSubPage?.id === item.id;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={isActive ? "plugins-subtab-btn active" : "plugins-subtab-btn"}
            data-qj-contributed-by={item.plugin ? item.plugin.pluginId ?? "builtin" : undefined}
            onClick={() => onSelectSubPage(pluginPageId)}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export interface PluginSettingsSubPageViewProps {
  page: SettingsNavItem;
  sections: readonly ClientSettingsSectionContribution[];
  context: SettingsSlotContext;
}

/** Renders a plugin-contributed settings page (`settings.pages`) and its bound sections. */
export function PluginSettingsSubPageView({
  page,
  sections,
  context,
}: PluginSettingsSubPageViewProps) {
  return (
    <div className={`plugins-subpage-stage${page.wide ? " is-wide" : ""}`}>
      <div className="plugins-subpage-header">
        <h2>{page.heading}</h2>
        {page.subtitle !== "" && <p className="plugins-subpage-subtitle">{page.subtitle}</p>}
      </div>
      <PluginSettingsContent page={page} sections={sections} context={context} />
    </div>
  );
}

export interface PluginsManagementSectionsFooterProps {
  sections: readonly ClientSettingsSectionContribution[];
  context: SettingsSlotContext;
}

/** Renders `settings.sections` targeting `"plugins"` (or legacy `"mcp"` / `"skills"`) at the bottom of the management view. */
export function PluginsManagementSectionsFooter({
  sections,
  context,
}: PluginsManagementSectionsFooterProps) {
  const matching = sectionsForSettingsPage(sections, "plugins");
  if (matching.length === 0) return null;

  return (
    <>
      {matching.map((section) => (
        <section key={section.id} className="settings-layered-section settings-plugin-section">
          {section.title !== undefined && section.title !== "" && <h2>{section.title}</h2>}
          <SlotEntryHost
            entry={section}
            context={context}
            slotName="settings.sections"
            className="settings-soft-card settings-plugin-card"
          />
        </section>
      ))}
    </>
  );
}
