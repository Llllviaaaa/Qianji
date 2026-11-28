/**
 * Context-aware Stage-1 turn activity & side-chat namer for `BotStateStore`
 * (`packages/host/src/bot/store-turn-namer.ts`).
 */
import { basename } from "node:path";
import type { BotActivityKind, BotActivityStatus } from "@qianji/protocol";
import type { SessionEvent } from "@qianji/session";
import {
  extractCleanOutcomeSubtitle,
  stripMarkdownFormatting,
  stripQuickOptionsAndWidgets,
} from "./store-activity-helpers.ts";

export type TurnActivityOutcome = "running" | "done" | "aborted" | "error";

export interface TurnRecordOptions {
  turnStartSeq?: number; turnEndSeq?: number; activityId?: string;
  outcome?: TurnActivityOutcome; status?: BotActivityStatus; activeToolName?: string;
}

export interface DerivedTurnActivitySummary {
  skipActivity: boolean; title: string; subtitle: string; description: string; snippet: string;
  statusTitle?: string; finishMessage?: string;
  sideAutoTitle?: string; status: BotActivityStatus; kind: BotActivityKind;
  hasError: boolean; turnStartSeq: number; turnEndSeq?: number; messageCount: number;
}

export const UNTITLED_SIDE_CHAT_RE = /^新(?:旁聊|任务)(?:\s*·.*)?$/;
const CONNECTOR_PREFIX_RE = /^\s*\[已关联连接器上下文:[^\]]*\]\s*/i;
const TRIVIAL_GREETING_RE = /^(?:你好|您好|嗨|在吗|早|hi|hey)[!！~～。.，,\s]*$/i;
const SHORT_CONFIRM_RE =
  /^(?:可以|好的?|行|没问题|嗯+|是的|对的?|继续|来吧|开始|安排|搞定|弄吧|帮我弄|查一下|看看|好呀|行啊)[，,。.!！~～\s]*/i;
const GENERIC_FOLLOWUP_RE =
  /^(?:(?:明早|明天|稍后|现在|直接|顺便|立刻|马上|尽快|先)?(?:帮我|替我|给我)?(?:整理|发|弄|做|汇总|总结|安排|搞定|处理|生成|看看|查查)(?:一下)?(?:给我|出来|好|吧)?|可以|好的?|行|没问题)$/u;
const POLITE_PREFIX_RE =
  /^(?:(?:你好|您好|嗨|请问(?:一下)?|我想问(?:一下)?|想问(?:一下)?|麻烦(?:你)?|能不能(?:请你)?|可以(?:请你)?|可不可以|请)[，,\s]*)*(?:帮我|替我|给我|为我|请你)?\s*/u;
const TRAILING_PARTICLE_RE =
  /[，,\s]*(?:好吗|好不好|可以吗|行吗|行不行|好吧|谢谢|感谢|拜托了?|[吗呢吧呀啊啦])[？?！!。.~～\s]*$/u;
const ACTION_VERB_HEAD_RE =
  /^(?:查看|检查|查找|检索|排查|分析|汇总|总结|整理|安排|创建|更新|修改|写入|删除|暂停|开启|启用|执行|运行|操作|拟定|起草|回复|核对|对比|追踪|跟进|规划|生成|梳理|评估|调研|同步|配置|设置|监控|浏览|读取|扫描|定位)/u;

export function isUntitledSideChatTitle(title: string): boolean {
  return UNTITLED_SIDE_CHAT_RE.test(title.trim());
}

const CLOSED_INLINE_THINK_RE = /<(think(?:ing)?|thought)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi;
const UNCLOSED_INLINE_THINK_RE = /<(?:think(?:ing)?|thought)(?:\s[^>]*)?>[\s\S]*$/i;

export function stripThinkAndConnectorNoise(raw: string, stripConnector = false): string {
  let cleaned = raw.replace(CLOSED_INLINE_THINK_RE, "").replace(UNCLOSED_INLINE_THINK_RE, "");
  if (stripConnector) cleaned = cleaned.replace(CONNECTOR_PREFIX_RE, "");
  return cleaned.trim();
}

export function truncateCodepoints(raw: string, maxChars: number): string {
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (normalized === "") return "";
  const chars = [...normalized];
  return chars.length <= maxChars ? normalized : `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}…`;
}

export function isTrivialGreetingText(raw: string): boolean {
  const cleaned = stripThinkAndConnectorNoise(raw, true);
  return cleaned === "" || ([...cleaned].length < 4 && TRIVIAL_GREETING_RE.test(cleaned));
}

function shortPathName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return "";
  const trimmed = value.trim().replace(/[\\/]+$/, "");
  return basename(trimmed) || trimmed;
}

const SENSE_LABELS: Record<string, string> = {
  all: "邮件与日程", email: "收件箱邮件", calendar: "今日日程",
  processes: "进程专注状态", meetings_im: "会议与消息", github: "GitHub 仓库", notion: "Notion 页面",
};

const STATIC_BOT_TOOL_LABELS: Record<string, string> = {
  bot_manage_goal: "更新长期追踪目标",
  bot_manage_space: "同步常驻空间记录",
  bot_publish_briefing: "生成主动简报卡片",
  bot_remember_preference: "沉淀个人习惯记忆",
  bot_watch_process: "配置本机进程盯守",
};

export function describeToolCallTitle(toolName: string, args: Record<string, unknown>): string {
  const lower = toolName.toLowerCase();
  if (lower === "bot_manage_schedule") {
    const act = String(args.action ?? "create");
    const taskName = typeof args.name === "string" && args.name.trim() !== "" ? truncateCodepoints(args.name, 14) : "";
    const suffix = taskName !== "" ? `：${taskName}` : "";
    if (act === "list") return "查看预定任务列表";
    if (act === "delete") return `删除预定任务${suffix}`;
    if (act === "toggle") return `${args.enabled === false ? "暂停" : args.enabled === true ? "启用" : "切换"}预定任务${suffix || "状态"}`;
    if (act === "run_now") return `立即运行预定任务${suffix}`;
    if (act === "update") return `更新预定任务${suffix}`;
    return taskName !== "" ? `安排预定任务：${taskName}` : "创建预定任务";
  }
  if (lower === "bot_sense_apps") return `检查${SENSE_LABELS[String(args.source ?? "all")] ?? "应用"}动态`;
  if (lower === "bot_stage_outbound_approval") {
    const t = typeof args.title === "string" && args.title.trim() !== "" ? truncateCodepoints(args.title, 14) : "";
    return t !== "" ? `拟定待批草稿：${t}` : "拟定待批准外发草稿";
  }
  if (STATIC_BOT_TOOL_LABELS[lower]) return STATIC_BOT_TOOL_LABELS[lower];

  const targetFile = shortPathName(args.path ?? args.file_path ?? args.filePath ?? args.target);
  if (lower === "read" || lower === "read_file") return `查阅 ${targetFile || "文件"}`;
  if (lower === "write" || lower === "write_file") return `写入 ${targetFile || "文件"}`;
  if (lower === "edit" || lower === "edit_file") return `修改 ${targetFile || "文件"}`;
  if (lower === "glob" || lower === "ls" || lower === "list_dir") {
    return `扫描目录 ${targetFile || truncateCodepoints(String(args.pattern ?? "工作区"), 22)}`;
  }
  if (lower === "grep" || lower === "search") return `检索内容 ${truncateCodepoints(String(args.pattern ?? args.query ?? "关键词"), 22)}`;
  if (lower === "bash" || lower === "powershell") {
    const cmd = typeof args.command === "string" ? truncateCodepoints(args.command, 28) : "";
    return cmd !== "" ? `执行命令：${cmd}` : `执行 ${toolName} 命令`;
  }
  if (lower.startsWith("browser") || lower === "navigate" || lower === "screenshot") return `操作浏览器 (${toolName})`;
  if (lower.startsWith("mcp__")) return `调用连接器工具 ${toolName.replace(/^mcp__[^_]+__/, "")}`;
  return `调用工具 ${toolName}`;
}

function smartTrimTaskTitle(phrase: string, maxChars = 22): string {
  const compact = phrase.replace(/\s+/g, " ").trim();
  const chars = [...compact];
  if (chars.length <= maxChars) return compact;
  const windowStr = chars.slice(0, maxChars + 1).join("");
  for (const sep of ["，", "、", "并", "的", "与", "及"]) {
    const idx = windowStr.lastIndexOf(sep);
    if (idx >= 8 && idx <= maxChars) return windowStr.slice(0, idx).trim();
  }
  return `${chars.slice(0, maxChars - 1).join("")}…`;
}

function normalizeTaskPhrase(raw: string): string {
  const firstLine =
    raw.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, "").replace(/^[-*•\d.)\s]+/, "").trim()).find((l) => l !== "") ?? "";
  if (firstLine === "") return "";
  const wasQuestion = /[？?]|(?:有哪些|是什么|怎么|如何|多少|为什么)/.test(firstLine);
  let text = firstLine
    .replace(/^["'“”‘’「『]+|["'“”‘’」』]+$/g, "")
    .replace(
      /^(?:每天|每日|每周[一二三四五六日天]?|每个?工作日|每\s*\d+\s*(?:分钟|小时)|明天|明早|今天|今晚|半小时后|\d+\s*(?:分钟|小时)后)(?:早上|上午|中午|下午|晚上|凌晨)?\s*(?:\d{1,2}(?:[:点时]\d{0,2})?\s*分?)?\s*/u,
      (m) => (/提醒|汇总|检查|巡检|整理|发送|同步/.test(firstLine) ? "" : m),
    )
    .replace(POLITE_PREFIX_RE, "")
    .replace(/^(?:先|再|顺便|直接|马上|立刻|赶紧)\s*/u, "")
    .replace(/^看一下|^看看/u, "查看")
    .replace(/^查一下|^查查|^搜一下|^找一下/u, "查找")
    .replace(/^检查一下/u, "检查")
    .replace(/^汇总一下|^总结一下/u, "汇总")
    .replace(/^整理一下/u, "整理")
    .replace(/^分析一下/u, "分析")
    .replace(/^安排一下/u, "安排")
    .replace(/^核对一下/u, "核对")
    .replace(/^梳理一下/u, "梳理")
    .replace(/^([^\s]{2})一下\s*/u, "$1")
    .replace(/(?:有哪些|是什么|怎么样|如何)[？?！!。.\s]*$/u, "")
    .replace(TRAILING_PARTICLE_RE, "")
    .replace(/[？?！!。.,，；;：:~～]+$/u, "")
    .trim();

  if (text === "") return "";
  if (wasQuestion && !ACTION_VERB_HEAD_RE.test(text) && [...text].length <= 18) text = `查找 ${text}`.replace(/\s+/g, " ");
  else if (!ACTION_VERB_HEAD_RE.test(text) && [...text].length < 6) text = `处理${text}`;
  return smartTrimTaskTitle(text, 22);
}

function extractProposalFromAssistant(prevAssistantText: string): string {
  const cleaned = stripThinkAndConnectorNoise(prevAssistantText, false);
  if (cleaned === "") return "";
  const sentences = cleaned.split(/[\r\n。！!]+/).map((s) => s.trim()).filter((s) => s !== "");
  const candidate =
    [...sentences].reverse().find((s) => /[？?]|要不要|需要我|帮你|替你|为你|整理|汇总|检查|查找|安排|拟定|生成/.test(s)) ??
    sentences.at(-1) ??
    "";
  const match =
    /(?:要不要|需不需要|是否需要|需要|要不|可不可以|不如|接下来)[，,\s]*(?:让我|由我|我|分身)?(?:先|再|顺便|继续|立即|马上)?(?:帮你|替你|为你|给你)?\s*([^？?。！!\n]{4,60})/u.exec(candidate) ??
    /(?:我|分身)(?:可以|先|再)?(?:帮你|替你|为你)\s*([^？?。！!\n]{4,60})/u.exec(candidate);
  return normalizeTaskPhrase(match?.[1] ?? candidate);
}

export function deriveTurnActivitySummary(
  input: { branchEvents: readonly SessionEvent[]; isMain: boolean; sideTitle?: string } & TurnRecordOptions,
): DerivedTurnActivitySummary {
  const { branchEvents, activeToolName } = input;
  const outcome: TurnActivityOutcome =
    input.outcome ??
    (input.status === "running" ? "running" : input.status === "interrupted" ? "aborted" : input.status === "error" ? "error" : "done");

  let messageCount = 0;
  let lastUserSeq = 1;
  for (const ev of branchEvents) {
    if (ev.type === "user" || ev.type === "assistant") messageCount += 1;
    if (ev.type === "user") lastUserSeq = ev.seq;
  }

  const turnStartSeq = input.turnStartSeq ?? lastUserSeq;
  const effectiveEnd = input.turnEndSeq ?? branchEvents.at(-1)?.seq ?? turnStartSeq;
  let turnUserText = "";
  let prevAssistantText = "";
  let turnAssistantText = "";
  let turnErrorText = "";
  let hasError = outcome === "error";
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  for (const ev of branchEvents) {
    if (ev.seq < turnStartSeq) {
      if (ev.type === "assistant") {
        const txt = stripThinkAndConnectorNoise(ev.data.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n"), false);
        if (txt !== "") prevAssistantText = txt;
      }
      continue;
    }
    if (ev.seq > effectiveEnd) continue;
    if (ev.type === "user") {
      const txt = stripThinkAndConnectorNoise(ev.data.content.flatMap((b) => (b.type === "text" && b.meta !== true ? [b.text] : [])).join("\n"), true);
      if (txt !== "") turnUserText = txt;
    } else if (ev.type === "tool-call") {
      toolCalls.push({ name: ev.data.name, args: ev.data.args });
    } else if (ev.type === "assistant") {
      const txt = stripThinkAndConnectorNoise(ev.data.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n"), false);
      if (txt !== "") turnAssistantText = txt;
      if (ev.data.stop === "error" || ev.data.error !== undefined) {
        hasError = true;
        if (ev.data.error?.message) turnErrorText = ev.data.error.message;
      }
    }
  }

  const hasToolActivity = toolCalls.length > 0 || activeToolName !== undefined;
  const skipActivity = !hasToolActivity && outcome !== "error";
  const isShortReply = [...turnUserText].length <= 10 || SHORT_CONFIRM_RE.test(turnUserText);
  const strippedConfirm = turnUserText.replace(SHORT_CONFIRM_RE, "").trim();
  const needsPrevProposal =
    prevAssistantText !== "" &&
    isShortReply &&
    ([...strippedConfirm].length < 5 || GENERIC_FOLLOWUP_RE.test(strippedConfirm) || GENERIC_FOLLOWUP_RE.test(turnUserText));
  const userGoal = needsPrevProposal
    ? extractProposalFromAssistant(prevAssistantText) || normalizeTaskPhrase(strippedConfirm || turnUserText)
    : normalizeTaskPhrase(turnUserText);

  const schedCall = toolCalls.find((c) => c.name === "bot_manage_schedule");
  const approvalCall = toolCalls.find((c) => c.name === "bot_stage_outbound_approval");
  const senseCall = toolCalls.find((c) => c.name === "bot_sense_apps");
  const goalCall = toolCalls.find((c) => c.name === "bot_manage_goal");
  const spaceCall = toolCalls.find((c) => c.name === "bot_manage_space");
  let title = userGoal;
  if (schedCall !== undefined && String(schedCall.args.action ?? "create") !== "list") title = describeToolCallTitle(schedCall.name, schedCall.args);
  else if (approvalCall !== undefined && typeof approvalCall.args.title === "string" && [...title].length < 6) title = describeToolCallTitle(approvalCall.name, approvalCall.args);
  else if ([...title].length < 4 && senseCall !== undefined) title = describeToolCallTitle(senseCall.name, senseCall.args);
  else if ([...title].length < 4 && goalCall !== undefined) title = describeToolCallTitle(goalCall.name, goalCall.args);
  else if ([...title].length < 4 && spaceCall !== undefined) title = describeToolCallTitle(spaceCall.name, spaceCall.args);
  else if ([...title].length < 4 && toolCalls[0] !== undefined) title = smartTrimTaskTitle(describeToolCallTitle(toolCalls[0].name, toolCalls[0].args), 22);
  if (title === "") title = input.sideTitle && !isUntitledSideChatTitle(input.sideTitle) ? smartTrimTaskTitle(input.sideTitle, 22) : "梳理当前对话诉求";

  const toolNames = toolCalls.map((c) => c.name.toLowerCase());
  const kind: BotActivityKind = toolNames.includes("bot_manage_schedule")
    ? "scheduled"
    : toolNames.some((n) => n.startsWith("browser") || n === "navigate" || n === "screenshot")
      ? "browser"
      : toolNames.includes("bot_sense_apps") || toolNames.includes("bot_stage_outbound_approval")
        ? "mail"
        : toolNames.includes("bot_manage_goal")
          ? "goal"
          : toolNames.includes("bot_manage_space")
            ? "space"
            : "chat";
  const status: BotActivityStatus = outcome === "running" ? "running" : outcome === "aborted" ? "interrupted" : hasError ? "error" : "completed";
  const outcomeInfo = extractCleanOutcomeSubtitle(turnAssistantText, turnErrorText || turnUserText || title, 68);
  const snippet = truncateCodepoints(
    stripMarkdownFormatting(turnAssistantText || turnErrorText || turnUserText),
    96,
  );
  const activeCall = activeToolName ? [...toolCalls].reverse().find((c) => c.name === activeToolName) : toolCalls.at(-1);
  const description =
    outcome === "running"
      ? activeToolName
        ? `正在执行：${describeToolCallTitle(activeToolName, activeCall?.args ?? {})}`
        : activeCall
          ? `已完成步骤：${describeToolCallTitle(activeCall.name, activeCall.args)}`
          : "正在分析上下文并处理请求…"
      : outcomeInfo.subtitle || snippet || (outcome === "aborted" ? "本次任务已中止" : hasError ? "执行过程中遇到异常" : title);
  const cleanedFinish = outcome !== "running" ? stripQuickOptionsAndWidgets(turnAssistantText).text : "";

  return {
    skipActivity,
    title,
    subtitle: description,
    description,
    snippet,
    ...(outcome !== "running" && outcomeInfo.waitingUser ? { statusTitle: "等待确认" } : {}),
    ...(cleanedFinish !== "" ? { finishMessage: cleanedFinish.slice(0, 4000) } : {}),
    ...(title !== "" ? { sideAutoTitle: title } : {}),
    status,
    kind,
    hasError,
    turnStartSeq,
    ...(outcome === "running" ? {} : { turnEndSeq: effectiveEnd }),
    messageCount,
  };
}
