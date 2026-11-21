/**
 * Built-in & extension settings sidebar navigation for `CoreSettingsShell`
 * (`src/builtin-plugins/core-settings/CoreSettingsNav.tsx`).
 */
import { useState, type ReactElement, type ReactNode } from "react";
import { ArrowLeft, ChevronDown, Search } from "lucide-react";

export interface SettingsNavEntry {
  readonly id: string;
  readonly label: string;
  readonly heading: string;
  readonly subtitle: string;
  readonly icon: ReactNode;
  readonly wide: boolean;
  readonly contributedBy?: string;
}

export interface CoreSettingsNavProps {
  readonly isPage: boolean;
  readonly shownPage: string;
  readonly shortcutLabel?: string;
  readonly builtinNav: readonly SettingsNavEntry[];
  readonly extensionNav: readonly SettingsNavEntry[];
  readonly onSelectPage: (pageId: string) => void;
  readonly onClose: () => void;
}

export function CoreSettingsNav({
  isPage,
  shownPage,
  shortcutLabel = "Ctrl+,",
  builtinNav,
  extensionNav,
  onSelectPage,
  onClose,
}: CoreSettingsNavProps): ReactElement {
  const [extensionsOpen, setExtensionsOpen] = useState(true);
  const [extFilterQuery, setExtFilterQuery] = useState("");
  const [lastSyncedPage, setLastSyncedPage] = useState(shownPage);

  if (lastSyncedPage !== shownPage) {
    setLastSyncedPage(shownPage);
    if (extensionNav.some((item) => item.id === shownPage)) {
      if (!extensionsOpen) setExtensionsOpen(true);
      const needle = extFilterQuery.trim().toLowerCase();
      if (needle !== "") {
        const activeExt = extensionNav.find((item) => item.id === shownPage);
        if (
          activeExt !== undefined &&
          !`${activeExt.label} ${activeExt.heading} ${activeExt.contributedBy ?? ""}`
            .toLowerCase()
            .includes(needle)
        ) {
          setExtFilterQuery("");
        }
      }
    }
  }

  const extNeedle = extFilterQuery.trim().toLowerCase();
  const filteredExtNav = extNeedle === ""
    ? extensionNav
    : extensionNav.filter((item) =>
        item.id === shownPage
        || `${item.label} ${item.heading} ${item.contributedBy ?? ""}`.toLowerCase().includes(extNeedle),
      );

  const renderNavButton = (item: SettingsNavEntry): ReactElement => {
    const isActive = shownPage === item.id;
    return (
      <button
        key={item.id}
        type="button"
        className={isActive ? "active" : ""}
        data-settings-page={item.id}
        data-testid={`settings-nav-${item.id}`}
        data-qj-contributed-by={item.contributedBy}
        onClick={() => onSelectPage(item.id)}
      >
        {isActive && <span className="settings-nav-pill" aria-hidden="true" />}
        {item.icon}
        <span>{item.label}</span>
      </button>
    );
  };

  return (
    <aside className="settings-navigation">
      {isPage && (
        <button
          type="button"
          className="settings-back-btn"
          onClick={onClose}
          title="返回应用 (Esc)"
          aria-label="返回应用"
        >
          <ArrowLeft size={15} strokeWidth={1.9} />
          <span>返回应用</span>
        </button>
      )}
      <div className="settings-modal-brand">设置</div>

      <nav className="settings-nav-scroll" aria-label="设置分类">
        {builtinNav.map(renderNavButton)}
        {extensionNav.length > 0 && (
          <>
            <div className="settings-nav-group-header">
              <button
                type="button"
                className="settings-nav-group-toggle"
                aria-expanded={extensionsOpen}
                onClick={() => setExtensionsOpen((prev) => !prev)}
              >
                <span className="settings-nav-group-label">扩展</span>
                <span className="settings-nav-group-meta">
                  {extensionNav.length > 1 && <em className="settings-nav-group-count">{extensionNav.length}</em>}
                  <ChevronDown size={12} className={extensionsOpen ? "is-open" : ""} aria-hidden="true" />
                </span>
              </button>
            </div>
            {extensionsOpen && (
              <>
                {extensionNav.length >= 6 && (
                  <div className="settings-nav-filter-wrap">
                    <Search size={12.5} aria-hidden="true" />
                    <input
                      type="search"
                      className="settings-nav-filter-input"
                      value={extFilterQuery}
                      onChange={(event) => setExtFilterQuery(event.target.value)}
                      placeholder="筛选扩展设置…"
                      aria-label="筛选扩展设置"
                    />
                  </div>
                )}
                {filteredExtNav.length > 0
                  ? filteredExtNav.map(renderNavButton)
                  : <div className="settings-nav-empty">无匹配扩展</div>}
              </>
            )}
          </>
        )}
      </nav>

      <div className="settings-nav-footer">
        <span className="settings-nav-app">千机</span>
        <kbd>{shortcutLabel}</kbd>
      </div>
    </aside>
  );
}
