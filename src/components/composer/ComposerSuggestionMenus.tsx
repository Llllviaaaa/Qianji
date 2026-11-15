import { Fragment, type ReactNode } from "react";
import { FileText, Folder, Maximize2, Minimize2 } from "lucide-react";
import type { SlashCommand, WorkspaceDirEntry } from "../../types";
import {
  formatCommandDescription,
  resolveSlashCommandMeta,
  splitHighlightSegments,
  useSuggestionMenuChrome,
  type CommandMenuLayoutPrefs,
  type SuggestionHoverPreview,
} from "./slashCommandHelpers";

export {
  filterAndRankSlashCommands,
  formatCommandDescription,
  resolveSlashCommandMeta,
  splitHighlightSegments,
  type SlashCommandBadgeTone,
  type SlashCommandGroupKey,
  type SlashCommandVisualMeta,
} from "./slashCommandHelpers";

function renderHighlightedName(text: string, query: string | null) {
  return splitHighlightSegments(text, query).map((segment, index) =>
    segment.matched ? (
      <mark key={`${index}-${segment.text}`} className="command-item-match">
        {segment.text}
      </mark>
    ) : (
      <span key={`${index}-${segment.text}`}>{segment.text}</span>
    ),
  );
}

function renderCommandName(name: string, query: string | null) {
  const normalizedQuery = query?.trim().toLowerCase() ?? "";
  if (name.startsWith("skill:")) {
    const colonIndex = 5;
    const matchIndex = normalizedQuery ? name.toLowerCase().indexOf(normalizedQuery) : -1;
    const matchTouchesPrefix = normalizedQuery !== "" && matchIndex >= 0 && matchIndex <= colonIndex;
    if (!matchTouchesPrefix) {
      return (
        <>
          <span className="command-item-namespace">skill:</span>
          {renderHighlightedName(name.slice(colonIndex + 1), query)}
        </>
      );
    }
  }
  return renderHighlightedName(name, query);
}

function SuggestionMenuShell({
  menuClassName,
  menuRef,
  layout,
  isResizing,
  title,
  shortcuts,
  isExpandedOrCustom,
  onToggleExpand,
  onResetWidth,
  onResizePointerDown,
  hoverPreview,
  children,
}: {
  menuClassName: string;
  menuRef: React.RefObject<HTMLDivElement | null>;
  layout: CommandMenuLayoutPrefs;
  isResizing: boolean;
  title: ReactNode;
  shortcuts: ReactNode;
  isExpandedOrCustom: boolean;
  onToggleExpand: () => void;
  onResetWidth: () => void;
  onResizePointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  hoverPreview: SuggestionHoverPreview | null;
  children: ReactNode;
}) {
  const inlineStyle =
    !layout.expanded && layout.customWidth !== null
      ? { width: `${layout.customWidth}px`, right: "auto" as const }
      : undefined;

  return (
    <div
      className={menuClassName}
      ref={menuRef}
      data-expanded={layout.expanded ? "true" : undefined}
      data-resizing={isResizing ? "true" : undefined}
      style={inlineStyle}
    >
      <div className="command-menu-header">
        <span className="command-menu-title" aria-hidden="true">
          {title}
        </span>
        <span className="command-menu-header-actions">
          <span className="command-menu-shortcuts" aria-hidden="true">
            {shortcuts}
          </span>
          <button
            type="button"
            className="command-menu-expand-btn"
            data-active={isExpandedOrCustom ? "true" : undefined}
            tabIndex={-1}
            aria-label={isExpandedOrCustom ? "恢复默认宽度" : "展开面板宽度与完整介绍"}
            title={isExpandedOrCustom ? "恢复默认宽度" : "展开面板宽度与完整介绍"}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onToggleExpand}
          >
            {isExpandedOrCustom ? (
              <Minimize2 size={12} strokeWidth={1.9} />
            ) : (
              <Maximize2 size={12} strokeWidth={1.9} />
            )}
          </button>
        </span>
      </div>
      {children}
      {hoverPreview && (
        <div
          className="command-menu-tooltip"
          data-placement={hoverPreview.placement}
          style={
            hoverPreview.placement === "above"
              ? { bottom: `${hoverPreview.offsetPx}px` }
              : { top: `${hoverPreview.offsetPx}px` }
          }
          role="tooltip"
        >
          <div className="command-menu-tooltip-head">
            <span className="command-menu-tooltip-name">{hoverPreview.title}</span>
            {hoverPreview.argsHint ? (
              <span className="command-menu-tooltip-args">{hoverPreview.argsHint}</span>
            ) : null}
            {hoverPreview.badgeLabel ? (
              <span className="command-menu-tooltip-badge">{hoverPreview.badgeLabel}</span>
            ) : null}
          </div>
          <div className="command-menu-tooltip-desc">{hoverPreview.description}</div>
        </div>
      )}
      <div
        className="command-menu-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="拖拽调整面板宽度"
        title="拖拽调整宽度（双击恢复默认）"
        onMouseDown={(event) => event.preventDefault()}
        onDoubleClick={onResetWidth}
        onPointerDown={onResizePointerDown}
      />
    </div>
  );
}

export function ComposerSuggestionMenus({
  commandMenuOpen,
  commandQuery,
  commandMatches,
  activeCommand,
  chooseCommand,
  mentionMenuOpen,
  mentionQuery,
  mentionEntries,
  mentionLoading,
  activeEntry,
  chooseEntry,
  suggestionsId,
  suggestionMenuRef,
  setSuggestionIndex,
}: {
  commandMenuOpen: boolean;
  commandQuery: string | null;
  commandMatches: SlashCommand[];
  activeCommand: SlashCommand | undefined;
  chooseCommand: (command: SlashCommand) => void;
  mentionMenuOpen: boolean;
  mentionQuery: string | null;
  mentionEntries: WorkspaceDirEntry[];
  mentionLoading: boolean;
  activeEntry: WorkspaceDirEntry | undefined;
  chooseEntry: (entry: WorkspaceDirEntry, enterFolder: boolean) => void;
  suggestionsId: string;
  suggestionMenuRef: React.RefObject<HTMLDivElement | null>;
  setSuggestionIndex: (next: number) => void;
}) {
  const {
    layout,
    isResizing,
    hoverPreview,
    isExpandedOrCustom,
    handleToggleExpand,
    handleResetWidth,
    handleResizePointerDown,
    clearHoverPreview,
    scheduleHoverPreview,
  } = useSuggestionMenuChrome({
    commandMenuOpen,
    mentionMenuOpen,
    commandQuery,
    mentionQuery,
    suggestionMenuRef,
  });

  const hasQuery = Boolean(commandQuery && commandQuery.trim() !== "");
  const commandEntries = commandMatches.map((command) => ({
    command,
    meta: resolveSlashCommandMeta(command),
  }));
  const showGroupHeaders = !hasQuery && new Set(commandEntries.map((item) => item.meta.group)).size >= 2;

  return (
    <>
      {commandMenuOpen && (
        <SuggestionMenuShell
          menuClassName="command-menu"
          menuRef={suggestionMenuRef}
          layout={layout}
          isResizing={isResizing}
          title={
            <>
              {hasQuery ? "匹配指令" : "快捷指令"}
              <span className="command-menu-count">{commandMatches.length}</span>
            </>
          }
          shortcuts={
            <>
              <span><kbd>↑↓</kbd> 选择</span>
              <span><kbd>↵</kbd> 填入</span>
              <span><kbd>Esc</kbd> 关闭</span>
            </>
          }
          isExpandedOrCustom={isExpandedOrCustom}
          onToggleExpand={handleToggleExpand}
          onResetWidth={handleResetWidth}
          onResizePointerDown={handleResizePointerDown}
          hoverPreview={hoverPreview}
        >
          <div
            className="command-menu-list"
            id={suggestionsId}
            role="listbox"
            aria-label="快捷指令"
            onMouseLeave={clearHoverPreview}
            onScroll={clearHoverPreview}
          >
            {commandEntries.map(({ command, meta }, index) => {
              const prevGroup = index > 0 ? commandEntries[index - 1]?.meta.group : undefined;
              const isActive = command === activeCommand;
              const { Icon } = meta;
              const description = formatCommandDescription(command.description, meta.badgeLabel);
              return (
                <Fragment key={`${command.source}-${command.name}`}>
                  {showGroupHeaders && (index === 0 || meta.group !== prevGroup) && (
                    <div className="command-menu-group-label" role="presentation" aria-hidden="true">
                      {meta.groupLabel}
                    </div>
                  )}
                  <button
                    id={`${suggestionsId}-${index}`}
                    data-suggestion-index={index}
                    type="button"
                    className={`command-menu-item${isActive ? " active" : ""}`}
                    role="option"
                    aria-selected={isActive}
                    tabIndex={-1}
                    onMouseEnter={(event) => {
                      setSuggestionIndex(index);
                      if (layout.expanded) return;
                      const buttonEl = event.currentTarget;
                      const descEl = buttonEl.querySelector<HTMLElement>(".command-item-desc");
                      const argsEl = buttonEl.querySelector<HTMLElement>(".command-item-args");
                      const nameEl = buttonEl.querySelector<HTMLElement>(".command-item-name");
                      const isTruncated =
                        Boolean(descEl && descEl.scrollWidth > descEl.clientWidth) ||
                        Boolean(argsEl && argsEl.scrollWidth > argsEl.clientWidth) ||
                        Boolean(nameEl && nameEl.scrollWidth > nameEl.clientWidth);
                      if (!isTruncated) {
                        clearHoverPreview();
                        return;
                      }
                      scheduleHoverPreview(buttonEl, {
                        key: `${command.source}-${command.name}`,
                        title: `/${command.name}`,
                        argsHint: command.argsHint,
                        badgeLabel: meta.badgeLabel,
                        description,
                      });
                    }}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseCommand(command)}
                  >
                    <span className="command-item-icon" data-tone={meta.tone} aria-hidden="true">
                      <Icon size={14} strokeWidth={1.8} />
                    </span>
                    <span className="command-item-body">
                      <span className="command-item-topline">
                        <span className="command-item-name">
                          <span className="command-item-slash">/</span>
                          {renderCommandName(command.name, commandQuery)}
                        </span>
                        {command.argsHint ? <span className="command-item-args">{command.argsHint}</span> : null}
                      </span>
                      <span className="command-item-desc">{description}</span>
                    </span>
                    <span className="command-item-meta">
                      <span className="command-item-badge" data-tone={meta.tone}>
                        {meta.badgeLabel}
                      </span>
                      <kbd className="command-item-enter" aria-hidden="true">↵</kbd>
                    </span>
                  </button>
                </Fragment>
              );
            })}
          </div>
        </SuggestionMenuShell>
      )}

      {mentionMenuOpen && (
        <SuggestionMenuShell
          menuClassName="command-menu mention-menu"
          menuRef={suggestionMenuRef}
          layout={layout}
          isResizing={isResizing}
          title={mentionQuery?.endsWith("/") ? mentionQuery : "引用文件与目录"}
          shortcuts={
            <>
              <span><kbd>↵</kbd> 引用</span>
              <span><kbd>Tab</kbd> 进入目录</span>
            </>
          }
          isExpandedOrCustom={isExpandedOrCustom}
          onToggleExpand={handleToggleExpand}
          onResetWidth={handleResetWidth}
          onResizePointerDown={handleResizePointerDown}
          hoverPreview={hoverPreview}
        >
          <div
            className="command-menu-list"
            id={suggestionsId}
            role="listbox"
            aria-label="引用文件"
            onMouseLeave={clearHoverPreview}
            onScroll={clearHoverPreview}
          >
            {mentionEntries.map((entry, index) => {
              const folder = !mentionQuery?.endsWith("/") && entry.path.includes("/")
                ? entry.path.slice(0, entry.path.lastIndexOf("/"))
                : "";
              const isActive = entry === activeEntry;
              return (
                <button
                  key={entry.path}
                  id={`${suggestionsId}-${index}`}
                  data-suggestion-index={index}
                  type="button"
                  className={`mention-item${isActive ? " active" : ""}`}
                  role="option"
                  aria-selected={isActive}
                  tabIndex={-1}
                  onMouseEnter={(event) => {
                    setSuggestionIndex(index);
                    const buttonEl = event.currentTarget;
                    const nameEl = buttonEl.querySelector<HTMLElement>(".mention-item-name");
                    const pathEl = buttonEl.querySelector<HTMLElement>(".mention-item-path");
                    const isTruncated =
                      Boolean(nameEl && nameEl.scrollWidth > nameEl.clientWidth) ||
                      Boolean(pathEl && pathEl.scrollWidth > pathEl.clientWidth);
                    if (!isTruncated) {
                      clearHoverPreview();
                      return;
                    }
                    scheduleHoverPreview(buttonEl, {
                      key: `mention-${entry.path}`,
                      title: `${entry.name}${entry.isDir ? "/" : ""}`,
                      badgeLabel: entry.isDir ? "目录" : "文件",
                      description: entry.path,
                    });
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseEntry(entry, entry.isDir)}
                >
                  <span className="mention-item-icon" data-dir={entry.isDir ? "true" : undefined} aria-hidden="true">
                    {entry.isDir ? <Folder size={14} strokeWidth={1.8} /> : <FileText size={14} strokeWidth={1.8} />}
                  </span>
                  <span className="mention-item-name">{entry.name}{entry.isDir ? "/" : ""}</span>
                  <span className="mention-item-path">{folder}</span>
                  {entry.isDir ? (
                    <kbd className="mention-item-hint">Tab</kbd>
                  ) : (
                    <kbd className="command-item-enter" aria-hidden="true">↵</kbd>
                  )}
                </button>
              );
            })}
            {mentionEntries.length === 0 && (
              <div className="mention-menu-status">{mentionLoading ? "正在查找工作区文件…" : "没有匹配的文件"}</div>
            )}
          </div>
        </SuggestionMenuShell>
      )}
    </>
  );
}
