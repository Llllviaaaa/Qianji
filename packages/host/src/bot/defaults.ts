/**
 * Clean initial state templates for `<dataDir>/bot/` (`@qianji/host` Bot service).
 *
 * Strictly contains ZERO fake conversation logs, fake PR numbers, or demo artifacts:
 * user-owned collections (threads, activities, approvals, feed, goals, spaces,
 * documents, media, inbox) start clean and populate only from real actions & files.
 */
import type {
  BotActivityGroup,
  BotAvatarPresetId,
  BotConnectorItem,
  BotConnectorsConfig,
  BotDocumentItem,
  BotFeedItem,
  BotGoalItem,
  BotGoalViewPrefs,
  BotIdeaSection,
  BotInboxItem,
  BotLiveAwarenessSummary,
  BotMediaItem,
  BotModelConfig,
  BotPacingConfig,
  BotProfile,
  BotSideThreadInfo,
  BotSpaceSummary,
  BotTaskHandoffPayload,
  BotVirtualServerStatus,
  PendingBotApproval,
  ResolvedBotApproval,
} from "@qianji/protocol";

export const MAX_SOUL_BYTES = 128 * 1024;

export const DEFAULT_SOUL_MARKDOWN = `# SOUL — 千机核心人格契约

- 温和、克制、直奔重点：后台巡检无异常时保持静默，不在无异常时发通知打扰你。
- 本地与虚拟服务器安全优先：涉及代码试修时优先在独立隔离环境中准备方案，不擅自改动你正在编写的主分支。
- 敏感写操作必经批准：遇到对外评论、发送邮件、推送分支或删除重要文件时，始终先挂入右侧「批准」栏请求你的确认。
`;

export const DEFAULT_FEED_INSTRUCTIONS =
  "为我打造一个关于我工作、项目与兴趣的动态版块。保持内容简洁直接。确保可快速浏览。尽量避免点击诱饵。";

export function buildDefaultGoalViewPrefs(): BotGoalViewPrefs {
  return { showSubtitles: true, autoSort: false };
}

export interface PersistedBotState {
  version: 2;
  mainSessionId: string;
  customWorkspaceDir?: string;
  profile: BotProfile;
  sideThreads: BotSideThreadInfo[];
  soulUpdatedAt: string;
  learnedPreferences: string[];
  activityGroups: BotActivityGroup[];
  pendingApprovals: PendingBotApproval[];
  recentApprovals: ResolvedBotApproval[];
  feed: BotFeedItem[];
  feedInstructions?: string;
  ideaSections: BotIdeaSection[];
  dismissedIdeaIds?: string[];
  goals: BotGoalItem[];
  goalViewPrefs?: BotGoalViewPrefs;
  spaces: BotSpaceSummary[];
  documents: BotDocumentItem[];
  media: BotMediaItem[];
  inboxEnabled: boolean;
  inboxAddress: string;
  inboxItems: BotInboxItem[];
  connectors: BotConnectorItem[];
  modelConfig?: BotModelConfig;
  pacing?: BotPacingConfig;
  connectorConfigs?: BotConnectorsConfig;
  awareness?: BotLiveAwarenessSummary;
  virtualServer: BotVirtualServerStatus;
  embeddedTasks: BotTaskHandoffPayload[];
}

export function buildDefaultPacingConfig(): BotPacingConfig {
  return {
    heartbeatEnabled: true,
    heartbeatIntervalMinutes: 30,
    quietHoursEnabled: true,
    quietHoursStart: "23:00",
    quietHoursEnd: "08:00",
  };
}

export function buildDefaultConnectorsConfig(): BotConnectorsConfig {
  return {
    email: {
      enabled: false,
      permission: "ask-write",
      preset: "qq",
      emailAddress: "",
      imapHost: "imap.qq.com",
      imapPort: 993,
      imapTls: true,
      smtpHost: "smtp.qq.com",
      smtpPort: 465,
      smtpTls: true,
      hasPassword: false,
    },
    calendar: {
      enabled: false,
      icsUrl: "",
      localIcsPath: "",
      leadMinutes: 15,
    },
    processSensor: {
      enabled: true,
      watchedProcesses: [],
      lateNightCareEnabled: true,
    },
    meetingsIm: {
      permission: "ask-write",
      meetingNotesEnabled: false,
      meetingNotesDir: "",
      telegramEnabled: false,
      telegramChatId: "",
      hasTelegramToken: false,
      feishuEnabled: false,
      hasFeishuWebhook: false,
    },
    github: {
      enabled: false,
      permission: "read-only",
      watchedRepos: [],
      hasToken: false,
    },
    notion: {
      enabled: false,
      permission: "read-only",
      parentPageId: "",
      hasToken: false,
    },
    slack: {
      enabled: false,
      permission: "ask-write",
      channelLabel: "",
      hasWebhookUrl: false,
    },
    customWebhook: {
      enabled: false,
      permission: "ask-write",
      label: "Zapier / 自定义 Webhook",
      endpointUrl: "",
      hasBearerToken: false,
    },
  };
}

export function buildDefaultAwareness(): BotLiveAwarenessSummary {
  return {
    busyState: "normal",
    runningWatched: [],
    todayEvents: [],
    conflictCount: 0,
  };
}

export function normalizeAvatarPreset(raw: string | undefined): BotAvatarPresetId {
  if (raw === "warm-felt" || raw === "plush-ears" || raw === "custom") return raw;
  return "alabaster-felt";
}

export function formatShortDate(ts = Date.now()): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${mm}.${dd}.${yy}`;
}

export function formatClock(ts = Date.now()): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export const STARTER_IDEA_SECTIONS: BotIdeaSection[] = [
  {
    category: null,
    items: [
      {
        id: "idea-health-check",
        icon: "✓",
        title: "给你一份验证过的本地仓库健康度清单",
        description: "等你忙完手头代码，我可以按顺序核实当前工作区的未提交分支、依赖状态与测试结果，给你一份状态清楚的总结。",
        seedPrompt: "帮我检查当前工作区的未提交变更、分支状态与测试健康度，整理一份清晰的总结清单。",
        sourceLabel: "工作区体检",
        isFeatured: true,
        buildStatus: "not_started",
        capabilities: [
          { kind: "workbench", title: "工作台只读巡检", subtitle: "在不改动未提交文件的前提下核查分支、依赖与测试健康度。", ready: true },
          { kind: "doc", title: "仓库健康度核查报告", subtitle: "归档进资源库的结构化分支状态与风险清单。", ready: true, docPreset: { name: "repo-health-check.md", summary: "本地仓库未提交变更、依赖一致性与测试健康度核查报告。" } },
        ],
        howItWorks: "我会先在只读模式下核查当前 Git 分支、未提交改动与依赖锁文件，随后执行快速类型与单测校验，把需要你留意的风险项整理成《仓库健康度核查报告》存入资源库，绝不擅自改动你正在编写的代码。",
      },
      {
        id: "idea-space-board",
        icon: "❖",
        title: "我可以为你构建个人千机面板，把我处理的所有事项集中在一处展示",
        description: "无需繁琐配置。需要你拍板的事项置顶显示，每天早上静默刷新。",
        seedPrompt: "我想创建一个空间，关于 每日待拍板事项与工作推进看板",
        sourceLabel: "组合能力方案",
        isFeatured: true,
        buildStatus: "not_started",
        capabilities: [
          { kind: "space", title: "空间", subtitle: "每日待拍板事项与工作推进看板。", ready: true, spacePreset: { title: "个人千机推进面板", description: "集中展示需要拍板的决策项、活跃目标阻塞点与后台任务产出。" } },
          { kind: "schedule", title: "定期任务", subtitle: "每早 08:45 静默刷新面板数据。", ready: true, schedulePreset: { name: "千机推进面板晨间刷新", prompt: "盘点活跃目标阻塞点、待批准草稿与收件箱重点，静默更新到「个人千机推进面板」空间。", frequency: "daily", hour: 8, minute: 45 } },
        ],
        howItWorks: "启动后我会立即为你创建「个人千机推进面板」常驻空间并配置每早 08:45 的静默刷新定期任务；随后首次盘点当前活跃目标、收件箱与待批草稿，把需要你拍板的事项置顶写入面板。",
      },
      {
        id: "idea-cost-plan",
        icon: "$",
        title: "我可以按真实对话习惯梳理多模型怎么搭配最省心省钱",
        description: "结合日常问答、深度长文与代码推理场景，规划主力模型与高性价比轻量模型的分工建议。",
        seedPrompt: "帮我规划一套兼顾响应速度、推理质量与调用成本的多模型日常搭配方案。",
        sourceLabel: "算力与成本规划",
        isFeatured: true,
        buildStatus: "not_started",
        capabilities: [
          {
            kind: "doc",
            title: "多模型分工与成本测算单",
            subtitle: "主力推理、日常沟通与后台巡检的模型搭配建议。",
            ready: true,
            docPreset: { name: "model-routing-cost-plan.md", summary: "结合响应速度、上下文窗口与调用成本的多模型日常搭配方案。" },
          },
          { kind: "goal", title: "持续成本与体验调优", subtitle: "按周观察模型延迟与调用体验并微调路由建议。", ready: true },
        ],
        howItWorks: "我会先结合你的近期会话复杂度、高频任务类型与后台巡检频率，测算主力模型与轻量巡检模型的分工比例，输出《多模型分工与成本测算单》放入资源库，并在聊天中给出可直接确认应用的调整选项。",
      },
    ],
  },
  {
    category: "开发与工作区",
    items: [
      {
        id: "idea-pre-pr",
        icon: "⑂",
        title: "提交合并前，自动在隔离环境跑完门禁并生成变更摘要",
        description: "自动执行类型检查、代码规范与单测校验，完全不打乱你当前正在编辑的文件。",
        seedPrompt: "帮我梳理当前项目的提交前门禁检查步骤，并生成本次改动的变更摘要。",
        sourceLabel: "隔离门禁方案",
        buildStatus: "not_started",
        capabilities: [
          { kind: "workbench", title: "Agent 工作台隔离门禁草案", subtitle: "在独立环境执行类型检查、规范扫描与单测门禁。", ready: true },
          {
            kind: "doc",
            title: "变更摘要报告",
            subtitle: "可直接粘贴至 PR 描述的影响面与验证结论。",
            ready: true,
            docPreset: { name: "pre-pr-gate-summary.md", summary: "提交合并前门禁检查结果、核心改动模块与回归风险摘要。" },
          },
        ],
        howItWorks: "我会在独立隔离环境中依次运行类型检查、代码规范门禁与关联单测，不触碰你正在编辑的主目录；验证完成后自动提炼改动动机、受影响模块与结果生成《变更摘要报告》供你审阅确认。",
      },
      {
        id: "idea-watch-ci",
        icon: "✦",
        title: "监测重点任务与异常日志，并在第一时间备好排查草案",
        description: "把需要盯守的目标交给我。只有真正出现异常时才提醒你，并附上可直接切入工作台的排查线索。",
        seedPrompt: "帮我制定一份重点仓库与构建异常的定时巡检计划。",
        sourceLabel: "后台盯守巡检",
        buildStatus: "not_started",
        capabilities: [
          {
            kind: "schedule",
            title: "定期任务",
            subtitle: "每 60 分钟静默巡检重点仓库与构建状态。",
            ready: true,
            schedulePreset: {
              name: "重点仓库与构建异常巡检",
              prompt: "静默检查重点仓库 Issues/PR 与构建日志状态；无异常保持静默，发现异常时提炼根因线索并准备排查草案。",
              frequency: "interval",
              intervalMinutes: 60,
            },
          },
          { kind: "workbench", title: "异常根因排查草案", subtitle: "仅在检测到报错时生成可接力进工作台的定位线索。", ready: true },
        ],
        howItWorks: "启动后我会挂入每 60 分钟一次的轻量后台巡检；平时一切正常绝不打扰你，一旦发现构建失败、测试报错或关键告警，立即提取错误栈与可疑改动行备好排查草案等你拍板。",
      },
    ],
  },
  {
    category: "效率提升",
    items: [
      {
        id: "idea-morning-brief",
        icon: "☀",
        title: "把一整天的安排整理成清爽早报，不用一早翻零散通知",
        description: "一页汇集待办重点、长期目标进度与关注资讯，每天早上准时就绪。",
        seedPrompt: "我们来定制一份适合我节奏的每日清爽早报模板。",
        sourceLabel: "晨间习惯方案",
        buildStatus: "not_started",
        capabilities: [
          {
            kind: "schedule",
            title: "定期任务",
            subtitle: "工作日每早 08:30 准时投递清爽早报。",
            ready: true,
            schedulePreset: {
              name: "每日清爽工作早报",
              prompt: "汇总今日日程冲突、跨天目标阻塞点、收件箱待办与关注动态，编发一期高信噪比晨间早报。",
              frequency: "weekdays",
              hour: 8,
              minute: 30,
            },
          },
          {
            kind: "doc",
            title: "早报偏好与版式归档",
            subtitle: "按你的关注重点定制的早报信息密度与模块模板。",
            ready: true,
            docPreset: { name: "morning-brief-template.md", summary: "每日清爽早报关注模块、优先级排序与免打扰规则。" },
          },
        ],
        howItWorks: "启动后我会为你配置工作日每早 08:30 的早报定期任务并建立《早报偏好与版式归档》；随后在聊天里和你确认最关心的 2～3 个重点模块，后续每天准时汇总日程、目标阻塞点与新知。",
      },
      {
        id: "idea-overnight-research",
        icon: "☾",
        title: "在休息前把长耗时调研交给我，整理好对比结论等你拍板",
        description: "搜集技术资料、对比方案优劣、汇总成结构化文档并归档进资源库。",
        seedPrompt: "帮我针对以下主题做一次深度对比调研，并把结论整理成结构化报告：",
        sourceLabel: "长耗时调研方案",
        buildStatus: "not_started",
        capabilities: [
          {
            kind: "space",
            title: "空间",
            subtitle: "晨间调研汇报看板。",
            ready: true,
            spacePreset: { title: "晨间调研汇报", description: "汇总夜间长耗时调研结论、已完成项与待拍板事项。" },
          },
          {
            kind: "schedule",
            title: "定期任务",
            subtitle: "每早 08:30 自动汇总整理进度。",
            ready: true,
            schedulePreset: {
              name: "晨间调研早报汇总",
              prompt: "汇总昨夜未完结调研任务与待确认事项，更新到晨间调研汇报空间。",
              frequency: "daily",
              hour: 8,
              minute: 30,
            },
          },
        ],
        howItWorks: "启动后我会为你搭建「晨间调研汇报」常驻空间与每早 08:30 的自动汇总定期任务；你只需在聊天中告诉我今晚想调研对比的主题，我会在后台搜集权威信源、横向比对指标优劣，明早把结论沉淀进空间等你拍板。",
      },
    ],
  },
];

export function buildDefaultBotState(options: {
  mainSessionId: string;
  defaultCwd: string;
  displayName?: string;
  avatarPreset?: string;
}): PersistedBotState {
  const now = Date.now();
  return {
    version: 2,
    mainSessionId: options.mainSessionId,
    profile: {
      displayName: options.displayName?.trim() || "千机",
      avatarPreset: normalizeAvatarPreset(options.avatarPreset),
    },
    sideThreads: [],
    soulUpdatedAt: formatShortDate(now),
    learnedPreferences: [],
    activityGroups: [],
    pendingApprovals: [],
    recentApprovals: [],
    feed: [],
    feedInstructions: DEFAULT_FEED_INSTRUCTIONS,
    ideaSections: STARTER_IDEA_SECTIONS.map((sec) => ({
      category: sec.category,
      items: sec.items.map((it) => ({ ...it, source: "starter" as const })),
    })),
    dismissedIdeaIds: [],
    goals: [],
    goalViewPrefs: buildDefaultGoalViewPrefs(),
    spaces: [],
    documents: [],
    media: [],
    inboxEnabled: false,
    inboxAddress: "qianji@bot.local",
    inboxItems: [],
    connectors: [
      { id: "git-local", name: "本地 Git 工作区", description: "受控共享目录与独立隔离副本保护", enabled: true },
      { id: "github", name: "GitHub", description: "PR / Issues / Actions 状态只读监听", enabled: false },
      { id: "browser-vm", name: "CDP 隔离浏览器", description: "按会话隔离浏览器自动化与实时人工接管", enabled: true },
      { id: "calendar", name: "日历与提醒", description: "ICS 日程同步与会前规划提醒", enabled: false },
    ],
    modelConfig: {},
    pacing: buildDefaultPacingConfig(),
    connectorConfigs: buildDefaultConnectorsConfig(),
    awareness: buildDefaultAwareness(),
    virtualServer: {
      mode: "local",
      lifecycle: process.platform === "win32" ? "offline" : "running",
      uptimeLabel: process.platform === "win32" ? "WSL2 容器待初始化" : "运行中",
      local: {
        cpuCores: 2,
        cpuUsagePercent: 0,
        memoryUsedGb: 0,
        memoryLimitGb: 4,
        diskUsedGb: 0.01,
        diskLimitGb: 32,
        autoSleepIdle: true,
        sharedFolders: [],
        lastSnapshotAt: now,
        engine: process.platform === "win32" ? "wsl2" : "host-fallback",
        engineState: process.platform === "win32" ? "not-installed" : "unavailable",
        distroName: "qianji-bot-vm",
      },
      remote: {
        alias: "远端常驻虚拟服务器",
        host: "",
        port: 22,
        username: "ubuntu",
        workDir: "~/.qianji-vm",
        initialized: false,
        authMethod: "agent-or-key",
        privateKeyPath: "",
        hasStoredSecret: false,
      },
      liveViewTaskTitle: "独立云桌面与受控浏览器待命中",
      takeoverRequired: false,
    },
    embeddedTasks: [],
  };
}
