/**
 * Default seed data and templates for `<dataDir>/bot/` (`@qianji/host` Bot service).
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

- 温和、克制、直奔重点：后台巡检无异常时保持静默，绝不在主聊天发送无意义刷屏通知。
- 本地与虚拟服务器安全优先：绝不擅自改动用户当前正在编写的主分支；凡涉及代码试修，一律在独立隔离副本中准备草案，等用户进入工作台审阅。
- 敏感写操作必经批准：凡涉及对外评论、发邮件、推送受保护分支或删除重要数据，一律挂入右侧「批准」栏等待用户拍板。
`;

export interface PersistedBotState {
  version: 1;
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

export function buildDefaultBotState(options: {
  mainSessionId: string;
  defaultCwd: string;
  displayName?: string;
  avatarPreset?: string;
}): PersistedBotState {
  const now = Date.now();
  const handoffTask: BotTaskHandoffPayload = {
    id: "handoff-pr-142",
    title: "PR #142 CI 巡检与修复草案",
    kindLabel: "定时任务",
    summary: "检测到 PR #142 有一项并发队列回归异常，已在独立安全副本备好修复草案，主工作区保持干净。",
    targetCwd: options.defaultCwd,
    highlightFile: "packages/host/src/plugin-watchers.ts",
    highlightLine: 118,
  };

  return {
    version: 1,
    mainSessionId: options.mainSessionId,
    profile: {
      displayName: options.displayName?.trim() || "千机",
      avatarPreset: normalizeAvatarPreset(options.avatarPreset),
    },
    sideThreads: [],
    soulUpdatedAt: formatShortDate(now),
    learnedPreferences: [
      "代码改写草案一律在独立隔离副本中准备，不直接改动主分支",
      "后台 Heartbeat 巡检无异常时保持静默，不弹打扰通知",
      "涉及外部评论或邮件发送时统一挂入右侧「批准」栏",
    ],
    activityGroups: [
      {
        date: "今天",
        items: [
          {
            id: "act-1",
            dateGroup: "今天",
            title: "巡检重点仓库构建与测试状态",
            description: "Prepared isolated fix draft and queued PR #142 summary widget",
            timeLabel: formatClock(now - 20 * 60_000),
            createdAt: now - 20 * 60_000,
            handoff: handoffTask,
          },
        ],
      },
      {
        date: "昨天",
        items: [
          {
            id: "act-2",
            dateGroup: "昨天",
            title: "核查多模型前缀缓存命中与成本指标",
            description: "Verified 74.2% prompt cache hit rate across recent long sessions",
            timeLabel: "09:58",
            createdAt: now - 86_400_000,
          },
          {
            id: "act-3",
            dateGroup: "昨天",
            title: "清理过期工具溢出缓存目录",
            description: "Reclaimed 428 MB from temporary spill output directory",
            timeLabel: "08:30",
            createdAt: now - 90_000_000,
          },
        ],
      },
    ],
    pendingApprovals: [
      {
        id: "apr-pr-142",
        title: "发布 GitHub PR #142 诊断摘要评论",
        commandSignature: "gh pr comment 142 · 外部写操作",
        summary: "向仓库 PR #142 发送并发队列根因说明，不会推送代码或改动任何分支。",
        createdAt: now - 15 * 60_000,
        expiresAt: now + 86_400_000 * 3,
      },
    ],
    recentApprovals: [
      {
        id: "apr-wt-auto",
        title: "创建独立隔离副本 (fix/pr-142)",
        summary: "今天 · 虚拟服务器安全白名单自动放行",
        decision: "auto-allowed",
        timeLabel: "已允许",
        resolvedAt: now - 18 * 60_000,
      },
    ],
    feed: [
      {
        id: "feed-1",
        title: "重点仓库新增高并发热重载回归压测",
        timeLabel: "2小时前",
        body: "最新构建验证了双文件监听器同时完成周期时，增量任务队列不会丢失后续入队项，42 项核心单测全部通过。",
        actionLabel: "讨论",
        seedPrompt: "帮我详细梳理最新高并发热重载回归压测覆盖了哪些边界情况",
        createdAt: now - 7_200_000,
      },
      {
        id: "feed-2",
        title: "本周多模型缓存命中率提升至 74.2%",
        timeLabel: "5小时前",
        body: "过去 7 天长对话上下文命中稳定，单轮综合调用开销较无缓存基准下降约 72%，未出现前缀失效波动。",
        actionLabel: "开始吧",
        seedPrompt: "把本周模型缓存命中与节省明细整理成一份简明周报",
        createdAt: now - 18_000_000,
      },
    ],
    ideaSections: [
      {
        category: null,
        items: [
          {
            id: "idea-1",
            icon: "✓",
            title: "给你一份验证过的本地项目健康度清单",
            description: "等你忙完手头任务，我可以按顺序核实各仓库未提交分支、过时依赖与测试耗时，输出一页清晰总结。",
            seedPrompt: "帮我巡检当前工作区的未提交变更与项目健康度，整理成简明清单",
          },
          {
            id: "idea-2",
            icon: "❖",
            title: "构建个人常驻千机面板，把待拍板事项集中在一处展示",
            description: "无需繁琐配置，需要你确认的事项置顶显示，每天早上自动静默刷新。",
            seedPrompt: "我想创建一个空间，关于 每日待拍板事项与项目健康脉冲面板",
          },
          {
            id: "idea-3",
            icon: "$",
            title: "按近期真实对话轨迹测算多模型怎么搭配最省成本",
            description: "结合最近 7 天上下文规模，对比不同主力模型与缓存策略下的真实账单。",
            seedPrompt: "帮我分析近期会话的模型用量与缓存省钱搭配建议",
          },
        ],
      },
      {
        category: "开发与工作区",
        items: [
          {
            id: "idea-4",
            icon: "⑂",
            title: "提交合并前，自动在独立虚拟副本跑完门禁并生成摘要",
            description: "自动执行类型检查、代码规范、单测与文档链接校验，丝毫不打扰你正在编写的文件。",
            seedPrompt: "帮我配置提交前的门禁自动巡检清单并生成变更摘要",
          },
        ],
      },
      {
        category: "效率提升",
        items: [
          {
            id: "idea-5",
            icon: "☀",
            title: "把一整天的重点整理成清爽早报，不用一早翻零散通知",
            description: "一页汇总待审事项、构建结果与今日目标，每天早上准时就绪。",
            seedPrompt: "帮我定制每日 08:30 清爽早报的关注维度",
          },
        ],
      },
    ],
    goals: [
      {
        id: "goal-1",
        title: "核心插件热重载与模块边界零回归",
        category: "职业与研发",
        summary: "持续追踪门禁单测与 PR #142 修复草案；等待你在 Agent 工作台中审阅确认。",
        status: "active",
        updatedAt: now - 600_000,
        handoff: handoffTask,
      },
    ],
    spaces: [
      {
        id: "space-1",
        title: "PR #142 巡检与并发回归脉冲",
        description: "实时追踪并发队列修复进度、门禁单测通过率与待审评论状态",
        metricBadge: "42 / 42 通过",
        updatedLabel: "15分钟前",
        updatedAt: now - 900_000,
        handoff: handoffTask,
      },
      {
        id: "space-2",
        title: "多模型缓存命中与成本看板",
        description: "汇总长会话前缀缓存命中率与周度成本节省趋势",
        metricBadge: "74.2% 命中",
        updatedLabel: "昨天",
        updatedAt: now - 86_400_000,
      },
    ],
    documents: [
      {
        id: "doc-1",
        name: "PR-142-并发队列竞态诊断报告.md",
        updatedLabel: "今天",
        sizeLabel: "4.2 KB",
        content: "# PR #142 并发队列竞态诊断\n\n定位到双事件同周期完成时的清理时序问题，已在独立副本准备好代际计数修复方案。",
        updatedAt: now - 900_000,
      },
      {
        id: "doc-2",
        name: "多模型前缀缓存周度成本分析.md",
        updatedLabel: "昨天",
        sizeLabel: "6.8 KB",
        content: "# 多模型缓存周度报告\n\n过去 7 天平均命中率 74.2%，有效降低长会话重复前缀开销。",
        updatedAt: now - 86_400_000,
      },
    ],
    media: [],
    inboxEnabled: false,
    inboxAddress: "qianji.bot@local.box",
    inboxItems: [
      {
        id: "mail-1",
        sender: "GitHub Actions",
        subject: "[Qianji] PR #142 check suite summary",
        preview: "1 check requires attention in plugin-watchers concurrent flush suite.",
        timeLabel: "15:19",
        unread: true,
        createdAt: now - 1_200_000,
      },
      {
        id: "mail-2",
        sender: "Workspace Digest",
        subject: "本周缓存命中与工作区健康周报已生成",
        preview: "全部核心门禁保持通过，缓存命中率稳定在 74.2%。",
        timeLabel: "昨天",
        unread: false,
        createdAt: now - 86_400_000,
      },
    ],
    connectors: [
      { id: "git-local", name: "本地工作区副本", description: "受控共享目录与独立副本读写保护", enabled: true },
      { id: "github", name: "GitHub", description: "PR / Issues / Actions 状态巡检", enabled: true },
      { id: "browser-vm", name: "虚拟服务器专属浏览器", description: "在隔离环境内静默浏览并支持实时画面人工接管", enabled: true },
      { id: "calendar", name: "日程与定时提醒", description: "周期性早报与待办节点提醒", enabled: false },
    ],
    virtualServer: {
      mode: "local",
      lifecycle: "running",
      uptimeLabel: "已连续运行 3天 14小时",
      local: {
        cpuCores: 2,
        cpuUsagePercent: 8,
        memoryUsedGb: 1.4,
        memoryLimitGb: 4,
        diskUsedGb: 6.2,
        diskLimitGb: 32,
        autoSleepIdle: true,
        sharedFolders: options.defaultCwd
          ? [{ path: options.defaultCwd, access: "isolated-copy" }]
          : [],
        lastSnapshotAt: now - 86_400_000,
      },
      remote: {
        alias: "远端常驻虚拟服务器",
        host: "",
        port: 22,
        username: "ubuntu",
        workDir: "~/.qianji-vm",
        initialized: false,
      },
      liveViewTaskTitle: "虚拟服务器专属浏览器 · 空闲待命",
      takeoverRequired: false,
    },
    embeddedTasks: [handoffTask],
  };
}
