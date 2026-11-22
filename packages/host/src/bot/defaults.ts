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
  BotDocumentItem,
  BotFeedItem,
  BotGoalItem,
  BotIdeaSection,
  BotInboxItem,
  BotMediaItem,
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

export interface PersistedBotState {
  version: 2;
  mainSessionId: string;
  profile: BotProfile;
  sideThreads: BotSideThreadInfo[];
  soulUpdatedAt: string;
  learnedPreferences: string[];
  activityGroups: BotActivityGroup[];
  pendingApprovals: PendingBotApproval[];
  recentApprovals: ResolvedBotApproval[];
  feed: BotFeedItem[];
  ideaSections: BotIdeaSection[];
  goals: BotGoalItem[];
  spaces: BotSpaceSummary[];
  documents: BotDocumentItem[];
  media: BotMediaItem[];
  inboxEnabled: boolean;
  inboxAddress: string;
  inboxItems: BotInboxItem[];
  connectors: BotConnectorItem[];
  virtualServer: BotVirtualServerStatus;
  embeddedTasks: BotTaskHandoffPayload[];
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
      },
      {
        id: "idea-space-board",
        icon: "❖",
        title: "我可以为你构建个人千机面板，把我处理的所有事项集中在一处展示",
        description: "无需繁琐配置。需要你拍板的事项置顶显示，每天早上静默刷新。",
        seedPrompt: "我想创建一个空间，关于 每日待拍板事项与工作推进看板",
      },
      {
        id: "idea-cost-plan",
        icon: "$",
        title: "我可以按真实对话习惯梳理多模型怎么搭配最省心省钱",
        description: "结合日常问答、深度长文与代码推理场景，规划主力模型与高性价比轻量模型的分工建议。",
        seedPrompt: "帮我规划一套兼顾响应速度、推理质量与调用成本的多模型日常搭配方案。",
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
      },
      {
        id: "idea-watch-ci",
        icon: "✦",
        title: "监测重点任务与异常日志，并在第一时间备好排查草案",
        description: "把需要盯守的目标交给我。只有真正出现异常时才提醒你，并附上可直接切入工作台的排查线索。",
        seedPrompt: "帮我制定一份重点仓库与构建异常的定时巡检计划。",
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
      },
      {
        id: "idea-overnight-research",
        icon: "☾",
        title: "在休息前把长耗时调研交给我，整理好对比结论等你拍板",
        description: "搜集技术资料、对比方案优劣、汇总成结构化文档并归档进资源库。",
        seedPrompt: "帮我针对以下主题做一次深度对比调研，并把结论整理成结构化报告：",
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
    ideaSections: STARTER_IDEA_SECTIONS,
    goals: [],
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
      { id: "calendar", name: "日历与提醒", description: "本地定时任务与每日早报投递", enabled: true },
    ],
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
      liveViewTaskTitle: "虚拟服务器受控环境空闲待命",
      takeoverRequired: false,
    },
    embeddedTasks: [],
  };
}
