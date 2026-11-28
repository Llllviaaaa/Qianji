/**
 * `/` Slash Command & Skill Autocomplete Popover + Active Directive Chip
 * for `BotChatComposer` (`src/builtin-plugins/bot-mode/BotSlashPopover.tsx`).
 */
import { Fragment, type ReactElement } from "react";
import {
  Activity,
  Blocks,
  ListChecks,
  MessageSquarePlus,
  Minimize2,
  Puzzle,
  Slash,
  Sparkles,
  Terminal,
  X,
  type LucideIcon,
} from "lucide-react";

export interface BotSlashCommandItem {
  readonly name: string;
  readonly description?: string;
  readonly argsHint?: string;
  readonly source?: string;
}

export type BotCommandTone = "builtin" | "skill" | "plugin" | "mcp";

export interface BotSlashMeta {
  readonly group: "core" | "skill" | "plugin";
  readonly groupLabel: string;
  readonly badgeLabel: string;
  readonly tone: BotCommandTone;
  readonly displayName: string;
  readonly Icon: LucideIcon;
}

const CORE_ORDER = ["clear", "compact", "plan", "skills", "mcp", "doctor"] as const;

const ICON_BY_CMD: Record<string, LucideIcon> = {
  clear: MessageSquarePlus,
  compact: Minimize2,
  plan: ListChecks,
  doctor: Activity,
  skills: Sparkles,
  mcp: Blocks,
};

export function resolveBotSlashMeta(cmd: Pick<BotSlashCommandItem, "name" | "source">): BotSlashMeta {
  const source = cmd.source ?? "plugin";
  if (source === "skill" || cmd.name.startsWith("skill:")) {
    const slug = cmd.name.startsWith("skill:") ? cmd.name.slice(6) : cmd.name;
    return {
      group: "skill",
      groupLabel: "工作区技能",
      badgeLabel: "技能",
      tone: "skill",
      displayName: slug,
      Icon: Sparkles,
    };
  }
  if (source === "builtin" || source === "plan" || source === "intelligent-ui") {
    return {
      group: "core",
      groupLabel: "常用指令",
      badgeLabel: source === "plan" ? "计划" : "内置",
      tone: "builtin",
      displayName: cmd.name,
      Icon: ICON_BY_CMD[cmd.name] ?? Terminal,
    };
  }
  if (source === "mcp" || cmd.name.startsWith("mcp-")) {
    return {
      group: "plugin",
      groupLabel: "连接器与扩展",
      badgeLabel: "MCP",
      tone: "mcp",
      displayName: cmd.name,
      Icon: Blocks,
    };
  }
  return {
    group: "plugin",
    groupLabel: "连接器与扩展",
    badgeLabel: "扩展",
    tone: "plugin",
    displayName: cmd.name,
    Icon: ICON_BY_CMD[cmd.name] ?? Puzzle,
  };
}

const GROUP_RANK: Record<BotSlashMeta["group"], number> = {
  core: 0,
  skill: 1,
  plugin: 2,
};

export function filterBotSlashCommands(
  commands: readonly BotSlashCommandItem[],
  query: string | null,
  limit = 16,
): BotSlashCommandItem[] {
  if (query === null) return [];
  const q = query.trim().toLowerCase();
  if (q === "") {
    return [...commands]
      .map((cmd) => ({ cmd, meta: resolveBotSlashMeta(cmd) }))
      .sort((a, b) => {
        const g = GROUP_RANK[a.meta.group] - GROUP_RANK[b.meta.group];
        if (g !== 0) return g;
        if (a.meta.group === "core") {
          const ia = CORE_ORDER.indexOf(a.cmd.name as (typeof CORE_ORDER)[number]);
          const ib = CORE_ORDER.indexOf(b.cmd.name as (typeof CORE_ORDER)[number]);
          const ra = ia === -1 ? 99 : ia;
          const rb = ib === -1 ? 99 : ib;
          if (ra !== rb) return ra - rb;
        }
        return a.meta.displayName.localeCompare(b.meta.displayName);
      })
      .slice(0, limit)
      .map((x) => x.cmd);
  }

  const scored: Array<{ cmd: BotSlashCommandItem; meta: BotSlashMeta; score: number }> = [];
  for (const cmd of commands) {
    const meta = resolveBotSlashMeta(cmd);
    const fullLower = cmd.name.toLowerCase();
    const dispLower = meta.displayName.toLowerCase();
    const descLower = (cmd.description || "").toLowerCase();
    let score: number | null = null;
    if (dispLower === q || fullLower === q) score = 0;
    else if (dispLower.startsWith(q) || fullLower.startsWith(q)) score = 1;
    else if (dispLower.includes(q) || fullLower.includes(q)) score = 2;
    else if (descLower.includes(q) || meta.badgeLabel.toLowerCase().includes(q)) score = 3;
    if (score !== null) scored.push({ cmd, meta, score });
  }

  return scored
    .sort(
      (a, b) =>
        a.score - b.score ||
        GROUP_RANK[a.meta.group] - GROUP_RANK[b.meta.group] ||
        a.meta.displayName.localeCompare(b.meta.displayName),
    )
    .slice(0, limit)
    .map((x) => x.cmd);
}

export interface CommittedDraftDirective {
  readonly kind: "skill" | "command";
  readonly rawPrefix: string;
  readonly displayName: string;
  readonly description: string;
  readonly remainingDraft: string;
}

export function extractCommittedDraftDirective(
  draft: string,
  commands: readonly BotSlashCommandItem[],
): CommittedDraftDirective | null {
  const match = /^(\/([a-zA-Z0-9][a-zA-Z0-9:_-]*)\s+)([\s\S]*)$/.exec(draft);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const rawPrefix = match[1];
  const rawName = match[2];
  const remainingDraft = match[3] ?? "";
  const lower = rawName.toLowerCase();

  if (lower.startsWith("skill:") && rawName.length > 6) {
    const slug = rawName.slice(6);
    const matched = commands.find((c) => c.name.toLowerCase() === lower);
    return {
      kind: "skill",
      rawPrefix,
      displayName: slug,
      description: matched?.description || "按技能说明与规范执行本轮任务",
      remainingDraft,
    };
  }

  const directMatch =
    commands.find((c) => c.name.toLowerCase() === lower) ??
    commands.find((c) => c.name.toLowerCase() === `skill:${lower}`);

  if (!directMatch) {
    if (lower === "goal") {
      return {
        kind: "command",
        rawPrefix,
        displayName: "/goal",
        description: "设定长程自主推进目标并持续验收",
        remainingDraft,
      };
    }
    return null;
  }

  const isSkill = directMatch.source === "skill" || directMatch.name.startsWith("skill:");
  return {
    kind: isSkill ? "skill" : "command",
    rawPrefix,
    displayName: isSkill
      ? directMatch.name.startsWith("skill:")
        ? directMatch.name.slice(6)
        : directMatch.name
      : `/${directMatch.name}`,
    description: directMatch.description || (isSkill ? "已启用技能指引" : "执行快捷指令"),
    remainingDraft,
  };
}

export function BotActiveDirectiveChip({
  directive,
  onClear,
}: {
  readonly directive: CommittedDraftDirective;
  readonly onClear: () => void;
}): ReactElement {
  const isSkill = directive.kind === "skill";
  return (
    <span
      className={`qj-bot-directive-chip${isSkill ? " is-skill" : ""}`}
      data-testid="bot-composer-directive-chip"
      title={directive.description}
    >
      {isSkill ? (
        <Sparkles size={12} strokeWidth={2} className="qj-bot-directive-icon" aria-hidden="true" />
      ) : (
        <Slash size={12} strokeWidth={2} className="qj-bot-directive-icon" aria-hidden="true" />
      )}
      <span className="qj-bot-directive-kind">{isSkill ? "技能" : "指令"}</span>
      <span className="qj-bot-directive-name">{directive.displayName}</span>
      <button
        type="button"
        aria-label={`移除${isSkill ? "技能" : "指令"} ${directive.displayName}`}
        onClick={onClear}
      >
        <X size={11.5} strokeWidth={2.1} />
      </button>
    </span>
  );
}

export function BotSlashPopover(props: {
  readonly matches: readonly BotSlashCommandItem[];
  readonly activeIndex: number;
  readonly query: string;
  readonly listboxId: string;
  readonly onHoverIndex: (index: number) => void;
  readonly onSelect: (command: BotSlashCommandItem) => void;
}): ReactElement | null {
  const { matches, activeIndex, query, listboxId, onHoverIndex, onSelect } = props;
  if (matches.length === 0) return null;

  const hasQuery = query.trim() !== "";
  const entries = matches.map((cmd) => ({ cmd, meta: resolveBotSlashMeta(cmd) }));
  const showGroups = !hasQuery && new Set(entries.map((e) => e.meta.group)).size >= 2;

  return (
    <div
      className="qj-bot-slash-popover"
      id={listboxId}
      role="listbox"
      aria-label="快捷指令与技能"
      data-testid="bot-slash-popover"
    >
      <div className="qj-bot-slash-head">
        <span>{hasQuery ? "匹配技能与指令" : "技能与快捷指令"}</span>
        <span className="qj-bot-slash-shortcuts" aria-hidden="true">
          <kbd>↑↓</kbd> 选择 · <kbd>↵</kbd> 填入
        </span>
      </div>

      <div className="qj-bot-slash-list">
        {entries.map(({ cmd, meta }, idx) => {
          const prevGroup = idx > 0 ? entries[idx - 1]?.meta.group : undefined;
          const active = idx === activeIndex;
          const { Icon } = meta;
          const desc = (cmd.description || meta.badgeLabel).replace(/`([^`]+)`/g, "$1").trim();
          return (
            <Fragment key={`${cmd.source}-${cmd.name}`}>
              {showGroups && (idx === 0 || meta.group !== prevGroup) && (
                <div className="qj-bot-slash-group-label" role="presentation">
                  {meta.groupLabel}
                </div>
              )}
              <button
                type="button"
                role="option"
                id={`${listboxId}-${idx}`}
                aria-selected={active}
                className={`qj-bot-slash-item${active ? " active" : ""}`}
                onMouseEnter={() => onHoverIndex(idx)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onSelect(cmd)}
              >
                <span className="qj-bot-slash-icon" data-tone={meta.tone} aria-hidden="true">
                  <Icon size={14} strokeWidth={1.85} />
                </span>
                <span className="qj-bot-slash-body">
                  <span className="qj-bot-slash-topline">
                    <span className="qj-bot-slash-name">
                      <span className="qj-bot-slash-prefix">
                        {cmd.name.startsWith("skill:") ? "/skill:" : "/"}
                      </span>
                      {meta.displayName}
                    </span>
                    {cmd.argsHint && <span className="qj-bot-slash-args">{cmd.argsHint}</span>}
                  </span>
                  <span className="qj-bot-slash-desc">{desc}</span>
                </span>
                <span className="qj-bot-slash-badge" data-tone={meta.tone}>
                  {meta.badgeLabel}
                </span>
              </button>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
