import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import {
  Activity,
  BarChart3,
  Blocks,
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
import { useSyncOnChange } from "../../hooks/useSyncOnChange";
import type { SlashCommand } from "../../types";
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

export interface CommandMenuLayoutPrefs {
  expanded: boolean;
  customWidth: number | null;
}

export const COMMAND_MENU_LAYOUT_STORAGE_KEY = "qianji:composer-command-menu-layout";
export const COMMAND_MENU_MIN_WIDTH = 380;
export const COMMAND_MENU_MAX_WIDTH = 1400;

const DEFAULT_COMMAND_MENU_LAYOUT: CommandMenuLayoutPrefs = {
  expanded: false,
  customWidth: null,
};

/** Parse persisted command-menu layout preferences safely and clamp custom width. */
export function parseCommandMenuLayoutPrefs(raw: string | null): CommandMenuLayoutPrefs {
  if (!raw) return DEFAULT_COMMAND_MENU_LAYOUT;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_COMMAND_MENU_LAYOUT;
    const record = parsed as Record<string, unknown>;
    const expanded = record.expanded === true;
    const rawWidth = record.customWidth;
    const customWidth =
      typeof rawWidth === "number" && Number.isFinite(rawWidth)
        ? Math.min(COMMAND_MENU_MAX_WIDTH, Math.max(COMMAND_MENU_MIN_WIDTH, Math.round(rawWidth)))
        : null;
    return { expanded, customWidth };
  } catch {
    return DEFAULT_COMMAND_MENU_LAYOUT;
  }
}

/** Read persisted command-menu layout preferences in browser environments. */
export function readCommandMenuLayoutPrefs(): CommandMenuLayoutPrefs {
  if (typeof window === "undefined") return DEFAULT_COMMAND_MENU_LAYOUT;
  try {
    return parseCommandMenuLayoutPrefs(window.localStorage.getItem(COMMAND_MENU_LAYOUT_STORAGE_KEY));
  } catch {
    return DEFAULT_COMMAND_MENU_LAYOUT;
  }
}

/** Persist command-menu layout preferences to localStorage safely. */
export function writeCommandMenuLayoutPrefs(prefs: CommandMenuLayoutPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COMMAND_MENU_LAYOUT_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage quota or private-mode errors.
  }
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

export interface SuggestionHoverPreview {
  key: string;
  title: string;
  argsHint?: string;
  badgeLabel?: string;
  description: string;
  placement: "above" | "below";
  offsetPx: number;
}

/** Manage command/mention popover expand state, edge drag-resizing, and truncated-row hover tooltip. */
export function useSuggestionMenuChrome({
  commandMenuOpen,
  mentionMenuOpen,
  commandQuery,
  mentionQuery,
  suggestionMenuRef,
}: {
  commandMenuOpen: boolean;
  mentionMenuOpen: boolean;
  commandQuery: string | null;
  mentionQuery: string | null;
  suggestionMenuRef: RefObject<HTMLDivElement | null>;
}) {
  const [layout, setLayout] = useState<CommandMenuLayoutPrefs>(() => readCommandMenuLayoutPrefs());
  const [isResizing, setIsResizing] = useState(false);
  const [hoverPreview, setHoverPreview] = useState<SuggestionHoverPreview | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const hoverTimerRef = useRef<number | null>(null);

  useSyncOnChange([commandMenuOpen, mentionMenuOpen, commandQuery, mentionQuery, layout.expanded], () => {
    setHoverPreview(null);
  });

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
    };
  }, [commandMenuOpen, mentionMenuOpen, commandQuery, mentionQuery, layout.expanded]);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  const updateLayout = (next: CommandMenuLayoutPrefs) => {
    setLayout(next);
    writeCommandMenuLayoutPrefs(next);
  };

  const isExpandedOrCustom = layout.expanded || layout.customWidth !== null;

  const handleToggleExpand = () => {
    updateLayout(isExpandedOrCustom ? { expanded: false, customWidth: null } : { expanded: true, customWidth: null });
  };

  const handleResetWidth = () => {
    updateLayout({ expanded: false, customWidth: null });
  };

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const menuEl = suggestionMenuRef.current;
    if (!menuEl) return;

    dragCleanupRef.current?.();

    const startX = event.clientX;
    const menuRect = menuEl.getBoundingClientRect();
    const boundaryEl =
      menuEl.closest<HTMLElement>(".side-chat-composer-dock, .main-stage") ?? document.documentElement;
    const boundaryRect = boundaryEl.getBoundingClientRect();
    const minWidth = Math.min(COMMAND_MENU_MIN_WIDTH, Math.max(280, Math.floor(boundaryRect.width - 24)));
    const maxWidth = Math.min(
      COMMAND_MENU_MAX_WIDTH,
      Math.max(minWidth, Math.floor(boundaryRect.right - menuRect.left - 16)),
    );

    let didMove = false;
    let latestWidth = Math.round(Math.min(maxWidth, Math.max(minWidth, menuRect.width)));
    setIsResizing(true);
    setHoverPreview(null);

    const onMove = (moveEvent: PointerEvent) => {
      if (!didMove && Math.abs(moveEvent.clientX - startX) < 2) return;
      didMove = true;
      latestWidth = Math.round(Math.min(maxWidth, Math.max(minWidth, moveEvent.clientX - menuRect.left)));
      setLayout({ expanded: false, customWidth: latestWidth });
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null;
    };

    const onEnd = () => {
      cleanup();
      setIsResizing(false);
      if (didMove) writeCommandMenuLayoutPrefs({ expanded: false, customWidth: latestWidth });
    };

    dragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  const clearHoverPreview = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoverPreview(null);
  };

  const scheduleHoverPreview = (
    buttonEl: HTMLButtonElement,
    nextPreview: Omit<SuggestionHoverPreview, "placement" | "offsetPx">,
  ) => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    const menuEl = suggestionMenuRef.current;
    if (!menuEl) return;
    const menuRect = menuEl.getBoundingClientRect();
    const rowRect = buttonEl.getBoundingClientRect();
    const placement: "above" | "below" = rowRect.top > 140 ? "above" : "below";
    const offsetPx =
      placement === "above"
        ? Math.max(0, Math.round(menuRect.bottom - rowRect.top + 6))
        : Math.max(0, Math.round(rowRect.bottom - menuRect.top + 6));
    const payload: SuggestionHoverPreview = { ...nextPreview, placement, offsetPx };

    if (hoverPreview !== null) {
      setHoverPreview(payload);
      return;
    }
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      setHoverPreview(payload);
    }, 120);
  };

  return {
    layout,
    isResizing,
    hoverPreview,
    isExpandedOrCustom,
    handleToggleExpand,
    handleResetWidth,
    handleResizePointerDown,
    clearHoverPreview,
    scheduleHoverPreview,
  };
}

