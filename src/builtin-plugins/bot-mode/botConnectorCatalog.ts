/**
 * Standards-Based Connected Apps & MCP Directory (`botConnectorCatalog.ts`).
 *
 * Zero custom browser scraping for SaaS connectors: every built-in cloud integration uses
 * official Remote MCP + OAuth 2.1, Google Workspace MCP (`gws mcp` / Remote MCP),
 * GitHub CLI + Official MCP, or standards-based ImapFlow/Nodemailer & ICS protocols.
 */
import type { BotActionPermissionLevel, BotPluginConnectorCatalogItem } from "@qianji/protocol";
export { resolveConnectorState, type ResolvedConnectorState } from "./botConnectorState";

export type ConnectorCategoryId = "office" | "dev" | "automation";
export type ConnectorAuthMode =
  | "mcp-oauth"
  | "mcp-direct"
  | "google-mcp"
  | "github-mcp"
  | "folder-picker"
  | "imap-modal"
  | "webhook-modal"
  | "plugin"
  | "browser";

export interface ConnectorCapabilitySpec {
  readonly id: string;
  readonly label: string;
  readonly kind: "read" | "write";
  readonly defaultPerm: BotActionPermissionLevel;
}

export interface ConnectorCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly tagline: string;
  readonly description: string;
  readonly category: ConnectorCategoryId;
  readonly categoryLabel: string;
  readonly publisher: string;
  readonly authMode: ConnectorAuthMode;
  readonly authLabel: string;
  readonly featured?: boolean;
  readonly icon?: string;
  readonly iconBg?: string;
  readonly browserAuthUrl?: string;
  readonly pluginItem?: BotPluginConnectorCatalogItem;
  readonly mcpPreset?: {
    readonly serverId: string;
    readonly name: string;
    readonly url: string;
    readonly trustedReadOnly: boolean;
  };
  readonly starterPrompts: readonly string[];
  readonly capabilities: readonly ConnectorCapabilitySpec[];
}

export function pluginConnectorToCatalogEntry(item: BotPluginConnectorCatalogItem): ConnectorCatalogEntry {
  const c = item.connector;
  const category: ConnectorCategoryId =
    c.category === "office" || c.category === "dev" || c.category === "automation"
      ? c.category
      : "automation";
  const capabilities: ConnectorCapabilitySpec[] =
    item.tools.length > 0
      ? item.tools.map((t) => ({
          id: t.name,
          label: t.description || t.rawName,
          kind: t.readOnly ? "read" : "write",
          defaultPerm: t.readOnly ? "allow" : "ask",
        }))
      : (c.capabilities ?? []).map((capItem) => ({
          id: capItem.id,
          label: capItem.label,
          kind: capItem.kind,
          defaultPerm: capItem.defaultPerm ?? (capItem.kind === "read" ? "allow" : "ask"),
        }));
  const authMode: ConnectorAuthMode =
    c.authMode === "browser" || c.authMode === "mcp-oauth" || c.authMode === "mcp-direct" || c.authMode === "plugin"
      ? c.authMode
      : "plugin";
  const mcpPreset =
    c.mcpUrl && (authMode === "mcp-oauth" || authMode === "mcp-direct")
      ? {
          serverId: `preset-mcp-${c.id}`,
          name: c.name,
          url: c.mcpUrl,
          trustedReadOnly: c.trustedReadOnly === true,
        }
      : undefined;
  return {
    id: c.id,
    name: c.name,
    tagline: c.tagline,
    description: c.description || c.tagline,
    category,
    categoryLabel: CATEGORY_LABELS[category],
    publisher: c.publisher || item.pluginName,
    authMode,
    authLabel: c.authLabel || `插件 · ${item.pluginName}`,
    featured: c.featured,
    ...(c.icon ? { icon: c.icon } : {}),
    ...(c.iconBg ? { iconBg: c.iconBg } : {}),
    ...(c.browserAuthUrl ? { browserAuthUrl: c.browserAuthUrl } : {}),
    ...(mcpPreset ? { mcpPreset } : {}),
    pluginItem: item,
    starterPrompts:
      c.starterPrompts && c.starterPrompts.length > 0
        ? c.starterPrompts
        : [`使用 @${c.name} 查询最新内容摘要`],
    capabilities,
  };
}

export function getMergedConnectorCatalog(
  pluginCatalog: readonly BotPluginConnectorCatalogItem[] = [],
): readonly ConnectorCatalogEntry[] {
  if (pluginCatalog.length === 0) return CONNECTOR_CATALOG;
  const dynamicEntries = pluginCatalog.map(pluginConnectorToCatalogEntry);
  return [
    ...CONNECTOR_CATALOG,
    ...dynamicEntries.filter((pe) => !CONNECTOR_CATALOG.some((b) => b.id === pe.id)),
  ];
}

export const CATEGORY_LABELS: Readonly<Record<ConnectorCategoryId, string>> = {
  office: "办公与协作",
  dev: "研发与设计",
  automation: "商业与自动化",
};

const cap = (
  id: string,
  label: string,
  kind: "read" | "write",
  defaultPerm: BotActionPermissionLevel = kind === "read" ? "allow" : "ask",
): ConnectorCapabilitySpec => ({ id, label, kind, defaultPerm });

export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [
  {
    id: "gmail",
    name: "Gmail",
    tagline: "通过 Google 官方 MCP 同步收件箱、提炼重要变更并起草回信",
    description: "基于标准 MCP（Google 官方 @googleworkspace/cli 或 OAuth 2.1 Remote MCP）自动同步 Gmail 收件箱、检索历史线程并起草待批复回复。",
    category: "office",
    categoryLabel: "办公与协作",
    publisher: "Google Workspace",
    authMode: "google-mcp",
    authLabel: "Google 官方 MCP (OAuth 2.1)",
    featured: true,
    mcpPreset: { serverId: "preset-mcp-gmail", name: "Gmail", url: "https://gmailmcp.googleapis.com/mcp", trustedReadOnly: false },
    starterPrompts: [
      "总结我今天收到的重要邮件，哪些需要立即回复？",
      "找出最近一周关于账单或订阅续费的邮件通知",
      "为最新一封未读工作邮件起草回复草稿供我确认",
    ],
    capabilities: [
      cap("read_mail", "访问与检索收件箱邮件", "read"),
      cap("read_labels", "访问标签与线程上下文", "read"),
      cap("draft_reply", "撰写回复草稿", "write", "allow"),
      cap("send_mail", "对外发送邮件", "write", "ask"),
    ],
  },
  {
    id: "calendar",
    name: "Google 日历",
    tagline: "通过标准 MCP 或 ICS 同步今日日程、识别冲突并触发会前提醒",
    description: "通过 Google Workspace 官方 MCP（或私有 ICS 订阅）同步每日议程、分析空闲时间块并在开会时自动开启勿扰。",
    category: "office",
    categoryLabel: "办公与协作",
    publisher: "Google Workspace",
    authMode: "google-mcp",
    authLabel: "Google 官方 MCP (OAuth 2.1)",
    featured: true,
    mcpPreset: { serverId: "preset-mcp-calendar", name: "Google 日历", url: "https://calendarmcp.googleapis.com/mcp", trustedReadOnly: true },
    starterPrompts: [
      "今天接下来的日程安排是什么？有没有时间冲突？",
      "帮我找出今天下午 1 小时以上的连续空闲时段",
    ],
    capabilities: [
      cap("read_events", "读取日历日程与参与者", "read"),
      cap("free_slots", "分析空闲时段与冲突提醒", "read"),
    ],
  },
  {
    id: "google_drive",
    name: "Google 云端硬盘",
    tagline: "通过标准 MCP 搜索云端文档、表格与演示文稿并提取关键信息",
    description: "连接 Google Workspace 官方 MCP 后，可按权限安全检索 Google Drive 文档、表格与幻灯片内容。",
    category: "office",
    categoryLabel: "办公与协作",
    publisher: "Google Workspace",
    authMode: "google-mcp",
    authLabel: "Google 官方 MCP (OAuth 2.1)",
    featured: true,
    mcpPreset: { serverId: "preset-mcp-google_drive", name: "Google 云端硬盘", url: "https://drivemcp.googleapis.com/mcp", trustedReadOnly: true },
    starterPrompts: [
      "在 Google 云端硬盘中搜索最近更新的产品规划或会议文档",
      "汇总本周共享给我的重点资料清单",
    ],
    capabilities: [
      cap("read_files", "浏览与读取云端硬盘文件", "read"),
      cap("search_docs", "检索文档、表格与幻灯片内容", "read"),
    ],
  },
  {
    id: "github",
    name: "GitHub",
    tagline: "自动复用本机 gh CLI 或官方 MCP，追踪开放 Issue / PR 并代发评审评论",
    description: "一键复用本机 GitHub CLI (gh) 登录态或连接 GitHub 官方 MCP，自动发现活跃仓库、同步 Issue/PR 动态并在经你批准后发表评论。",
    category: "dev",
    categoryLabel: "研发与设计",
    publisher: "GitHub",
    authMode: "github-mcp",
    authLabel: "GitHub CLI / 官方 MCP",
    featured: true,
    mcpPreset: { serverId: "preset-mcp-github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", trustedReadOnly: false },
    starterPrompts: [
      "总结我最近活跃仓库近 7 天的 Issue 和 PR 风险点",
      "像资深评审人一样梳理当前 PR 可能破坏的边界",
    ],
    capabilities: [
      cap("read_repos", "读取仓库 Issue 与 Pull Request", "read"),
      cap("read_code", "检索代码与提交记录", "read"),
      cap("comment_issue", "发表 Issue / PR 评论", "write", "ask"),
    ],
  },
  {
    id: "notion",
    name: "Notion",
    tagline: "一键 OAuth 连接工作区页面、数据库与调研沉淀归档",
    description: "点击连接将打开 Notion 官方 OAuth 2.1 授权页，令牌加密存入系统 Keychain 并自动续期，随时检索与沉淀笔记。",
    category: "dev",
    categoryLabel: "研发与设计",
    publisher: "Notion",
    authMode: "mcp-oauth",
    authLabel: "官方 OAuth 2.1 (MCP)",
    featured: true,
    mcpPreset: { serverId: "preset-mcp-notion", name: "Notion", url: "https://mcp.notion.com/mcp", trustedReadOnly: false },
    starterPrompts: [
      "搜索我最近编辑过的 Notion 架构或项目规划文档",
      "把刚才讨论的结论整理成结构化页面并请求我批准写入 Notion",
    ],
    capabilities: [
      cap("search_pages", "检索 Notion 页面与数据库", "read"),
      cap("read_blocks", "读取页面正文内容", "read"),
      cap("write_pages", "创建或更新 Notion 页面", "write", "ask"),
    ],
  },
  {
    id: "linear",
    name: "Linear",
    tagline: "一键 OAuth 接入研发迭代 Issue、周期进度与优先级追踪",
    description: "通过 Linear 官方 OAuth 2.1 + MCP 自动发现工具，在对话中直接追踪冲刺任务、Bug 分配与状态流转。",
    category: "dev",
    categoryLabel: "研发与设计",
    publisher: "Linear",
    authMode: "mcp-oauth",
    authLabel: "官方 OAuth 2.1 (MCP)",
    mcpPreset: { serverId: "preset-mcp-linear", name: "Linear", url: "https://mcp.linear.app/mcp", trustedReadOnly: false },
    starterPrompts: ["查看当前迭代分配给我的高优先级 Issue 列表"],
    capabilities: [
      cap("list_issues", "查询项目与冲刺 Issue 详情", "read"),
      cap("mutate_issue", "创建或变更 Issue 状态", "write", "ask"),
    ],
  },
  {
    id: "figma",
    name: "Figma",
    tagline: "通过 Figma 官方 MCP 读取设计稿节点树、变量 Token 与标注说明",
    description: "点击连接将通过 Figma 官方 OAuth 2.1 (mcp.figma.com) 授权接入设计稿上下文与组件变量。",
    category: "dev",
    categoryLabel: "研发与设计",
    publisher: "Figma",
    authMode: "mcp-oauth",
    authLabel: "官方 OAuth 2.1 (MCP)",
    mcpPreset: { serverId: "preset-mcp-figma", name: "Figma", url: "https://mcp.figma.com/mcp", trustedReadOnly: true },
    starterPrompts: ["查看我最近打开的 Figma 设计稿重点"],
    capabilities: [cap("read_design", "读取设计稿节点树与设计变量", "read")],
  },
  {
    id: "canva",
    name: "Canva",
    tagline: "一键 OAuth 查找可画设计作品、文案与导出幻灯片",
    description: "连接 Canva 官方 MCP，可在对话中检索现有设计并协同编辑海报、演示文稿。",
    category: "office",
    categoryLabel: "办公与协作",
    publisher: "Canva",
    authMode: "mcp-oauth",
    authLabel: "官方 OAuth 2.1 (MCP)",
    mcpPreset: { serverId: "preset-mcp-canva", name: "Canva", url: "https://mcp.canva.com/mcp", trustedReadOnly: false },
    starterPrompts: ["帮我检索最近的 Canva 演示文稿设计"],
    capabilities: [
      cap("read_designs", "检索与查看设计工程", "read"),
      cap("edit_designs", "生成或修改设计内容", "write", "ask"),
    ],
  },
  {
    id: "atlassian",
    name: "Atlassian (Jira / Confluence)",
    tagline: "一键 OAuth 连接团队 Jira 工单与 Confluence 知识库",
    description: "通过 Atlassian 官方 Rovo MCP 一键授权访问 Jira 项目进度与 Confluence 技术文档。",
    category: "office",
    categoryLabel: "办公与协作",
    publisher: "Atlassian",
    authMode: "mcp-oauth",
    authLabel: "官方 OAuth 2.1 (MCP)",
    mcpPreset: { serverId: "preset-mcp-atlassian", name: "Atlassian", url: "https://mcp.atlassian.com/v1/mcp", trustedReadOnly: false },
    starterPrompts: ["汇总本季度未关闭的 Jira 阻塞工单"],
    capabilities: [
      cap("read_jira", "读取 Jira 工单与 Confluence 页面", "read"),
      cap("write_jira", "更新工单状态或发表评论", "write", "ask"),
    ],
  },
  {
    id: "sentry",
    name: "Sentry",
    tagline: "一键 OAuth 定位线上异常堆栈、报错趋势与根因分析",
    description: "连接 Sentry 官方 MCP，分身可直接读取告警 Issue 堆栈并定位修复建议。",
    category: "dev",
    categoryLabel: "研发与设计",
    publisher: "Sentry",
    authMode: "mcp-oauth",
    authLabel: "官方 OAuth 2.1 (MCP)",
    mcpPreset: { serverId: "preset-mcp-sentry", name: "Sentry", url: "https://mcp.sentry.dev/mcp", trustedReadOnly: true },
    starterPrompts: ["总结过去 24 小时 Sentry 新增的高频 Crash"],
    capabilities: [cap("read_issues", "读取错误堆栈与告警事件", "read")],
  },
  {
    id: "excalidraw",
    name: "Excalidraw",
    tagline: "免登录一键连接架构白板 MCP，直接在聊天里绘制流程图",
    description: "官方公开 MCP 服务，点击「连接」立即可用，支持创建与渲染架构示意图。",
    category: "dev",
    categoryLabel: "研发与设计",
    publisher: "Excalidraw",
    authMode: "mcp-direct",
    authLabel: "一键 MCP（免登录）",
    mcpPreset: { serverId: "preset-mcp-excalidraw", name: "Excalidraw", url: "https://mcp.excalidraw.com/mcp", trustedReadOnly: false },
    starterPrompts: ["用 Excalidraw 画一张前后端三平面交互示意图"],
    capabilities: [
      cap("read_board", "读取画布状态", "read"),
      cap("draw_board", "创建与编辑白板图表", "write", "allow"),
    ],
  },
  {
    id: "deepwiki",
    name: "DeepWiki",
    tagline: "免登录一键查询开源代码库架构原理与实现细节",
    description: "公开 MCP 知识库，随时深度检索主流 GitHub 开源仓库模块关系与原理。",
    category: "dev",
    categoryLabel: "研发与设计",
    publisher: "Devin / DeepWiki",
    authMode: "mcp-direct",
    authLabel: "一键 MCP（免登录）",
    mcpPreset: { serverId: "preset-mcp-deepwiki", name: "DeepWiki", url: "https://mcp.deepwiki.com/mcp", trustedReadOnly: true },
    starterPrompts: ["用 DeepWiki 查一下 modelcontextprotocol/typescript-sdk 架构"],
    capabilities: [cap("read_wiki", "检索开源项目文档与架构问答", "read")],
  },
  {
    id: "outlook",
    name: "Outlook",
    tagline: "通过标准 IMAP/STARTTLS 同步 Microsoft 365 工作邮箱并经批准发信",
    description: "基于标准 ImapFlow + Nodemailer 接入 Microsoft 365 / Outlook 邮箱（凭据加密存于系统保险箱），自动巡检重要来信。",
    category: "office",
    categoryLabel: "办公与协作",
    publisher: "Microsoft",
    authMode: "imap-modal",
    authLabel: "标准 IMAP / SMTP",
    starterPrompts: ["梳理今天 Outlook 收件箱里的待办与会议邀约"],
    capabilities: [
      cap("read_mail", "读取 Outlook 收件箱摘要", "read"),
      cap("send_mail", "经批准后代发工作回复", "write", "ask"),
    ],
  },
  {
    id: "slack",
    name: "Slack",
    tagline: "通过 Slack 官方 MCP 搜索频道讨论，并经「批准」后向团队同步进展",
    description: "通过 Slack 官方 OAuth 2.1 (mcp.slack.com) 或 Incoming Webhook 连接工作区，汇总重点讨论并在外发前进入「批准」栏核验。",
    category: "office",
    categoryLabel: "办公与协作",
    publisher: "Slack",
    authMode: "mcp-oauth",
    authLabel: "官方 OAuth 2.1 (MCP)",
    mcpPreset: { serverId: "preset-mcp-slack", name: "Slack", url: "https://mcp.slack.com/mcp", trustedReadOnly: false },
    starterPrompts: ["把本周代码推进写成一段简明的 Slack #eng-updates 同步"],
    capabilities: [
      cap("read_channels", "查看频道与讨论上下文", "read"),
      cap("post_message", "经批准后向频道发送消息", "write", "ask"),
    ],
  },
  {
    id: "meeting_notes",
    name: "本地会议纪要",
    tagline: "一键选择本地纪要文件夹，自动提炼会议决策与跟进目标",
    description: "点击连接只需选择一个本地文件夹，有新的 .md / .txt / .srt / .vtt 转写纪要时分身自动归纳行动项。",
    category: "office",
    categoryLabel: "办公与协作",
    publisher: "千机本地知识",
    authMode: "folder-picker",
    authLabel: "选择本地文件夹",
    starterPrompts: ["回顾最近新增的会议纪要，列出需要我跟进的待办"],
    capabilities: [cap("read_notes", "读取所选纪要文件夹变更", "read")],
  },
  {
    id: "netlify",
    name: "Netlify",
    tagline: "一键 OAuth 查看站点发布状态、环境变量与域名配置",
    description: "连接 Netlify 官方 MCP，实时跟进站点构建详情。",
    category: "automation",
    categoryLabel: "商业与自动化",
    publisher: "Netlify",
    authMode: "mcp-oauth",
    authLabel: "官方 OAuth 2.1 (MCP)",
    mcpPreset: { serverId: "preset-mcp-netlify", name: "Netlify", url: "https://netlify-mcp.netlify.app/mcp", trustedReadOnly: false },
    starterPrompts: ["检查我最近一次 Netlify 站点发布是否成功"],
    capabilities: [
      cap("read_sites", "读取站点与构建列表", "read"),
      cap("deploy_site", "触发构建或变更环境设置", "write", "ask"),
    ],
  },
  {
    id: "imap_email",
    name: "QQ / 163 / 企业邮箱 (IMAP)",
    tagline: "基于 ImapFlow + Nodemailer 一键接入 QQ 邮箱、网易 163 与企业 IMAP/SMTP",
    description: "采用工业级 ImapFlow / Mailparser / Nodemailer 协议栈，填入地址与授权码即可加密存入系统保险箱并开启收件箱巡检。",
    category: "automation",
    categoryLabel: "商业与自动化",
    publisher: "标准邮件协议",
    authMode: "imap-modal",
    authLabel: "标准 IMAP / SMTP",
    starterPrompts: ["检查我的邮箱今天是否有新账单、通知或待回复来信"],
    capabilities: [
      cap("read_mail", "定时巡检收件箱", "read"),
      cap("send_mail", "经批准后通过 SMTP 发送回复", "write", "ask"),
    ],
  },
  {
    id: "custom_webhook",
    name: "Zapier / 自定义 Webhook",
    tagline: "连接 Zapier、n8n、Make 或内部工作流网关，经批准后触发",
    description: "绑定标准 HTTPS Catch Hook，当分身建议触发自动化流程时先放入「批准」栏等你确认。",
    category: "automation",
    categoryLabel: "商业与自动化",
    publisher: "Zapier / n8n",
    authMode: "webhook-modal",
    authLabel: "弹窗 Webhook 配置",
    starterPrompts: ["整理今天的要点并通过 Webhook 同步到我的工作流网关"],
    capabilities: [cap("trigger_hook", "经批准后触发外部 Webhook", "write", "ask")],
  },
];
