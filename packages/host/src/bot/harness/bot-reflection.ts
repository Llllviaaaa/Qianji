/**
 * Asynchronous post-turn reflection engine for `BotCompanionHarness`
 * (`packages/host/src/bot/harness/bot-reflection.ts`).
 *
 * Refines Stage-1 heuristic task titles/summaries & side-chat titles with full
 * semantic accuracy, while extracting enduring habits/preferences, `assistant_tracking`
 * multi-day goals (separating 1-line live blocker `summary` from full `description`),
 * goal progress milestones (`goalUpdates`), V2 Idea Blueprints (`capabilities` + `howItWorks`),
 * and topic spaces without blocking the reply stream.
 */
import type { Context } from "@deepseek-ai/cordis";
import { BlockAssembler } from "@qianji/llm";
import type {
  BotActivityEntry,
  BotActivityTraceStep,
  BotGoalMomentumStatus,
  BotIdeaCapabilityItem,
} from "@qianji/protocol";
import { currentBranch, type ModelRef, type Session } from "@qianji/session";
import type { PersistedBotState } from "../defaults.ts";
import { stripMarkdownFormatting } from "../store-activity-helpers.ts";
import { appendActivityRecord, createRichGoalRecord, createSpaceRecord, updateGoalRecord } from "../store-discovery.ts";
import { upsertPersonalizedIdeas } from "../store-ideas.ts";
import { rememberPreferenceEntry } from "../store-proactive.ts";
import {
  isTrivialGreetingText,
  isUntitledSideChatTitle,
  stripThinkAndConnectorNoise,
  truncateCodepoints,
} from "../store-turn-namer.ts";

interface ReflectionGoalDraft {
  title: string;
  category?: string;
  summary?: string;
  description?: string;
  momentumStatus?: BotGoalMomentumStatus;
}

interface ReflectionGoalUpdate {
  id?: string;
  title?: string;
  summary: string;
  momentumStatus?: BotGoalMomentumStatus;
  timelineTitle: string;
  timelineDetail?: string;
  completed?: boolean;
}

interface ReflectionIdea {
  title: string;
  description: string;
  seedPrompt: string;
  icon?: string;
  sourceLabel?: string;
  reason?: string;
  howItWorks?: string;
  capabilities?: BotIdeaCapabilityItem[];
}

interface ReflectionOutput {
  taskTitle?: string | null;
  taskSummary?: string | null;
  sideChatTitle?: string | null;
  preferences?: string[];
  goals?: ReflectionGoalDraft[];
  goalUpdates?: ReflectionGoalUpdate[];
  ideas?: ReflectionIdea[];
  space?: { title: string; description?: string } | null;
}

const GENERIC_BANNED_TITLE_RE = /^完成(?:主聊天|旁聊)回复/;

function extractPartialJsonStringField(text: string, key: string): string | null {
  const re = new RegExp(`"${key}"\\s*:\\s*(?:"((?:\\\\.|[^"\\\\])*)"|null)`);
  const m = re.exec(text);
  if (!m || m[1] === undefined) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

function parseReflectionJson(raw: string): ReflectionOutput | null {
  const cleaned = stripThinkAndConnectorNoise(raw, false);
  const match = /\{[\s\S]*\}/.exec(cleaned);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as ReflectionOutput;
      }
    } catch {
      // Fall through to partial field recovery when stream was truncated mid-JSON.
    }
  }
  const taskTitle = extractPartialJsonStringField(cleaned, "taskTitle");
  const taskSummary = extractPartialJsonStringField(cleaned, "taskSummary");
  const sideChatTitle = extractPartialJsonStringField(cleaned, "sideChatTitle");
  if (taskTitle !== null || taskSummary !== null || sideChatTitle !== null) {
    return { taskTitle, taskSummary, sideChatTitle };
  }
  return null;
}

function findTurnActivityEntry(
  state: PersistedBotState,
  sessionId: string,
  activityId?: string,
  turnStartSeq?: number,
): BotActivityEntry | undefined {
  for (const group of state.activityGroups) {
    for (const item of group.items) {
      if (activityId && item.id === activityId) return item;
      if (turnStartSeq !== undefined && item.sessionId === sessionId && item.turnStartSeq === turnStartSeq) {
        return item;
      }
    }
  }
  return undefined;
}

export async function reflectOnSettledTurn(options: {
  ctx: Context;
  session: Session;
  state: PersistedBotState;
  memoryFile: string;
  botWorkspaceDir: string;
  reflectionModel?: ModelRef;
  activityId?: string;
  turnStartSeq?: number;
  onPersistAndNotify: (reason: string) => void;
}): Promise<boolean> {
  const model = options.reflectionModel ?? options.session.state().model;
  const llm = options.ctx.get("llm");
  if (!model || !llm) return false;

  const recentMsgs = options.session.state().messages.slice(-6);
  const lastUser = [...recentMsgs].reverse().find((m) => m.role === "user");
  const lastAssistant = [...recentMsgs].reverse().find((m) => m.role === "assistant");
  if (!lastUser || !lastAssistant) return false;

  const branch = currentBranch(options.session.events);
  const startSeq = options.turnStartSeq ?? 1;
  const turnTools = branch
    .filter((ev) => ev.seq >= startSeq && ev.type === "tool-call")
    .map((ev) => {
      if (ev.type !== "tool-call") return "";
      const argPreview = truncateCodepoints(JSON.stringify(ev.data.args), 80);
      return `${ev.data.name}(${argPreview})`;
    })
    .filter((s) => s !== "");

  const lastUserText = stripThinkAndConnectorNoise(
    lastUser.content.flatMap((b) => (b.type === "text" && b.meta !== true ? [b.text] : [])).join("\n"),
    true,
  );
  if (turnTools.length === 0 && recentMsgs.length <= 2 && isTrivialGreetingText(lastUserText)) {
    return false;
  }

  const transcriptLines = recentMsgs
    .map((m, idx) => {
      if (m.role !== "user" && m.role !== "assistant") return "";
      const txt = stripThinkAndConnectorNoise(
        m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n"),
        m.role === "user",
      );
      if (txt === "") return "";
      const tag = m.role === "user" ? "用户" : "分身";
      return `[${idx + 1}] ${tag}：${txt.slice(0, 600)}`;
    })
    .filter((line) => line !== "")
    .join("\n");

  const activeGoalLines = options.state.goals
    .filter((g) => g.status === "active")
    .slice(0, 8)
    .map((g) => `[${g.id}] ${g.title} — ${g.summary}`)
    .join("\n");

  const isSideChat = options.session.id !== options.state.mainSessionId;
  const system = [
    "You are the background semantic reflection module for Qianji Bot.",
    "Analyze the recent conversation exchange (including short follow-ups like '可以'/'好的' that confirm an earlier proposal), active goals, and tools called in the latest turn.",
    "Extract:",
    "- `taskTitle`: concise Chinese verb-object task title (6-18 chars, e.g. '查找 DeepSeek v4.1 平民硬件', '汇总 RTX Spark 独立评测', '安排每日晨间简报'). Return `null` ONLY for pure trivial greetings like '你好'. NEVER return '完成主聊天回复'.",
    "- `taskSummary`: concise 1-sentence Chinese factual summary of what was checked/executed and concluded (12-60 chars).",
    isSideChat
      ? "- `sideChatTitle`: concise Chinese topic title (6-16 chars) for this side thread."
      : "- `sideChatTitle`: null.",
    "- `preferences`: durable personal habits, quiet hours, or communication preferences explicitly mentioned by the user (short Chinese strings, empty array if none).",
    "- `goals`: when the turn mentions a new multi-day objective OR leaves an unfinished task waiting on user confirmation/external action (e.g. verifying an account, checking an invoice, completing phone verification, multi-day delivery) NOT already in active goals (max 1, empty array if none), return [{\"title\":\"...\",\"category\":\"效率提升|金融|职业|健康|其他\",\"summary\":\"1-line live blocker / next-step status (e.g. '已备好核对步骤，等待确认后继续执行')\",\"description\":\"full context & constraints\",\"momentumStatus\":\"waiting_user|on_track\"}].",
    "- `goalUpdates`: if the turn advances or completes an existing active goal, return [{\"id\":\"goal-...\",\"title\":\"...\",\"summary\":\"updated 1-line status\",\"momentumStatus\":\"on_track|waiting_user|stalled\",\"timelineTitle\":\"milestone title\",\"timelineDetail\":\"detail\",\"completed\":false}] (empty array if none).",
    "- `ideas`: max 2 hyper-specific follow-up '我可以...' / '给你一份...' Idea Blueprints grounded in concrete details from the conversation, each with {\"title\",\"description\",\"seedPrompt\",\"icon\",\"sourceLabel\",\"reason\",\"howItWorks\":\"step-by-step execution plan\",\"capabilities\":[{\"kind\":\"doc|space|schedule|goal|workbench\",\"title\":\"...\",\"subtitle\":\"...\",\"ready\":true}]} (empty array if none).",
    "- `space`: ongoing topic space worth tracking if one emerged cleanly, otherwise null.",
    'Respond STRICTLY with JSON: {"taskTitle":null,"taskSummary":null,"sideChatTitle":null,"preferences":[],"goals":[],"goalUpdates":[],"ideas":[],"space":null}',
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  const assembler = new BlockAssembler();
  try {
    try {
      for await (const chunk of llm.stream(
        {
          provider: model.provider,
          model: model.model,
          sessionId: `${options.session.id}:reflect`,
          effort: "low",
          system,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: [
                    `最近对话记录：\n${transcriptLines}`,
                    activeGoalLines !== "" ? `当前活跃目标：\n${activeGoalLines}` : "当前活跃目标：（无）",
                    turnTools.length > 0 ? `本轮调用工具：${turnTools.join(", ")}` : "本轮调用工具：（无）",
                  ].join("\n\n"),
                },
              ],
            },
          ],
        },
        controller.signal,
      )) {
        assembler.push(chunk);
      }
    } catch {
      // Even if aborted mid-stream, try salvaging leading fields accumulated so far.
    }
    const result = assembler.result();
    const rawText = result.message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    const extracted = parseReflectionJson(rawText);
    if (!extracted) return false;

    let changed = false;
    const targetEntry = findTurnActivityEntry(options.state, options.session.id, options.activityId, options.turnStartSeq);
    const sideEffectSteps: BotActivityTraceStep[] = [];
    const cleanTitle =
      typeof extracted.taskTitle === "string" && !GENERIC_BANNED_TITLE_RE.test(extracted.taskTitle.trim())
        ? truncateCodepoints(stripMarkdownFormatting(extracted.taskTitle.trim()), 24)
        : "";
    if (targetEntry !== undefined && cleanTitle !== "" && targetEntry.title !== cleanTitle) {
      targetEntry.title = cleanTitle;
      changed = true;
    }

    const cleanSummary =
      typeof extracted.taskSummary === "string"
        ? truncateCodepoints(stripMarkdownFormatting(extracted.taskSummary.trim()), 96)
        : "";
    if (targetEntry !== undefined && cleanSummary !== "" && targetEntry.description !== cleanSummary) {
      targetEntry.subtitle = cleanSummary;
      targetEntry.description = cleanSummary;
      changed = true;
    }

    const side = options.state.sideThreads.find((t) => t.sessionId === options.session.id);
    if (side !== undefined && side.source !== "scheduled") {
      if (side.userRenamed !== true) {
        const rawSideTitle =
          typeof extracted.sideChatTitle === "string" && extracted.sideChatTitle.trim() !== ""
            ? extracted.sideChatTitle.trim()
            : isUntitledSideChatTitle(side.title) || (side.messageCount ?? 0) <= 2
              ? cleanTitle
              : "";
        const nextSideTitle = truncateCodepoints(rawSideTitle, 22);
        if (nextSideTitle !== "" && !GENERIC_BANNED_TITLE_RE.test(nextSideTitle) && side.title !== nextSideTitle) {
          side.title = nextSideTitle;
          options.session.append("label", { title: nextSideTitle });
          changed = true;
        }
      }
      if (cleanSummary !== "" && side.snippet !== cleanSummary) {
        side.snippet = cleanSummary;
        changed = true;
      }
    }

    for (const pref of (extracted.preferences ?? []).slice(0, 3)) {
      if (typeof pref === "string" && rememberPreferenceEntry(options.state, options.memoryFile, pref)) {
        changed = true;
      }
    }

    for (const upd of (extracted.goalUpdates ?? []).slice(0, 3)) {
      if (!upd || typeof upd.summary !== "string" || upd.summary.trim() === "") continue;
      const idQuery = typeof upd.id === "string" ? upd.id.trim() : "";
      const titleQuery = typeof upd.title === "string" ? upd.title.trim().toLowerCase() : "";
      const matched = options.state.goals.find(
        (g) =>
          g.status !== "completed" &&
          ((idQuery !== "" && g.id === idQuery) ||
            (titleQuery !== "" &&
              (g.title.toLowerCase().includes(titleQuery) || titleQuery.includes(g.title.toLowerCase())))),
      );
      if (matched !== undefined) {
        const tlTitle =
          typeof upd.timelineTitle === "string" && upd.timelineTitle.trim() !== ""
            ? upd.timelineTitle.trim()
            : `推进进展：${truncateCodepoints(upd.summary.trim(), 24)}`;
        const momentum: BotGoalMomentumStatus | undefined =
          upd.momentumStatus === "on_track" || upd.momentumStatus === "waiting_user" || upd.momentumStatus === "stalled"
            ? upd.momentumStatus
            : undefined;
        updateGoalRecord(options.state, {
          id: matched.id,
          summary: upd.summary.trim(),
          ...(momentum !== undefined ? { momentumStatus: momentum } : {}),
          ...(upd.completed === true ? { status: "completed" } : {}),
          timelineEntry: {
            title: tlTitle,
            detail:
              typeof upd.timelineDetail === "string" && upd.timelineDetail.trim() !== ""
                ? upd.timelineDetail.trim()
                : upd.summary.trim(),
          },
        });
        sideEffectSteps.push({
          id: `reflect-goal-upd-${matched.id}`,
          kind: "tool",
          iconKind: "goal",
          groupLabel: "自动沉淀与跟进",
          title: upd.completed === true ? `完成长期目标：${matched.title}` : `推进目标：${matched.title}`,
          subtitle: truncateCodepoints(upd.summary.trim(), 60),
          status: "completed",
          toolName: "bot_manage_goal",
          output: `${tlTitle}\n${upd.summary.trim()}`,
        });
        changed = true;
      }
    }

    let createdGoalTitle = "";
    for (const g of (extracted.goals ?? []).slice(0, 1)) {
      if (
        g &&
        typeof g.title === "string" &&
        g.title.trim() !== "" &&
        !options.state.goals.some((existing) => existing.title.toLowerCase() === g.title.trim().toLowerCase())
      ) {
        const liveSummary =
          typeof g.summary === "string" && g.summary.trim() !== ""
            ? g.summary.trim()
            : cleanSummary !== ""
              ? cleanSummary
              : "已备好前置梳理步骤，等待下一步确认后继续推进";
        const fullDescription =
          typeof g.description === "string" && g.description.trim() !== ""
            ? g.description.trim()
            : truncateCodepoints(lastUserText, 240);
        const momentum: BotGoalMomentumStatus =
          g.momentumStatus === "on_track" || g.momentumStatus === "waiting_user" || g.momentumStatus === "stalled"
            ? g.momentumStatus
            : "waiting_user";
        const createdGoal = createRichGoalRecord(
          options.state,
          options.botWorkspaceDir,
          {
            title: g.title.trim(),
            category: g.category?.trim() || "日常跟进",
            summary: liveSummary,
            ...(fullDescription !== "" ? { description: fullDescription } : {}),
            source: "assistant_tracking",
            momentumStatus: momentum,
            sessionId: options.session.id,
          },
          { recordActivity: false },
        );
        createdGoalTitle = createdGoal.title;
        sideEffectSteps.push({
          id: `reflect-goal-${createdGoal.id}`,
          kind: "tool",
          iconKind: "goal",
          groupLabel: "自动沉淀与跟进",
          title: `设定长期目标：${createdGoal.title}`,
          subtitle: `${createdGoal.category} · ${truncateCodepoints(liveSummary, 52)}`,
          status: "completed",
          toolName: "bot_manage_goal",
          output: `${createdGoal.title}（${createdGoal.category}）\n${liveSummary}`,
        });
        changed = true;
      }
    }

    const validIdeas = (extracted.ideas ?? [])
      .filter(
        (it): it is ReflectionIdea =>
          Boolean(
            it &&
              typeof it.title === "string" &&
              it.title.trim() !== "" &&
              typeof it.description === "string" &&
              it.description.trim() !== "",
          ),
      )
      .slice(0, 2)
      .map((it) => ({
        icon: typeof it.icon === "string" && it.icon.trim() !== "" ? it.icon.trim() : "✦",
        title: it.title.trim(),
        description: it.description.trim(),
        seedPrompt: typeof it.seedPrompt === "string" && it.seedPrompt.trim() !== "" ? it.seedPrompt.trim() : it.title.trim(),
        ...(typeof it.sourceLabel === "string" && it.sourceLabel.trim() !== "" ? { sourceLabel: it.sourceLabel.trim() } : {}),
        reason:
          typeof it.reason === "string" && it.reason.trim() !== ""
            ? it.reason.trim()
            : "结合刚刚对话中的具体细节自动延伸构思",
        ...(typeof it.howItWorks === "string" && it.howItWorks.trim() !== "" ? { howItWorks: it.howItWorks.trim() } : {}),
        ...(Array.isArray(it.capabilities) ? { capabilities: it.capabilities } : {}),
      }));
    if (validIdeas.length > 0 && upsertPersonalizedIdeas(options.state, validIdeas).length > 0) {
      changed = true;
    }

    let createdSpaceTitle = "";
    if (
      extracted.space &&
      typeof extracted.space.title === "string" &&
      extracted.space.title.trim() !== "" &&
      !options.state.spaces.some((s) => s.title.toLowerCase() === extracted.space?.title.trim().toLowerCase())
    ) {
      const createdSpace = createSpaceRecord(
        options.state,
        options.botWorkspaceDir,
        extracted.space.title.trim(),
        extracted.space.description,
        { recordActivity: false },
      );
      createdSpaceTitle = createdSpace.title;
      sideEffectSteps.push({
        id: `reflect-space-${createdSpace.id}`,
        kind: "tool",
        iconKind: "space",
        groupLabel: "自动沉淀与跟进",
        title: `创建常驻空间：${createdSpace.title}`,
        subtitle: truncateCodepoints(createdSpace.description, 56),
        status: "completed",
        toolName: "bot_manage_space",
        output: `${createdSpace.title}\n${createdSpace.description}`,
      });
      changed = true;
    }

    if (sideEffectSteps.length > 0) {
      if (targetEntry !== undefined) {
        const existing = targetEntry.steps ?? [];
        targetEntry.steps = [
          ...existing,
          ...sideEffectSteps.filter((s) => !existing.some((e) => e.id === s.id)),
        ];
      } else {
        const fallbackTitle = createdGoalTitle
          ? `设定长期目标：${createdGoalTitle}`
          : createdSpaceTitle
            ? `创建常驻空间：${createdSpaceTitle}`
            : sideEffectSteps[0]?.title ?? "推进目标与记忆跟进";
        appendActivityRecord(options.state, {
          title: cleanTitle || fallbackTitle,
          description: cleanSummary || sideEffectSteps[0]?.subtitle || fallbackTitle,
          kind: createdGoalTitle ? "goal" : createdSpaceTitle ? "space" : "goal",
          sessionId: options.session.id,
          steps: sideEffectSteps,
        });
      }
      changed = true;
    }

    if (changed) options.onPersistAndNotify("reflection-updated");
    return changed;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
