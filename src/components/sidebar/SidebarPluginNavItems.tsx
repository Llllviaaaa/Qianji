import { useState } from "react";
import { ChevronDown, ChevronUp, Puzzle } from "lucide-react";
import type { ClientPageContribution } from "../../lib/clientContributions";
import type { SidebarHub } from "./sidebarHelpers";

const COLLAPSED_PLUGIN_PAGE_LIMIT = 3;
const COLLAPSED_PLUGIN_PAGE_HEAD = 2;

export interface SidebarPluginNavItemsProps {
  pages?: readonly ClientPageContribution[];
  activeHub: SidebarHub;
  onSelectPage: (pageId: string) => void;
}

/**
 * Plugin full-stage navigation entries rendered inside `.sidebar-main-nav`
 * (top navigation region, well above the bottom-pinned Settings anchor).
 */
export function SidebarPluginNavItems({ pages, activeHub, onSelectPage }: SidebarPluginNavItemsProps) {
  const [expanded, setExpanded] = useState(false);

  if (pages === undefined || pages.length === 0) return null;

  const hasOverflow = pages.length > COLLAPSED_PLUGIN_PAGE_LIMIT;
  const activePageId = typeof activeHub === "string" && activeHub.startsWith("plugin:")
    ? activeHub.slice("plugin:".length)
    : undefined;
  const activeIndex = activePageId !== undefined ? pages.findIndex((page) => page.id === activePageId) : -1;
  const activeExtra = activeIndex >= COLLAPSED_PLUGIN_PAGE_HEAD ? pages[activeIndex] : undefined;

  const visiblePages = !hasOverflow || expanded
    ? pages
    : activeExtra !== undefined
      ? [...pages.slice(0, COLLAPSED_PLUGIN_PAGE_HEAD), activeExtra]
      : pages.slice(0, COLLAPSED_PLUGIN_PAGE_HEAD);

  const hiddenCount = pages.length - visiblePages.length;

  return (
    <>
      {visiblePages.map((page) => {
        const isActive = activeHub === `plugin:${page.id}`;
        return (
          <button
            key={page.id}
            type="button"
            className={`nav-item pid-sidebar-plugin-nav-btn${isActive ? " active" : ""}`}
            data-qj-contributed-by={page.pluginId ?? "builtin"}
            onClick={() => onSelectPage(page.id)}
          >
            {page.icon ?? <Puzzle size={15} strokeWidth={1.75} aria-hidden="true" />}
            <span className="pid-sidebar-plugin-nav-label">{page.label}</span>
          </button>
        );
      })}
      {hasOverflow && (
        <button
          type="button"
          className="nav-item pid-sidebar-plugin-more-btn"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? <ChevronUp size={14} strokeWidth={1.75} aria-hidden="true" /> : <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />}
          <span className="pid-sidebar-plugin-nav-label">
            {expanded ? "收起扩展" : `更多扩展 (${hiddenCount})`}
          </span>
        </button>
      )}
    </>
  );
}
