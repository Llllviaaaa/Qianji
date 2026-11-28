/**
 * Real cloud app & automation connectors for Qianji Bot Mode
 * (`packages/host/src/bot/connectors/cloud-connectors.ts`).
 *
 * Covers GitHub (issues/PRs & comments), Notion (page search & creation),
 * Slack (Incoming Webhooks), and Custom / Zapier Webhooks.
 */
import type {
  BotConnectorsConfig,
  BotCustomWebhookConnectorConfig,
  BotGitHubConnectorConfig,
  BotNotionConnectorConfig,
  PendingBotApproval,
} from "@qianji/protocol";
import { sendSmtpEmail } from "./email-connector.ts";
import { sendFeishuWebhook, sendTelegramMessage } from "./meetings-and-im.ts";

export interface GitHubIssueEntry {
  id: string;
  repo: string;
  number: number;
  isPullRequest: boolean;
  title: string;
  author: string;
  url: string;
  updatedAt: number;
}

export interface NotionPageEntry {
  id: string;
  title: string;
  url: string;
  lastEditedAt: number;
}

function normalizeBase(raw: string | undefined, fallback: string): string {
  return (raw?.trim() || fallback).replace(/\/+$/, "");
}

export async function fetchGitHubViewerLogin(apiBase: string | undefined, token: string): Promise<string | undefined> {
  if (!token.trim()) return undefined;
  const base = normalizeBase(apiBase, "https://api.github.com");
  const res = await fetch(`${base}/user`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Qianji-Bot",
      Authorization: `Bearer ${token.trim()}`,
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) return undefined;
  const data = (await res.json()) as { login?: string };
  return data.login;
}

export async function syncGitHubRepos(
  config: BotGitHubConnectorConfig,
  token?: string,
): Promise<{ items: GitHubIssueEntry[]; totalCount: number; discoveredRepos?: string[] }> {
  const base = normalizeBase(config.apiBase, "https://api.github.com");
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Qianji-Bot",
  };
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }

  let repos = config.watchedRepos.map((r) => r.trim()).filter(Boolean).slice(0, 5);
  let discoveredRepos: string[] | undefined;
  if (repos.length === 0 && token?.trim()) {
    const repoRes = await fetch(`${base}/user/repos?sort=updated&per_page=5`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (repoRes.ok) {
      const list = (await repoRes.json()) as Array<{ full_name?: string }>;
      repos = (Array.isArray(list) ? list : [])
        .map((r) => r.full_name?.trim() ?? "")
        .filter(Boolean)
        .slice(0, 5);
      if (repos.length > 0) discoveredRepos = repos;
    }
  }
  if (repos.length === 0) {
    throw new Error("请先在独立浏览器登录 GitHub，或授权读取你最近活跃的仓库");
  }

  const items: GitHubIssueEntry[] = [];
  for (const repo of repos) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
      throw new Error(`仓库格式无效「${repo}」，请使用 owner/repo 格式`);
    }
    const res = await fetch(`${base}/repos/${repo}/issues?state=open&per_page=5`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`GitHub API 请求失败 (${repo})：HTTP ${res.status}`);
    }
    const list = (await res.json()) as Array<{
      id?: number;
      number?: number;
      title?: string;
      html_url?: string;
      updated_at?: string;
      user?: { login?: string };
      pull_request?: unknown;
    }>;
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const num = Number(entry.number ?? 0);
      if (!num || !entry.title) continue;
      const ts = entry.updated_at ? Date.parse(entry.updated_at) : NaN;
      items.push({
        id: `gh-${repo}#${num}`,
        repo,
        number: num,
        isPullRequest: entry.pull_request !== undefined,
        title: entry.title,
        author: entry.user?.login || "github",
        url: entry.html_url || `https://github.com/${repo}/issues/${num}`,
        updatedAt: Number.isFinite(ts) ? ts : Date.now(),
      });
    }
  }
  return { items, totalCount: items.length, ...(discoveredRepos ? { discoveredRepos } : {}) };
}

export async function postGitHubIssueComment(
  config: BotGitHubConnectorConfig,
  token: string,
  target: string,
  body: string,
): Promise<void> {
  if (!token.trim()) throw new Error("GitHub 评论需要配置 Personal Access Token");
  const m = /^([^/\s]+\/[^/\s]+)#(\d+)$/.exec(target.trim());
  if (!m?.[1] || !m[2]) {
    throw new Error("GitHub 评论目标格式必须为 owner/repo#编号（如 acme/app#42）");
  }
  const base = normalizeBase(config.apiBase, "https://api.github.com");
  const res = await fetch(`${base}/repos/${m[1]}/issues/${m[2]}/comments`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "Qianji-Bot",
      Authorization: `Bearer ${token.trim()}`,
    },
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`GitHub 评论提交失败：HTTP ${res.status}`);
  }
}

function extractNotionTitle(page: {
  id?: string;
  properties?: Record<string, { type?: string; title?: Array<{ plain_text?: string }> }>;
  title?: Array<{ plain_text?: string }>;
}): string {
  if (Array.isArray(page.title)) {
    const t = page.title.map((x) => x.plain_text ?? "").join("").trim();
    if (t) return t;
  }
  if (page.properties && typeof page.properties === "object") {
    for (const prop of Object.values(page.properties)) {
      if (prop?.type === "title" && Array.isArray(prop.title)) {
        const t = prop.title.map((x) => x.plain_text ?? "").join("").trim();
        if (t) return t;
      }
    }
  }
  return page.id || "Notion 页面";
}

export async function syncNotionPages(
  config: BotNotionConnectorConfig,
  token: string,
): Promise<NotionPageEntry[]> {
  if (!token.trim()) throw new Error("请填写 Notion Integration Token");
  const base = normalizeBase(config.apiBase, "https://api.notion.com/v1");
  const res = await fetch(`${base}/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      page_size: 6,
      sort: { direction: "descending", timestamp: "last_edited_time" },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Notion API 请求失败：HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    results?: Array<{
      id?: string;
      url?: string;
      last_edited_time?: string;
      properties?: Record<string, { type?: string; title?: Array<{ plain_text?: string }> }>;
      title?: Array<{ plain_text?: string }>;
    }>;
  };
  const pages: NotionPageEntry[] = [];
  for (const item of data.results ?? []) {
    if (!item.id) continue;
    const ts = item.last_edited_time ? Date.parse(item.last_edited_time) : NaN;
    pages.push({
      id: item.id,
      title: extractNotionTitle(item),
      url: item.url || `https://www.notion.so/${item.id.replace(/-/g, "")}`,
      lastEditedAt: Number.isFinite(ts) ? ts : Date.now(),
    });
  }
  return pages;
}

export async function createNotionPageNote(
  config: BotNotionConnectorConfig,
  token: string,
  parentPageId: string,
  title: string,
  body: string,
): Promise<void> {
  if (!token.trim()) throw new Error("创建 Notion 页面需要配置 Integration Token");
  const parentId = (parentPageId.trim() || config.parentPageId.trim());
  if (!parentId) throw new Error("请先在 Notion 连接器或批准项中指定父页面 ID (parentPageId)");
  const base = normalizeBase(config.apiBase, "https://api.notion.com/v1");
  const res = await fetch(`${base}/pages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { page_id: parentId },
      properties: {
        title: { title: [{ text: { content: title.slice(0, 180) } }] },
      },
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: body.slice(0, 1900) } }] },
        },
      ],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Notion 页面创建失败：HTTP ${res.status}`);
  }
}

export async function sendSlackWebhook(webhookUrl: string, text: string): Promise<void> {
  const url = webhookUrl.trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("请填写有效的 Slack Incoming Webhook HTTPS 地址");
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Slack Webhook 推送失败：HTTP ${res.status}`);
  }
}

export async function triggerCustomWebhook(
  config: BotCustomWebhookConnectorConfig,
  bearerToken: string | undefined,
  payload: { title: string; summary: string; body: string },
): Promise<void> {
  const url = config.endpointUrl.trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("请填写有效的 Webhook HTTPS 地址");
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearerToken?.trim()) {
    headers.Authorization = `Bearer ${bearerToken.trim()}`;
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: "qianji-bot",
      connector: config.label || "custom-webhook",
      ...payload,
      ts: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`自定义 Webhook 调用失败：HTTP ${res.status}`);
  }
}

export async function dispatchApprovedConnectorAction(
  approval: PendingBotApproval,
  cfg: BotConnectorsConfig,
  secrets: {
    emailPassword?: string;
    telegramToken?: string;
    feishuWebhook?: string;
    githubToken?: string;
    notionToken?: string;
    slackWebhook?: string;
    customWebhookToken?: string;
  },
): Promise<string> {
  if (approval.kind === "send-email") {
    if (!approval.recipient || !approval.draftBody) throw new Error("邮件批准项缺少收件人或正文草稿");
    await sendSmtpEmail(cfg.email, secrets.emailPassword ?? "", {
      to: approval.recipient,
      subject: approval.subject || "Re: 回复",
      body: approval.draftBody,
    });
    return `刚刚 · 已通过 SMTP 发送邮件至 ${approval.recipient}`;
  }
  if (approval.kind === "send-telegram") {
    const chatId = approval.recipient || cfg.meetingsIm.telegramChatId;
    if (!secrets.telegramToken || !chatId || !approval.draftBody) {
      throw new Error("Telegram 发送缺少 Token、Chat ID 或消息正文");
    }
    await sendTelegramMessage(cfg.meetingsIm.telegramApiBase, secrets.telegramToken, chatId, approval.draftBody);
    return `刚刚 · 已发送 Telegram 消息给 ${chatId}`;
  }
  if (approval.kind === "send-feishu") {
    if (!secrets.feishuWebhook || !approval.draftBody) throw new Error("飞书推送缺少加密 Webhook 或消息正文");
    await sendFeishuWebhook(secrets.feishuWebhook, approval.draftBody);
    return "刚刚 · 已通过飞书机器人推送消息";
  }
  if (approval.kind === "send-slack") {
    if (!secrets.slackWebhook || !approval.draftBody) throw new Error("Slack 推送缺少加密 Webhook 或消息正文");
    await sendSlackWebhook(secrets.slackWebhook, approval.draftBody);
    return "刚刚 · 已通过 Slack Webhook 推送消息";
  }
  if (approval.kind === "github-comment") {
    if (!cfg.github || !secrets.githubToken || !approval.recipient || !approval.draftBody) {
      throw new Error("GitHub 评论缺少 Token、目标 Issue/PR (owner/repo#number) 或正文");
    }
    await postGitHubIssueComment(cfg.github, secrets.githubToken, approval.recipient, approval.draftBody);
    return `刚刚 · 已向 GitHub ${approval.recipient} 发布评论`;
  }
  if (approval.kind === "notion-page") {
    if (!cfg.notion || !secrets.notionToken || !approval.draftBody) {
      throw new Error("Notion 归档缺少 Integration Token 或正文内容");
    }
    await createNotionPageNote(cfg.notion, secrets.notionToken, approval.recipient ?? "", approval.subject || approval.title, approval.draftBody);
    return `刚刚 · 已在 Notion 创建新页面「${approval.subject || approval.title}」`;
  }
  if (approval.kind === "trigger-webhook") {
    if (!cfg.customWebhook || !cfg.customWebhook.endpointUrl.trim()) {
      throw new Error("自定义 Webhook 地址未配置");
    }
    await triggerCustomWebhook(cfg.customWebhook, secrets.customWebhookToken, {
      title: approval.title,
      summary: approval.summary,
      body: approval.draftBody || approval.summary,
    });
    return `刚刚 · 已触发外部 Webhook「${cfg.customWebhook.label || cfg.customWebhook.endpointUrl}」`;
  }
  return "刚刚 · 已批准执行";
}
