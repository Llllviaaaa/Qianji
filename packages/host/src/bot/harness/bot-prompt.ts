/**
 * Dedicated companion system prompt builder for `BotCompanionHarness`
 * (`packages/host/src/bot/harness/bot-prompt.ts`).
 *
 * Strictly distinct from the Agent coding harness (`packages/prompt-context`):
 * centers on proactive caring understanding, implicit intent extraction,
 * connected daily apps, scheduled background routines, V2 Discovery (`动态`/`点子`/`目标`),
 * Goal Co-Refinement interviews, bubble quick-reply `[[options: ...]]`, and safety boundaries.
 */
import type { BotVirtualServerStatus } from "@qianji/protocol";
import type { ScheduledTask } from "@qianji/schedule";
import { DEFAULT_FEED_INSTRUCTIONS, type PersistedBotState } from "../defaults.ts";
import { sharedFolderSlug } from "../wsl-runtime.ts";

export interface BotPromptBuildInput {
  displayName: string;
  soulMarkdown: string;
  memoryMarkdown: string;
  state: PersistedBotState;
  scheduledTasks?: readonly ScheduledTask[];
  now?: Date;
}

const WEEKDAY_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function pad2(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(2, "0");
}

function formatRoutineCadence(t: ScheduledTask): string {
  if (t.frequency === "interval") return `每 ${t.intervalMinutes ?? 30} 分钟`;
  if (t.frequency === "hourly") return `每小时 :${pad2(t.minute)}`;
  if (t.frequency === "weekdays") return `工作日 ${pad2(t.hour)}:${pad2(t.minute)}`;
  if (t.frequency === "weekly") return `每${WEEKDAY_ZH[t.weekday] ?? "周一"} ${pad2(t.hour)}:${pad2(t.minute)}`;
  if (t.frequency === "once") {
    return t.runAt ? `单次 (${new Date(t.runAt).toLocaleString("zh-CN", { hour12: false })})` : "单次提醒";
  }
  return `每天 ${pad2(t.hour)}:${pad2(t.minute)}`;
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
    "3. **主动经营预定任务、目标、动态与点子方案包（V2 协同飞轮）**：",
    "   - **目标对话共创（Goal Co-Refinement Interview）**：当用户发起目标设定引导（如「我想设定一个『...』目标」）时，先用温和简练的语气问 2～3 个关键澄清问题（具体达标口径、时间周期、希望的跟进频率），不要立刻盲目建空壳目标；待用户回答明确后，调用 `bot_manage_goal(action=\"create\", source=\"chat_interview\", ...)` 正式立项（严格区分单行实时阻塞/下一步 `summary` 与完整背景 `description`），并视需要配套调用 `bot_manage_schedule` 创建定期跟进提醒。",
    "   - **跨天阻塞点主动追踪**：遇到多步未完结、等待用户确认或外部条件的事项，调用 `bot_manage_goal`（`source=\"assistant_tracking\"`、`momentumStatus=\"waiting_user\" | \"on_track\" | \"stalled\"`）维护实时阻塞状态与时间线里程碑（`timelineTitle`/`timelineDetail`）。",
    "   - **动态情报刊与点子方案包**：调用 `bot_publish_briefing` 发到「动态」时采用两句话高密度结论 + 行内 `[关键词](https://...)` 信源链接，附温暖第一人称 `reason` 说明创建原因，对比类信息可附无 `<script>` 的 `--hatch-widget-*` HTML `attachment`；发现可复用的行动方案时调用 `bot_propose_idea`（附 `capabilities` 交付物清单与 `howItWorks` 分步执行说明）。",
    "4. **气泡快捷回复选项（`[[options: 选项A | 选项B]]`）**：在主动汇报待拍板事项、目标共创追问或需要用户二选一/三选一决策的回复最末尾，另起一行附加 `[[options: 选项A | 选项B]]`（每个选项简短明确，2～3 项），让聊天气泡直接渲染一键回复按钮；普通开放式闲聊或纯知识解答无需附加。",
    "</companion_identity>",
  ].join("\n");

  const soul = input.soulMarkdown.trim();
  const soulSection = soul ? `<bot_soul>\n${soul}\n</bot_soul>` : "";

  const activeGoals = st.goals
    .filter((g) => g.status === "active")
    .slice(0, 8)
    .map((g) => {
      const totalSub = g.subGoals?.length ?? 0;
      const doneSub = g.subGoals?.filter((s) => s.done).length ?? 0;
      const subBadge = totalSub > 0 ? ` · 子目标 ${doneSub}/${totalSub}` : "";
      const momBadge = g.momentumStatus === "waiting_user" ? " · 等待确认" : g.momentumStatus === "stalled" ? " · 受阻" : "";
      return `- [id=${g.id}] [${g.category}] ${g.title}（${g.summary}${subBadge}${momBadge}）`;
    })
    .join("\n");
  const spaceList = st.spaces
    .slice(0, 8)
    .map((s) => `- ${s.title}：${s.description}`)
    .join("\n");
  const prefs = st.learnedPreferences.slice(0, 12).map((p) => `- ${p}`).join("\n");
  const feedInst = (st.feedInstructions ?? DEFAULT_FEED_INSTRUCTIONS).trim();
  const memSlice = input.memoryMarkdown.trim().slice(0, 2200);

  const profileSection = [
    "<user_profile>",
    prefs ? `已习得习惯与偏好：\n${prefs}` : "已习得习惯与偏好：暂无明确条目（对话中请留心归纳）",
    `动态版块指示（Feed Instructions）：${feedInst}`,
    activeGoals ? `当前追踪目标：\n${activeGoals}` : "",
    spaceList ? `已建立常驻空间：\n${spaceList}` : "",
    memSlice ? `长期记忆摘录：\n${memSlice}` : "",
    "</user_profile>",
  ]
    .filter(Boolean)
    .join("\n\n");

  const heartbeatLine = `- [id=heartbeat] Heartbeat 主动巡检：每 ${st.pacing?.heartbeatIntervalMinutes ?? 30} 分钟（${st.pacing?.heartbeatEnabled !== false ? "已启用" : "已暂停"}）`;
  const routineLines = (input.scheduledTasks ?? [])
    .slice(0, 15)
    .map((t) => `- [id=${t.id}] ${t.name}：${formatRoutineCadence(t)}（${t.enabled ? "已定时" : "已暂停"}）`)
    .join("\n");
  const scheduledSection = [
    "<scheduled_routines>",
    heartbeatLine,
    routineLines || "- 暂无自定义预定任务（用户提出定时提醒、早报、周期检查时，请主动调用 `bot_manage_schedule` 创建）",
    "提示：支持通过 `bot_manage_schedule` 执行 `create`（支持 `daily`/`weekdays`/`weekly`/`hourly`/`interval` 及 `once` + `delayMinutes`/`runAtIso`）、`list`、`toggle`、`update`、`delete`、`run_now`。",
    "</scheduled_routines>",
  ].join("\n");

  const todayEventsText = awareness?.todayEvents?.length
    ? awareness.todayEvents.map((e) => `- ${e.timeRangeLabel} ${e.title}${e.conflictWith ? ` [与「${e.conflictWith}」冲突]` : ""}`).join("\n")
    : "暂无同步日程（或日历未启用）";
  const inboxText = st.inboxItems
    .slice(0, 5)
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

  const cfg = st.connectorConfigs;
  const policyNotes = Object.entries(cfg?.appPolicies ?? {})
    .filter(([, pol]) => pol.connected)
    .map(([appId, pol]) => `${appId} (${pol.authKind ?? "oauth"} · ${pol.policy})`)
    .join(" · ");
  const connNotes = [
    cfg?.email.enabled ? `Email (${cfg.email.permission === "read-only" ? "仅只读" : "读写需批准"})` : null,
    cfg?.calendar.enabled ? "Calendar (仅只读)" : null,
    cfg?.github?.enabled ? `GitHub (${cfg.github.permission === "read-only" ? "仅只读" : "读写需批准"})` : null,
    cfg?.notion?.enabled ? `Notion (${cfg.notion.permission === "read-only" ? "仅只读" : "读写需批准"})` : null,
    cfg?.slack?.enabled ? `Slack (${cfg.slack.permission === "read-only" ? "仅只读" : "读写需批准"})` : null,
    cfg?.customWebhook?.enabled ? `Webhook (${cfg.customWebhook.permission === "read-only" ? "仅只读" : "读写需批准"})` : null,
    policyNotes || null,
  ]
    .filter(Boolean)
    .join(" · ");

  const safetySection = [
    "<caring_boundaries>",
    "- 所有对内准备（查信、查日程、查 GitHub/Notion、管理预定任务、建目标/子目标、建空间、发动态简报、提议点子、在隔离容器工作区整理文档）可直接自主执行。",
    "- **严禁擅自对外发送邮件、外部消息、发布 GitHub 评论、写入 Notion 或调用外发 Webhook**：处于「读写需批准」模式时必须调用 `bot_stage_outbound_approval` 挂入右侧「批准」栏；处于「仅只读」模式时严禁发起任何外发写操作。",
    connNotes ? `- 已连接应用与权限：${connNotes}` : "",
    "</caring_boundaries>",
  ]
    .filter(Boolean)
    .join("\n");

  return [
    companionIdentity,
    soulSection,
    profileSection,
    scheduledSection,
    awarenessSection,
    safetySection,
    formatRuntimeSection(st.virtualServer),
  ]
    .filter(Boolean)
    .join("\n\n");
}
