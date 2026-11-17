/**
 * Settings navigation: the built-in categories plus pages and sections that
 * plugins contribute through `registerSettingsPage` / `registerSettingsSection`.
 */
import { useState, type ReactNode } from "react";
import { Boxes, ChevronDown, Cpu, Palette, Search, SlidersHorizontal } from "lucide-react";
import type {
  ClientSettingsPageContribution,
  ClientSettingsSectionContribution,
  SettingsSlotContext,
} from "../../lib/clientContributions";
import { pluginSettingsPageId, type SettingsPageId } from "../../lib/shellBridge";
import { SlotEntryHost } from "../common/ErrorBoundary";

export interface SettingsNavItem {
  id: SettingsPageId;
  label: string;
  heading: string;
  subtitle: string;
  icon: ReactNode;
  /** Wide content column, used by grids of cards. */
  wide: boolean;
  /** Set for pages contributed by a plugin. */
  plugin?: ClientSettingsPageContribution;
}

const ICON_PROPS = { size: 15.5, strokeWidth: 1.85 } as const;

export const BUILTIN_SETTINGS_NAV: readonly [SettingsNavItem, ...SettingsNavItem[]] = [
  { id: "general", label: "通用", heading: "通用", subtitle: "管理对话发送习惯、外部代码编辑器与桌面通知偏好", icon: <SlidersHorizontal {...ICON_PROPS} />, wide: false },
  { id: "appearance", label: "外观", heading: "外观", subtitle: "定制工作台明暗主题、阅读排版字号与窗口显示比例", icon: <Palette {...ICON_PROPS} />, wide: false },
  { id: "providers", label: "模型", heading: "模型与密钥", subtitle: "配置默认对话模型与各模型专属思考等级，按需展开服务商填写本机加密 API Key", icon: <Cpu {...ICON_PROPS} />, wide: false },
  { id: "plugins", label: "插件", heading: "扩展插件", subtitle: "统一管理扩展插件、核心能力、Agent 技能 (Skills) 与 MCP 工具服务", icon: <Boxes {...ICON_PROPS} />, wide: true },
];

export function pluginSettingsNavItems(pages: readonly ClientSettingsPageContribution[]): SettingsNavItem[] {
  return pages.map((page) => ({
    id: `plugin:${page.id}`,
    label: page.label,
    heading: page.heading ?? page.label,
    subtitle: page.subtitle ?? "",
    icon: page.icon ?? <Boxes {...ICON_PROPS} />,
    wide: page.wide === true,
    plugin: page,
  }));
}

export function SettingsExtensionNavGroup({
  items,
  shownPage,
  renderNavButton,
}: {
  items: readonly SettingsNavItem[];
  shownPage: SettingsPageId;
  renderNavButton: (item: SettingsNavItem) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  const [query, setQuery] = useState("");
  const [prevShown, setPrevShown] = useState(shownPage);
  if (prevShown !== shownPage) {
    setPrevShown(shownPage);
    if (items.some((item) => item.id === shownPage)) {
      setExpanded(true);
      const q = query.trim().toLowerCase();
      if (q !== "") {
        const activeItem = items.find((item) => item.id === shownPage);
        const haystack = activeItem
          ? `${activeItem.label} ${activeItem.heading} ${activeItem.plugin?.pluginId ?? ""}`.toLowerCase()
          : "";
        if (!haystack.includes(q)) setQuery("");
      }
    }
  }

  if (items.length === 0) return null;

  const needle = query.trim().toLowerCase();
  const filteredItems = needle === ""
    ? items
    : items.filter((item) => {
      if (item.id === shownPage) return true;
      const haystack = `${item.label} ${item.heading} ${item.plugin?.pluginId ?? ""}`.toLowerCase();
      return haystack.includes(needle);
    });

  return (
    <>
      <div className="settings-nav-group-header">
        <button
          type="button"
          className="settings-nav-group-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="settings-nav-group-label">扩展</span>
          <span className="settings-nav-group-meta">
            {items.length > 1 && <em className="settings-nav-group-count">{items.length}</em>}
            <ChevronDown size={12} className={expanded ? "is-open" : ""} aria-hidden="true" />
          </span>
        </button>
      </div>
      {expanded && (
        <>
          {items.length >= 6 && (
            <div className="settings-nav-filter-wrap">
              <Search size={12.5} aria-hidden="true" />
              <input
                type="search"
                className="settings-nav-filter-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="筛选扩展设置…"
                aria-label="筛选扩展设置"
              />
            </div>
          )}
          {filteredItems.length > 0
            ? filteredItems.map(renderNavButton)
            : <div className="settings-nav-empty">无匹配扩展</div>}
        </>
      )}
    </>
  );
}

/** Sections whose `page` targets the page on screen (`"general"`, or a plugin page's own id). */
export function sectionsForSettingsPage(
  sections: readonly ClientSettingsSectionContribution[],
  page: SettingsPageId,
): ClientSettingsSectionContribution[] {
  const pluginPage = pluginSettingsPageId(page);
  return sections.filter((section) =>
    section.page === page
    || (page === "plugins" && (section.page === "mcp" || section.page === "skills"))
    || (pluginPage !== undefined && section.page === pluginPage)
  );
}

/** A plugin settings page body followed by every plugin section that targets the page on screen. */
export function PluginSettingsContent({
  page,
  sections,
  context,
}: {
  page: SettingsNavItem;
  sections: readonly ClientSettingsSectionContribution[];
  context: SettingsSlotContext;
}) {
  return (
    <>
      {page.plugin && <SlotEntryHost entry={page.plugin} context={context} slotName="settings.pages" />}
      {sectionsForSettingsPage(sections, page.id).map((section) => (
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
