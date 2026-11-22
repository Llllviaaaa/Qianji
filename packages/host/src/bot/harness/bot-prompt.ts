/**
 * Dedicated companion system prompt builder for `BotCompanionHarness`
 * (`packages/host/src/bot/harness/bot-prompt.ts`).
 *
 * Strictly distinct from the Agent coding harness (`packages/prompt-context`):
 * centers on proactive caring understanding, implicit intent extraction,
 * connected daily apps (Email, Calendar, Process Sensor, Meeting Notes/IM),
 * and outbound draft-then-approve safety boundaries.
 */
import type { BotVirtualServerStatus } from "@qianji/protocol";
import type { PersistedBotState } from "../defaults.ts";
import { sharedFolderSlug } from "../wsl-runtime.ts";

export interface BotPromptBuildInput {
  displayName: string;
  soulMarkdown: string;
  memoryMarkdown: string;
  state: PersistedBotState;
  now?: Date;
}

function formatRuntimeSection(vs: BotVirtualServerStatus): string {
  if (vs.mode === "remote" && vs.remote.initialized) {
    return `<bot_runtime>\nYou are executing inside the user's Remote SSH Virtual Server (${vs.remote.username}@${vs.remote.host}). Working directory: ${vs.remote.workDir}/workspace.\n</bot_runtime>`;
  }
  if (vs.local.engine === "wsl2") {
    const sharedList = vs.local.sharedFolders
      .map((sf, idx) => `- /shared/${sharedFolderSlug(sf.path, idx)} (${sf.access})`)
      .join("\n");
    return [
      "<bot_runtime>",
      `Execution environment: isolated WSL2 Alpine Linux container (${vs.local.distroName ?? "qianji-bot-vm"}).`,
      "Primary read/write workspace: /workspace.",
      sharedList ? `Mounted shared folders:\n${sharedList}` : "No external host folders mounted.",
      "</bot_runtime>",
    ].join("\n");
  }
  return "<bot_runtime>\nExecution environment: Bot isolated workspace.\n</bot_runtime>";
}

export function buildBotSystemPrompt(input: BotPromptBuildInput): string {
  const now = input.now ?? new Date();
  const st = input.state;
  const awareness = st.awareness;

  const companionIdentity = [
    "<companion_identity>",
    `你是「${input.displayName}」，用户专属的贴身常驻个人分身（Bot 形态），第一宗旨是「贴心」与「主动理解」。`,
    "你的工作方式与代码工作台的 Agent 截然不同：",
    "1. **主动听懂话外之音**：从用户的日常沟通、吐槽或转发的他人的对话片段中，挖掘他真正卡在哪里、没明说的诉求、顾虑与关键截止日期，不要只是表面客套安抚。",
    "2. **提前多走半步（永远带着建议与半成品）**：涉及查看邮箱、日历、会议纪要或电脑任务状态时，主动调用 `bot_sense_apps` 获取实时信息；需要规划或代拟回复时，提前理出清晰方案，并主动通过 `bot_stage_outbound_approval` 备好完整草稿放到「批准」栏。",
    "3. **顺手联动目标与空间**：聊完跨天关注事项或专项议题时，主动用 `bot_manage_goal` / `bot_manage_space` 替用户记下来并保持更新；察觉到新的个人习惯时用 `bot_remember_preference` 沉淀记忆。",
    "</companion_identity>",
  ].join("\n");

  const soul = input.soulMarkdown.trim();
  const soulSection = soul ? `<bot_soul>\n${soul}\n</bot_soul>` : "";

  const activeGoals = st.goals
    .filter((g) => g.status === "active")
    .slice(0, 8)
    .map((g) => `- [${g.category}] ${g.title}（${g.summary}）`)
    .join("\n");
  const spaceList = st.spaces
    .slice(0, 8)
    .map((s) => `- ${s.title}：${s.description}`)
    .join("\n");
  const prefs = st.learnedPreferences.slice(0, 12).map((p) => `- ${p}`).join("\n");
  const memSlice = input.memoryMarkdown.trim().slice(0, 2200);

  const profileSection = [
    "<user_profile>",
    prefs ? `已习得习惯与偏好：\n${prefs}` : "已习得习惯与偏好：暂无明确条目（对话中请留心归纳）",
    activeGoals ? `当前追踪目标：\n${activeGoals}` : "",
    spaceList ? `已建立常驻空间：\n${spaceList}` : "",
    memSlice ? `长期记忆摘录：\n${memSlice}` : "",
    "</user_profile>",
  ]
    .filter(Boolean)
    .join("\n\n");

  const todayEventsText = awareness?.todayEvents?.length
    ? awareness.todayEvents.map((e) => `- ${e.timeRangeLabel} ${e.title}${e.conflictWith ? ` [与「${e.conflictWith}」冲突]` : ""}`).join("\n")
    : "暂无同步日程（或日历未启用）";
  const inboxText = st.inboxItems.slice(0, 5)
    .map((m) => `- [${m.source ?? "email"}] ${m.sender} | ${m.subject} | ${m.preview.slice(0, 80)}`)
    .join("\n");

  const awarenessSection = [
    "<live_awareness>",
    `当前时间：${now.toLocaleString("zh-CN", { hour12: false })}`,
    `工作状态感知：${awareness?.busyState ?? "normal"}${awareness?.activeWindowTitle ? `（当前窗口：${awareness.activeWindowTitle}）` : ""}`,
    awareness?.runningWatched?.length ? `运行中盯守进程：${awareness.runningWatched.join(", ")}` : "",
    `今日日程概览：\n${todayEventsText}`,
    inboxText ? `最新收件箱/外部消息：\n${inboxText}` : "",
    "</live_awareness>",
  ]
    .filter(Boolean)
    .join("\n");

  const safetySection = [
    "<caring_boundaries>",
    "- 所有对内准备（查信、查日程、建目标、建空间、发动态简报、在隔离容器工作区整理文档）可直接自主执行。",
    "- **严禁擅自对外发送邮件、外部消息或执行高风险外发命令**：必须调用 `bot_stage_outbound_approval` 将完整收件人、主题与正文草稿挂入右侧「批准」栏，等待用户点击确认。",
    "</caring_boundaries>",
  ].join("\n");

  return [
    companionIdentity,
    soulSection,
    profileSection,
    awarenessSection,
    safetySection,
    formatRuntimeSection(st.virtualServer),
  ]
    .filter(Boolean)
    .join("\n\n");
}