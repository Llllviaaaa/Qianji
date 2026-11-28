/**
 * Chinese UI labels, 6-role descriptions, status mappings, Markdown board helpers,
 * and unified diff line parsers for Qianji Swarm (`src/builtin-plugins/swarm/swarmLabels.ts`).
 */
import type { BadgeVariant, SelectOption } from "@qianji/client-primitives";
import type {
  SwarmAlertKind,
  SwarmBoardMessage,
  SwarmMemberRole,
  SwarmMemberState,
  SwarmRunStatus,
  SwarmWorkspaceMode,
} from "@qianji/protocol";

export const RUN_STATUS_LABELS: Readonly<Record<SwarmRunStatus, string>> = {
  running: "运行中",
  paused: "已暂停",
  completed: "已完成",
  stopped: "已停止",
};

export const RUN_STATUS_VARIANTS: Readonly<Record<SwarmRunStatus, BadgeVariant>> = {
  running: "brand",
  paused: "warning",
  completed: "success",
  stopped: "neutral",
};

export const MEMBER_ROLE_LABELS: Readonly<Record<SwarmMemberRole, string>> = {
  coordinator: "协调者",
  explorer: "调研",
  planner: "规划",
  worker: "编码",
  verifier: "质检",
  monitor: "监控",
};

export interface SwarmRoleSpec {
  readonly role: SwarmMemberRole;
  readonly title: string;
  readonly shortLabel: string;
  readonly badgeVariant: BadgeVariant;
  readonly description: string;
}

export const SWARM_ROLE_SPECS: readonly SwarmRoleSpec[] = [
  {
    role: "coordinator",
    title: "主控协调者 (Coordinator)",
    shortLabel: "协调者",
    badgeVariant: "brand",
    description: "任务拆解、成员调度与最终汇总裁决",
  },
  {
    role: "planner",
    title: "架构规划师 (Planner)",
    shortLabel: "规划师",
    badgeVariant: "brand",
    description: "技术方案设计、接口契约与依赖规划",
  },
  {
    role: "worker",
    title: "并行编码员 (Worker)",
    shortLabel: "编码员",
    badgeVariant: "success",
    description: "独立 Git Worktree 代码实现与修改",
  },
  {
    role: "explorer",
    title: "只读调研员 (Explorer)",
    shortLabel: "调研员",
    badgeVariant: "neutral",
    description: "代码检索与资料调研（可配轻量快速模型省成本）",
  },
  {
    role: "verifier",
    title: "独立质检员 (Verifier)",
    shortLabel: "质检员",
    badgeVariant: "warning",
    description: "交叉审查 Diff 与自动化测试门禁（可配异构模型）",
  },
  {
    role: "monitor",
    title: "防卡死看门狗 (Monitor)",
    shortLabel: "看门狗",
    badgeVariant: "neutral",
    description: "死锁巡检与超时唤醒（可配极速轻量模型）",
  },
];

export const SWARM_EFFORT_OPTIONS: readonly SelectOption[] = [
  { value: "", label: "默认强度" },
  { value: "low", label: "低 (low)" },
  { value: "medium", label: "中 (medium)" },
  { value: "high", label: "高 (high)" },
];

export const MEMBER_STATE_LABELS: Readonly<Record<SwarmMemberState, string>> = {
  working: "推进中",
  waiting: "待命休眠",
  stalled: "响应超时",
  blocked: "等待确认",
  stopped: "已停止",
  killed: "已退役",
};

export const WORKSPACE_MODE_LABELS: Readonly<Record<SwarmWorkspaceMode, string>> = {
  inherit: "共享工作区",
  share: "独立 Worktree",
  branch: "独立分支",
};

export const ALERT_KIND_LABELS: Readonly<Record<SwarmAlertKind, string>> = {
  stall: "超时未响应",
  "worktree-conflict": "文件冲突",
  "member-error": "成员异常",
  "approval-needed": "等待审批",
};

export type BoardTextSegment =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "seq"; readonly value: string; readonly seq: number }
  | { readonly kind: "mention"; readonly value: string; readonly target: string }
  | { readonly kind: "tag"; readonly value: string; readonly tagKind: "done" | "stall" }
  | { readonly kind: "code"; readonly value: string };

const BOARD_TOKEN_REGEX = /(`[^`\n]+`|\[done\]|\[stall\]|#[1-9]\d*\b|@(?:all|#[a-zA-Z0-9_-]+|[a-zA-Z0-9][a-zA-Z0-9_-]*)(?![a-zA-Z0-9_/-]))/gi;

/**
 * Strip duplicate leading `@recipient` mentions from a board message body when
 * the row header already renders `@sender` and recipient pills.
 */
export function stripLeadingRecipientMentions(
  text: string,
  recipients: readonly string[],
  mentionAll: boolean,
): string {
  if (text === "" || (!mentionAll && recipients.length === 0)) return text;
  const allowed = new Set(recipients.map((r) => r.toLowerCase()));
  if (mentionAll) allowed.add("all");

  let rest = text.trimStart();
  let strippedAny = false;
  while (rest.startsWith("@")) {
    const match = /^@([a-zA-Z0-9][a-zA-Z0-9_-]*)(?![a-zA-Z0-9_/-])[\s,:：，]*/.exec(rest);
    if (match === null || match[1] === undefined) break;
    if (!allowed.has(match[1].toLowerCase())) break;
    rest = rest.slice(match[0].length);
    strippedAny = true;
  }
  return strippedAny && rest !== "" ? rest : text;
}

/**
 * Prepare Markdown body for `<Markdown>`: strips duplicate leading `@recipient`
 * and leading `[done]` / `[stall]` prefix tags already promoted to header badges.
 */
export function prepareBoardMarkdownBody(
  text: string,
  recipients: readonly string[],
  mentionAll: boolean,
): string {
  const withoutRecipients = stripLeadingRecipientMentions(text, recipients, mentionAll);
  const withoutTag = withoutRecipients.replace(/^\s*\[(?:done|stall)\][\s,:：，-]*/i, "");
  return withoutTag !== "" ? withoutTag : withoutRecipients;
}

/**
 * True ONLY when a board post is an actual `[done]` completion milestone rather than
 * an initial assignment brief mentioning `"[done]"` as an instruction example.
 */
export function isMilestoneDoneMessage(
  msg: SwarmBoardMessage & { readonly kind?: string },
): boolean {
  if (msg.kind === "brief") return false;
  const body = stripLeadingRecipientMentions(msg.text, msg.mentions, msg.mentionAll);
  return /^\s*\[done\]/i.test(body);
}

/**
 * True ONLY when a board post is an actual `[stall]` timeout alert rather than
 * a brief mentioning `"[stall]"` in instructions.
 */
export function isMilestoneStallMessage(
  msg: SwarmBoardMessage & { readonly kind?: string },
): boolean {
  if (msg.kind === "brief") return false;
  const body = stripLeadingRecipientMentions(msg.text, msg.mentions, msg.mentionAll);
  if (/^\s*\[stall\]/i.test(body)) return true;
  return msg.isStall && !/\[stall\]/i.test(body);
}

/**
 * Extract referenced `#seq` numbers outside fenced/inline code blocks so the message
 * header/reference bar can expose 1-click `#seq` jump pills alongside rich Markdown.
 */
export function extractBoardSeqRefs(text: string, selfSeq?: number): number[] {
  if (text === "") return [];
  const strippedCode = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]+`/g, " ");
  const seen = new Set<number>();
  const refs: number[] = [];
  for (const match of strippedCode.matchAll(/(?:^|[^a-zA-Z0-9_])#([1-9]\d*)\b/g)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const num = Number.parseInt(raw, 10);
    if (!Number.isFinite(num) || num <= 0 || num === selfSeq || seen.has(num)) continue;
    seen.add(num);
    refs.push(num);
    if (refs.length >= 6) break;
  }
  return refs;
}

export function tokenizeBoardMessageText(text: string): BoardTextSegment[] {
  if (text === "") return [];
  const segments: BoardTextSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(BOARD_TOKEN_REGEX)) {
    const raw = match[0];
    const index = match.index ?? 0;
    if (raw === undefined) continue;
    if (index > lastIndex) {
      segments.push({ kind: "text", value: text.slice(lastIndex, index) });
    }
    const lower = raw.toLowerCase();
    if (raw.startsWith("`") && raw.endsWith("`")) {
      segments.push({ kind: "code", value: raw });
    } else if (lower === "[done]") {
      segments.push({ kind: "tag", value: raw, tagKind: "done" });
    } else if (lower === "[stall]") {
      segments.push({ kind: "tag", value: raw, tagKind: "stall" });
    } else if (raw.startsWith("#")) {
      const seqNum = Number.parseInt(raw.slice(1), 10);
      if (Number.isFinite(seqNum) && seqNum > 0) {
        segments.push({ kind: "seq", value: raw, seq: seqNum });
      } else {
        segments.push({ kind: "text", value: raw });
      }
    } else if (raw.startsWith("@")) {
      segments.push({ kind: "mention", value: raw, target: raw.slice(1) });
    } else {
      segments.push({ kind: "text", value: raw });
    }
    lastIndex = index + raw.length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: "text", value: text.slice(lastIndex) });
  }
  return segments;
}

export type DiffRowKind = "add" | "del" | "hunk" | "meta" | "ctx";

export interface ParsedDiffRow {
  readonly kind: DiffRowKind;
  readonly lineNo: string;
  readonly text: string;
}

export function classifyDiffLine(line: string): DiffRowKind {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git") || line.startsWith("index ")) {
    return "meta";
  }
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

export function parseUnifiedDiffRows(diffText: string): ParsedDiffRow[] {
  const lines = diffText.replace(/\r\n/g, "\n").split("\n");
  const rows: ParsedDiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;

  for (const line of lines) {
    const kind = classifyDiffLine(line);
    if (kind === "hunk") {
      const hunkMatch = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
      if (hunkMatch !== null && hunkMatch[1] !== undefined && hunkMatch[2] !== undefined) {
        oldNo = Number.parseInt(hunkMatch[1], 10);
        newNo = Number.parseInt(hunkMatch[2], 10);
      }
      rows.push({ kind, lineNo: "⋯", text: line });
    } else if (kind === "meta") {
      rows.push({ kind, lineNo: "", text: line });
    } else if (kind === "add") {
      rows.push({ kind, lineNo: newNo > 0 ? String(newNo) : "+", text: line });
      if (newNo > 0) newNo += 1;
    } else if (kind === "del") {
      rows.push({ kind, lineNo: oldNo > 0 ? String(oldNo) : "-", text: line });
      if (oldNo > 0) oldNo += 1;
    } else {
      rows.push({ kind, lineNo: newNo > 0 ? String(newNo) : "", text: line });
      if (oldNo > 0) oldNo += 1;
      if (newNo > 0) newNo += 1;
    }
  }
  return rows;
}
