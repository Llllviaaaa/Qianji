import { Fragment } from "react";
import {
  Activity,
  BarChart3,
  Blocks,
  FileText,
  Folder,
  Globe,
  ListChecks,
  MessageSquarePlus,
  Minimize2,
  PanelsTopLeft,
  Puzzle,
  RotateCcw,
  ScrollText,
  Slash,
  Sparkles,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import type { SlashCommand, WorkspaceDirEntry } from "../../types";
import { MAX_COMMAND_MATCHES } from "./composerHelpers";

export type SlashCommandGroupKey = "core" | "plugin" | "skill" | "system";
export type SlashCommandBadgeTone = "builtin" | "feature" | "plugin" | "skill" | "mcp" | "diagnostic";

export interface SlashCommandVisualMeta {
  group: SlashCommandGroupKey;
  groupLabel: string;
  badgeLabel: string;
  tone: SlashCommandBadgeTone;
  Icon: LucideIcon;
}

const GROUP_RANK: Record<SlashCommandGroupKey, number> = {
  core: 0,
  plugin: 1,
  skill: 2,
  system: 3,
};

const CORE_COMMAND_ORDER = ["clear", "compact", "plan", "ui", "doctor"] as const;

const COMMAND_ICON_BY_NAME: Record<string, LucideIcon> = {
  clear: MessageSquarePlus,
  compact: Minimize2,
  doctor: Activity,
  plan: ListChecks,
  ui: PanelsTopLeft,
  rewind: RotateCcw,
  usage: BarChart3,
  "session-usage": BarChart3,
  logs: ScrollText,
  "browser-diagnose": Globe,
};

function iconForTone(tone: SlashCommandBadgeTone): LucideIcon {
  switch (tone) {
    case "skill":
      return Sparkles;
    case "mcp":
      return Blocks;
    case "plugin":
      return Puzzle;
    case "builtin":
      return Terminal;
    default:
      return Slash;
  }
}

/** Resolve localized group, badge label, tone and icon for a slash command. */
export function resolveSlashCommandMeta(
  command: Pick<SlashCommand, "name" | "source">,
): SlashCommandVisualMeta {
  let group: SlashCommandGroupKey = "plugin";
  let groupLabel = "插件扩展";
  let badgeLabel = "插件";
  let tone: SlashCommandBadgeTone = "plugin";

  if (command.source === "builtin") {
    group = "core";
    groupLabel = "常用指令";
    badgeLabel = "内置";
    tone = "builtin";
  } else if (command.source === "plan") {
    group = "core";
    groupLabel = "常用指令";
    badgeLabel = "计划";
    tone = "feature";
  } else if (command.source === "intelligent-ui") {
    group = "core";
    groupLabel = "常用指令";
    badgeLabel = "界面";
    tone = "feature";
  } else if (command.source === "skill" || command.name.startsWith("skill:")) {
    group = "skill";
    groupLabel = "工作区技能";
    badgeLabel = "技能";
    tone = "skill";
  } else if (command.source === "mcp" || command.name.startsWith("mcp-")) {
    group = "system";
    groupLabel = "MCP 与诊断";
    badgeLabel = "MCP";
    tone = "mcp";
  } else if (command.source === "browser") {
    group = "system";
    groupLabel = "MCP 与诊断";
    badgeLabel = "诊断";
    tone = "diagnostic";
  }

  return {
    group,
    groupLabel,
    badgeLabel,
    tone,
    Icon: COMMAND_ICON_BY_NAME[command.name] ?? iconForTone(tone),
  };
}

/** Normalize raw command descriptions by removing inline Markdown backticks and excess spacing. */
export function formatCommandDescription(raw: string | undefined, fallback: string): string {
  const cleaned = (raw ?? "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}

function compareCoreOrder(left: SlashCommand, right: SlashCommand, group: SlashCommandGroupKey): number {
  if (group !== "core") return 0;
  const leftOrder = CORE_COMMAND_ORDER.indexOf(left.name as (typeof CORE_COMMAND_ORDER)[number]);
  const rightOrder = CORE_COMMAND_ORDER.indexOf(right.name as (typeof CORE_COMMAND_ORDER)[number]);
  const leftRank = leftOrder === -1 ? 999 : leftOrder;
  const rightRank = rightOrder === -1 ? 999 : rightOrder;
  return leftRank - rightRank;
}

/** Filter and rank slash commands by exact/prefix/sub-token/substring/description match. */
export function filterAndRankSlashCommands(
  commands: SlashCommand[],
  query: string | null,
  limit = MAX_COMMAND_MATCHES,
): SlashCommand[] {
  if (query === null) return [];
  const q = query.trim().toLowerCase();

  if (q === "") {
    return commands
      .map((command) => ({ command, meta: resolveSlashCommandMeta(command) }))
      .sort(
        (left, right) =>
          GROUP_RANK[left.meta.group] - GROUP_RANK[right.meta.group] ||
          compareCoreOrder(left.command, right.command, left.meta.group) ||
          left.command.name.localeCompare(right.command.name),
      )
      .slice(0, limit)
      .map((item) => item.command);
  }

  const scored: Array<{ command: SlashCommand; meta: SlashCommandVisualMeta; score: number }> = [];
  for (const command of commands) {
    const nameLower = command.name.toLowerCase();
    const descLower = (command.description ?? "").toLowerCase();
    const meta = resolveSlashCommandMeta(command);
    const badgeLower = meta.badgeLabel.toLowerCase();

    let score: number | null = null;
    if (nameLower === q) score = 0;
    else if (nameLower.startsWith(q)) score = 1;
    else if (nameLower.split(/[:-]/).slice(1).some((part) => part.startsWith(q))) score = 2;
    else if (nameLower.includes(q)) score = 3;
    else if (descLower.includes(q) || badgeLower.includes(q)) score = 4;

    if (score !== null) scored.push({ command, meta, score });
  }

  return scored
    .sort(
      (left, right) =>
        left.score - right.score ||
        GROUP_RANK[left.meta.group] - GROUP_RANK[right.meta.group] ||
        compareCoreOrder(left.command, right.command, left.meta.group) ||
        left.command.name.localeCompare(right.command.name),
    )
    .slice(0, limit)
    .map((item) => item.command);
}

/** Split text into matched/unmatched segments for the first case-insensitive query occurrence. */
export function splitHighlightSegments(
  text: string,
  query: string | null,
): Array<{ text: string; matched: boolean }> {
  const q = query?.trim() ?? "";
  if (!q) return [{ text, matched: false }];
  const index = text.toLowerCase().indexOf(q.toLowerCase());
  if (index < 0) return [{ text, matched: false }];

  const segments: Array<{ text: string; matched: boolean }> = [];
  if (index > 0) segments.push({ text: text.slice(0, index), matched: false });
  segments.push({ text: text.slice(index, index + q.length), matched: true });
  if (index + q.length < text.length) segments.push({ text: text.slice(index + q.length), matched: false });
  return segments;
}

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
  const hasQuery = Boolean(commandQuery && commandQuery.trim() !== "");
  const commandEntries = commandMatches.map((command) => ({
    command,
    meta: resolveSlashCommandMeta(command),
  }));
  const showGroupHeaders = !hasQuery && new Set(commandEntries.map((item) => item.meta.group)).size >= 2;

  return (
    <>
      {commandMenuOpen && (
        <div className="command-menu" ref={suggestionMenuRef}>
          <div className="command-menu-header" aria-hidden="true">
            <span className="command-menu-title">
              {hasQuery ? "匹配指令" : "快捷指令"}
              <span className="command-menu-count">{commandMatches.length}</span>
            </span>
            <span className="command-menu-shortcuts">
              <span><kbd>↑↓</kbd> 选择</span>
              <span><kbd>↵</kbd> 填入</span>
              <span><kbd>Esc</kbd> 关闭</span>
            </span>
          </div>
          <div className="command-menu-list" id={suggestionsId} role="listbox" aria-label="快捷指令">
            {commandEntries.map(({ command, meta }, index) => {
              const prevGroup = index > 0 ? commandEntries[index - 1]?.meta.group : undefined;
              const isActive = command === activeCommand;
              const { Icon } = meta;
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
                    onMouseEnter={() => setSuggestionIndex(index)}
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
                      <span className="command-item-desc">
                        {formatCommandDescription(command.description, meta.badgeLabel)}
                      </span>
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
        </div>
      )}

      {mentionMenuOpen && (
        <div className="command-menu mention-menu" ref={suggestionMenuRef}>
          <div className="command-menu-header" aria-hidden="true">
            <span className="command-menu-title">
              {mentionQuery?.endsWith("/") ? mentionQuery : "引用文件与目录"}
            </span>
            <span className="command-menu-shortcuts">
              <span><kbd>↵</kbd> 引用</span>
              <span><kbd>Tab</kbd> 进入目录</span>
            </span>
          </div>
          <div className="command-menu-list" id={suggestionsId} role="listbox" aria-label="引用文件">
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
                  title={entry.path}
                  onMouseEnter={() => setSuggestionIndex(index)}
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
        </div>
      )}
    </>
  );
}
