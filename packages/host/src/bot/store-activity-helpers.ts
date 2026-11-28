/**
 * Muse-grade activity sanitization, Markdown stripping, dynamic local-date
 * bucketing (`今天` / `昨天` / `M月D日`), and outcome-aware trace step helpers
 * (`packages/host/src/bot/store-activity-helpers.ts`).
 */
import type {
  BotActivityEntry,
  BotActivityGroup,
  BotActivityTraceStep,
  BotActivityTraceStepIconKind,
} from "@qianji/protocol";
import { formatClock, type PersistedBotState } from "./defaults.ts";
import { truncateCodepoints } from "./store-turn-namer.ts";

const QUICK_OPTIONS_RE = /\[\[options:\s*[\s\S]*?\]\]/gi;
const WIDGET_TAG_RE = /\[\[hatch_widget:[\s\S]*?\]\]/gi;
const APOLOGY_OR_FILLER_PREFIX_RE =
  /^(?:(?:是我理解错了|我刚才看岔了|刚才看错了|不好意思|抱歉)[，,。！!\s]*)+(?:抱歉[，,。！!\s]*)?|^(?:好的|好呀|收到|明白(?:了)?|没问题)[，,。！!\s]+/u;
const LEGACY_ROBOTIC_TITLE_RE = /^完成(?:主聊天|旁聊)回复$/;
const LEGACY_PURE_QA_TITLE_RE = /^(?:我说的是|我要用\s*grok|部署\s*deepseek)/i;

export function stripQuickOptionsAndWidgets(raw: string): { text: string; hasOptions: boolean } {
  const hasOptions = /\[\[options:\s*.+?\]\]/i.test(raw);
  const text = raw.replace(QUICK_OPTIONS_RE, "").replace(WIDGET_TAG_RE, "").trim();
  return { text, hasOptions };
}

export function stripMarkdownFormatting(raw: string): string {
  const { text } = stripQuickOptionsAndWidgets(raw);
  if (text === "") return "";

  const withoutCodeFences = text.replace(/```[\s\S]*?```/g, " ");
  const lines = withoutCodeFences
    .split(/\r?\n/)
    .map((line) => line.trim())
    // Drop Markdown table separator lines like | --- | :---: |
    .filter((line) => line !== "" && !/^\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?$/.test(line))
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, "")
        .replace(/^>\s*/, "")
        .replace(/^[-*•+]\s+/, "")
        .replace(/^\d+[.)、]\s+/, "")
        .replace(/\|/g, " "),
    );

  const joined = lines
    .join(" ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return joined.replace(APOLOGY_OR_FILLER_PREFIX_RE, "").trim() || joined;
}

export function extractCleanOutcomeSubtitle(
  rawAssistantText: string,
  fallback: string,
  maxChars = 68,
): { subtitle: string; waitingUser: boolean } {
  const { hasOptions } = stripQuickOptionsAndWidgets(rawAssistantText);
  const plain = stripMarkdownFormatting(rawAssistantText);
  if (plain === "") {
    return { subtitle: truncateCodepoints(stripMarkdownFormatting(fallback), maxChars), waitingUser: hasOptions };
  }

  const sentences = plain
    .split(/(?<=[。！？!?；;])\s*/)
    .map((s) => s.replace(/[:：]\s*$/, "").trim())
    .filter((s) => s !== "" && [...s].length >= 4);

  const preferred =
    sentences.find((s) => !/^(?:你说的应该是|我先确认一下|让我先看看)/.test(s)) ??
    sentences[0] ??
    plain;
  const waitingUser =
    hasOptions || /[？?]$|(?:等你确认|等待确认|确认后继续|点一下即可)/.test(sentences.at(-1) ?? plain);

  return {
    subtitle: truncateCodepoints(preferred.replace(/[。；;]+$/u, ""), maxChars),
    waitingUser,
  };
}

function startOfLocalDayMs(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function formatActivityDateBucket(createdAt: number, nowMs = Date.now()): string {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return "今天";
  const nowStart = startOfLocalDayMs(nowMs);
  const itemStart = startOfLocalDayMs(createdAt);
  const diffDays = Math.round((nowStart - itemStart) / 86_400_000);
  if (diffDays <= 0) return "今天";
  if (diffDays === 1) return "昨天";
  const dt = new Date(createdAt);
  const nowDt = new Date(nowMs);
  const m = dt.getMonth() + 1;
  const d = dt.getDate();
  return dt.getFullYear() === nowDt.getFullYear() ? `${m}月${d}日` : `${dt.getFullYear()}年${m}月${d}日`;
}

export function upsertActivityEntry(
  st: PersistedBotState,
  entry: BotActivityEntry,
  nowMs = Date.now(),
): BotActivityEntry {
  for (const group of st.activityGroups) {
    const existingIdx = group.items.findIndex(
      (item) =>
        item.id === entry.id ||
        (entry.turnStartSeq !== undefined &&
          entry.sessionId !== undefined &&
          item.sessionId === entry.sessionId &&
          item.turnStartSeq === entry.turnStartSeq),
    );
    if (existingIdx >= 0) {
      const prev = group.items[existingIdx];
      const merged: BotActivityEntry = prev
        ? {
            ...prev,
            ...entry,
            id: prev.id,
            createdAt: prev.createdAt,
            dateGroup: formatActivityDateBucket(prev.createdAt, nowMs),
            ...(entry.steps ?? prev.steps ? { steps: entry.steps ?? prev.steps } : {}),
          }
        : entry;
      group.items[existingIdx] = merged;
      st.activityGroups = regroupAndSanitizeActivities(st.activityGroups, nowMs);
      return merged;
    }
  }

  const bucket = formatActivityDateBucket(entry.createdAt, nowMs);
  const normalized: BotActivityEntry = {
    ...entry,
    dateGroup: bucket,
    timeLabel: entry.timeLabel || formatClock(entry.createdAt),
  };
  let targetGroup = st.activityGroups.find((g) => g.date === bucket);
  if (targetGroup === undefined) {
    targetGroup = { date: bucket, items: [] };
    st.activityGroups.unshift(targetGroup);
  }
  targetGroup.items.unshift(normalized);
  st.activityGroups = regroupAndSanitizeActivities(st.activityGroups, nowMs);
  return normalized;
}

export function regroupAndSanitizeActivities(
  groups: readonly BotActivityGroup[],
  nowMs = Date.now(),
): BotActivityGroup[] {
  const flat = groups
    .flatMap((g) => g.items ?? [])
    .filter((it) => Boolean(it && typeof it.id === "string" && typeof it.title === "string"))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const seenIds = new Set<string>();
  const quietPatrolDayKeys = new Set<number>();
  const kept: BotActivityEntry[] = [];
  const orphanSideEffects: BotActivityEntry[] = [];

  for (const raw of flat) {
    if (seenIds.has(raw.id)) continue;
    seenIds.add(raw.id);

    const cleanTitle = stripMarkdownFormatting(raw.title) || raw.title.trim();
    if (LEGACY_ROBOTIC_TITLE_RE.test(cleanTitle)) continue;
    if (
      !raw.handoff &&
      (raw.steps?.length ?? 0) === 0 &&
      (raw.kind === "chat" || raw.kind === undefined) &&
      (LEGACY_PURE_QA_TITLE_RE.test(cleanTitle) || /\*\*[^*]+\*\*/.test(raw.description)) &&
      raw.turnStartSeq !== undefined &&
      cleanTitle === truncateCodepoints(cleanTitle, 24) &&
      LEGACY_PURE_QA_TITLE_RE.test(cleanTitle)
    ) {
      continue;
    }

    if (cleanTitle === "专注期静默收纳巡检动态") {
      const dayKey = startOfLocalDayMs(raw.createdAt || nowMs);
      if (quietPatrolDayKeys.has(dayKey)) continue;
      quietPatrolDayKeys.add(dayKey);
    }

    const cleanSubtitle = truncateCodepoints(
      stripMarkdownFormatting(raw.subtitle ?? raw.description ?? ""),
      72,
    );
    const bucket = formatActivityDateBucket(raw.createdAt || nowMs, nowMs);
    const sanitized: BotActivityEntry = {
      ...raw,
      title: cleanTitle,
      dateGroup: bucket,
      subtitle: cleanSubtitle || cleanTitle,
      description: cleanSubtitle || cleanTitle,
      ...(cleanTitle === "专注期静默收纳巡检动态" || cleanTitle.includes("主动贴心巡检")
        ? { kind: raw.kind ?? "patrol" }
        : {}),
    };

    if (
      sanitized.sessionId === undefined &&
      (sanitized.title.startsWith("创建常驻空间：") || sanitized.title.startsWith("设定长期目标："))
    ) {
      orphanSideEffects.push(sanitized);
      continue;
    }
    kept.push(sanitized);
  }

  // Merge orphan same-minute goal/space entries into their parent turn card if one exists nearby.
  for (const orphan of orphanSideEffects) {
    const parent = kept.find(
      (it) =>
        it.sessionId !== undefined &&
        Math.abs((it.createdAt || 0) - (orphan.createdAt || 0)) <= 90_000,
    );
    if (parent !== undefined) {
      const isGoal = orphan.title.startsWith("设定长期目标：");
      const stepId = `side-effect-${orphan.id}`;
      const existingSteps = parent.steps ?? [];
      if (!existingSteps.some((s) => s.id === stepId || s.title === orphan.title)) {
        const nextStep: BotActivityTraceStep = {
          id: stepId,
          kind: "tool",
          iconKind: isGoal ? "goal" : "space",
          groupLabel: "自动沉淀与跟进",
          title: orphan.title,
          subtitle: orphan.subtitle ?? orphan.description,
          status: "completed",
          toolName: isGoal ? "bot_manage_goal" : "bot_manage_space",
          output: orphan.description,
        };
        parent.steps = [...existingSteps, nextStep];
      }
    } else {
      orphan.kind = orphan.title.startsWith("设定长期目标：") ? "goal" : "space";
      kept.push(orphan);
    }
  }

  kept.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const capped = kept.slice(0, 80);

  const byDate = new Map<string, BotActivityEntry[]>();
  for (const item of capped) {
    const bucket = formatActivityDateBucket(item.createdAt || nowMs, nowMs);
    item.dateGroup = bucket;
    const list = byDate.get(bucket);
    if (list) list.push(item);
    else byDate.set(bucket, [item]);
  }

  return [...byDate.entries()].map(([date, items]) => ({ date, items }));
}

export function describeToolStepOutcome(
  toolName: string,
  _args: Record<string, unknown>,
  baseTitle: string,
  res?: { text: string; isError: boolean },
): {
  title: string;
  subtitle: string;
  iconKind: BotActivityTraceStepIconKind;
  groupLabel?: string;
  reportMarkdown?: string;
} {
  const lower = toolName.toLowerCase();
  const isError = res?.isError === true;
  const rawText = res?.text?.trim() ?? "";

  let iconKind: BotActivityTraceStepIconKind = isError
    ? "error"
    : lower === "bot_manage_schedule"
      ? "schedule"
      : lower === "bot_sense_apps" || lower === "bot_stage_outbound_approval"
        ? "mail"
        : lower === "bot_manage_goal"
          ? "goal"
          : lower === "bot_manage_space"
            ? "space"
            : lower.startsWith("browser") || lower === "navigate" || lower === "screenshot"
              ? "browser"
              : lower === "read" || lower === "read_file" || lower === "write" || lower === "write_file" || lower === "edit" || lower === "edit_file" || lower === "glob" || lower === "ls" || lower === "list_dir"
                ? "file"
                : lower.includes("subagent") || lower.includes("delegate")
                  ? "subagent"
                  : "tool";

  const groupLabel =
    lower.includes("subagent") || lower.includes("delegate") ? "子智能体协作" : undefined;

  if (res === undefined) {
    return {
      title: baseTitle,
      subtitle: "正在执行该步骤…",
      iconKind,
      ...(groupLabel ? { groupLabel } : {}),
    };
  }

  if (isError) {
    iconKind = "error";
    const firstErrLine = stripMarkdownFormatting(rawText.split(/\r?\n/)[0] ?? "执行返回错误");
    return {
      title: `${baseTitle}（受阻）`,
      subtitle: truncateCodepoints(firstErrLine || "工具执行返回异常", 60),
      iconKind,
      ...(groupLabel ? { groupLabel } : {}),
      reportMarkdown: rawText ? `**执行受阻原因**\n\n${truncateCodepoints(rawText, 600)}` : undefined,
    };
  }

  if (lower === "grep" || lower === "search") {
    const empty = rawText === "" || /^(?:no matches|0 matches|未找到)/i.test(rawText);
    const lineCount = empty ? 0 : rawText.split(/\r?\n/).filter((l) => l.trim() !== "").length;
    return {
      title: baseTitle,
      subtitle: empty ? "未找到匹配结果" : `检索命中 ${lineCount} 行相关记录`,
      iconKind,
    };
  }

  if (lower === "bash" || lower === "powershell") {
    const cleanFirst = stripMarkdownFormatting(
      rawText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l !== "" && !/^\[exit code:/i.test(l)) ?? "",
    );
    return {
      title: baseTitle,
      subtitle: cleanFirst !== "" ? truncateCodepoints(cleanFirst, 60) : "命令执行完成（退出码 0）",
      iconKind,
    };
  }

  const cleanLine = stripMarkdownFormatting(rawText.split(/\r?\n/).find((l) => l.trim() !== "") ?? "");
  return {
    title: baseTitle,
    subtitle: cleanLine !== "" ? truncateCodepoints(cleanLine, 60) : "已完成步骤执行",
    iconKind,
    ...(groupLabel ? { groupLabel } : {}),
  };
}
