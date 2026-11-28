/**
 * Proactive companion tools exclusively exposed inside `BotCompanionHarness`
 * (`packages/host/src/bot/harness/bot-tools.ts`).
 */
import type { ToolSchema } from "@qianji/llm";
import { textOutput, type ToolEnv, type ToolOutput } from "@qianji/tools";
import type {
  BotComputerEngineId, BotFeedActionKind, BotFeedAttachment, BotFeedCreateParams, BotFeedEditionKind,
  BotFeedMetricRow, BotFeedMetricsCard, BotFeedOrigin, BotFeedSourceLink,
  BotGoalMomentumStatus, BotGoalSource, BotIdeaCapabilityItem, BotIdeaCapabilityKind, PendingBotApproval,
} from "@qianji/protocol";

export interface BotManageScheduleInput {
  action: "list" | "create" | "update" | "toggle" | "delete" | "run_now";
  id?: string; name?: string; prompt?: string;
  frequency?: "interval" | "hourly" | "daily" | "weekdays" | "weekly" | "once";
  intervalMinutes?: number; hour?: number; minute?: number; weekday?: number;
  runAtIso?: string; delayMinutes?: number; enabled?: boolean;
  permissionMode?: "read-only" | "ask" | "workspace-write";
}

export interface BotManageGoalInput {
  action: "create" | "update" | "complete" | "reopen" | "add_subgoal" | "toggle_subgoal";
  id?: string; title?: string; category?: string; summary?: string; description?: string;
  source?: BotGoalSource; momentumStatus?: BotGoalMomentumStatus; sessionId?: string;
  timelineTitle?: string; timelineDetail?: string; subGoalTitle?: string; subGoalId?: string;
}

export interface BotProposeIdeaInput {
  title: string; description: string; seedPrompt: string;
  category?: string; sourceLabel?: string; icon?: string; reason?: string;
  howItWorks?: string; capabilities?: BotIdeaCapabilityItem[];
}

export interface BotNativeToolsHost {
  senseApps(source: "all" | "email" | "calendar" | "processes" | "meetings_im" | "github" | "notion"): Promise<string>;
  stageOutboundApproval(input: {
    kind: NonNullable<PendingBotApproval["kind"]>; title: string; summary: string;
    recipient?: string; subject?: string; draftBody?: string; command?: string;
  }): Promise<PendingBotApproval>;
  manageGoal(input: BotManageGoalInput): Promise<string>;
  manageSpace(input: { action: "create" | "append"; title: string; description?: string; note?: string }): Promise<string>;
  publishBriefing(input: BotFeedCreateParams): Promise<string>;
  proposeIdea(input: BotProposeIdeaInput): Promise<string>;
  rememberPreference(preference: string): Promise<boolean>;
  watchProcess(processName: string, remove?: boolean): Promise<string[]>;
  manageSchedule(input: BotManageScheduleInput): Promise<string>;
  requestTakeover(input: {
    reason: string;
    targetUrlOrApp: string;
    engine?: BotComputerEngineId;
    sessionId?: string;
  }): Promise<string>;
}

export const BOT_NATIVE_TOOL_SCHEMAS: readonly ToolSchema[] = [
  {
    name: "bot_sense_apps",
    description: "Inspect the user's connected Email inbox, ICS Calendar & conflicts, active OS processes/focus state, meeting transcripts & external IM, GitHub issues/PRs, or Notion pages.",
    parameters: {
      type: "object",
      properties: { source: { type: "string", enum: ["all", "email", "calendar", "processes", "meetings_im", "github", "notion"] } },
      required: ["source"],
    },
  },
  {
    name: "bot_stage_outbound_approval",
    description: "Stage an outbound action (email reply draft, Telegram/Feishu/Slack message, GitHub comment, Notion page, custom Webhook, or shell command) into the Bot '批准' queue for the user's one-click confirmation. NEVER send external messages without staging here first.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["send-email", "send-telegram", "send-feishu", "send-slack", "github-comment", "notion-page", "trigger-webhook", "shell"] },
        title: { type: "string" }, summary: { type: "string" },
        recipient: { type: "string" }, subject: { type: "string" }, draftBody: { type: "string" }, command: { type: "string" },
      },
      required: ["kind", "title", "summary"],
    },
  },
  {
    name: "bot_manage_schedule",
    description: "Create, list, update, pause/resume (toggle), delete, or immediately run scheduled background routines & timed reminders in Qianji Bot Mode.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "create", "update", "toggle", "delete", "run_now"] },
        id: { type: "string" }, name: { type: "string" }, prompt: { type: "string" },
        frequency: { type: "string", enum: ["interval", "hourly", "daily", "weekdays", "weekly", "once"] },
        intervalMinutes: { type: "integer" }, hour: { type: "integer" }, minute: { type: "integer" }, weekday: { type: "integer" },
        runAtIso: { type: "string" }, delayMinutes: { type: "number" }, enabled: { type: "boolean" },
        permissionMode: { type: "string", enum: ["read-only", "ask", "workspace-write"] },
      },
      required: ["action"],
    },
  },
  {
    name: "bot_manage_goal",
    description: "Create, update live blocker summary & timeline milestones, complete/reopen, or add/toggle sub-goals on a multi-day Goal.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "update", "complete", "reopen", "add_subgoal", "toggle_subgoal"] },
        id: { type: "string" }, title: { type: "string" }, category: { type: "string" },
        summary: { type: "string", description: "1-line live blocker or next-step progress status." },
        description: { type: "string", description: "Detailed background context & constraints." },
        source: { type: "string", enum: ["assistant_tracking", "chat_interview", "manual"] },
        momentumStatus: { type: "string", enum: ["on_track", "waiting_user", "stalled"] },
        timelineTitle: { type: "string" }, timelineDetail: { type: "string" },
        subGoalTitle: { type: "string" }, subGoalId: { type: "string" },
      },
      required: ["action"],
    },
  },
  {
    name: "bot_manage_space",
    description: "Create a persistent topic Space or append structured progress notes to an existing Space markdown archive.",
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: ["create", "append"] }, title: { type: "string" }, description: { type: "string" }, note: { type: "string" } },
      required: ["action", "title"],
    },
  },
  {
    name: "bot_publish_briefing",
    description: "Publish a V2 Muse briefing card to '动态 (Feed)' with 2-sentence Markdown-linked body, kicker, category, origin, provenance reason ('为何我创建这篇帖子'), and optional hero_image / sandboxed HTML widget / metricsCard.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" }, body: { type: "string" }, kicker: { type: "string" }, category: { type: "string" },
        editionKind: { type: "string", enum: ["morning", "midday", "evening", "adhoc"] },
        origin: { type: "string", enum: ["generated", "idea"] },
        seedPrompt: { type: "string" }, ideaId: { type: "string" },
        actionKind: { type: "string", enum: ["start", "discuss"] }, icon: { type: "string" }, reason: { type: "string" },
        attachment: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["none", "hero_image", "carousel", "widget"] },
            heroImageUrl: { type: "string" }, imageAlt: { type: "string" }, aspectRatio: { type: "number" },
            imageUrls: { type: "array", items: { type: "string" } },
            widgetTitle: { type: "string" }, widgetHtml: { type: "string" },
          },
          required: ["kind"],
        },
        sourceLinks: { type: "array", items: { type: "object", properties: { label: { type: "string" }, url: { type: "string" } }, required: ["label", "url"] } },
        metricsCard: {
          type: "object",
          properties: {
            title: { type: "string" },
            rows: {
              type: "array",
              items: {
                type: "object",
                properties: { label: { type: "string" }, sublabel: { type: "string" }, badge: { type: "string" }, value: { type: "string" }, highlight: { type: "boolean" } },
                required: ["label", "value"],
              },
            },
          },
          required: ["title", "rows"],
        },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "bot_propose_idea",
    description: "Propose a personalized V2 Idea Blueprint ('我可以...' / '给你一份...') into the user's Bot '点子 (Ideas)' store with concrete deliverable capabilities and howItWorks execution contract.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" }, description: { type: "string" }, seedPrompt: { type: "string" },
        category: { type: "string" }, sourceLabel: { type: "string" }, icon: { type: "string" },
        reason: { type: "string" }, howItWorks: { type: "string" },
        capabilities: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["space", "schedule", "doc", "goal", "workbench", "reminder"] },
              title: { type: "string" }, subtitle: { type: "string" }, ready: { type: "boolean" },
            },
            required: ["kind", "title", "subtitle"],
          },
        },
      },
      required: ["title", "description", "seedPrompt"],
    },
  },
  {
    name: "bot_remember_preference",
    description: "Persist a newly learned user habit, communication preference, key person, or quiet-time rule into transparent long-term memory.",
    parameters: { type: "object", properties: { preference: { type: "string" } }, required: ["preference"] },
  },
  {
    name: "bot_watch_process",
    description: "Start or stop watching a long-running OS process (e.g. 'cargo', 'python', 'ffmpeg', 'tar') so you can proactively notify the user when it finishes.",
    parameters: { type: "object", properties: { processName: { type: "string" }, remove: { type: "boolean" } }, required: ["processName"] },
  },
  {
    name: "bot_request_takeover",
    description: "Pause automated execution on login, 2FA, QR scan, or CAPTCHA walls and invite the user to seamlessly take over inside Qianji's Virtual Computer Studio without exposing credentials to the LLM.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string" },
        targetUrlOrApp: { type: "string" },
        engine: { type: "string", enum: ["local-linux", "local-win-pip", "remote-vm", "remote-pc"] },
      },
      required: ["reason", "targetUrlOrApp"],
    },
  },
];

export const BOT_NATIVE_TOOL_NAMES = new Set(BOT_NATIVE_TOOL_SCHEMAS.map((t) => t.name));
const VALID_IDEA_CAP_KINDS = new Set<BotIdeaCapabilityKind>(["space", "schedule", "doc", "goal", "workbench", "reminder"]);

function extractSourceLinks(raw: unknown): BotFeedSourceLink[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const links = raw.flatMap((it) => {
    if (!it || typeof it !== "object" || Array.isArray(it)) return [];
    const rec = it as Record<string, unknown>;
    return typeof rec.label === "string" && typeof rec.url === "string" && rec.url.trim() !== "" ? [{ label: rec.label, url: rec.url }] : [];
  });
  return links.length > 0 ? links : undefined;
}

function extractMetricsCard(raw: unknown): BotFeedMetricsCard | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.title !== "string" || !Array.isArray(rec.rows)) return undefined;
  const rows: BotFeedMetricRow[] = rec.rows.flatMap((r) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) return [];
    const row = r as Record<string, unknown>;
    if (typeof row.label !== "string" || typeof row.value !== "string") return [];
    return [{
      label: row.label, value: row.value,
      ...(typeof row.sublabel === "string" ? { sublabel: row.sublabel } : {}),
      ...(typeof row.badge === "string" ? { badge: row.badge } : {}),
      ...(typeof row.highlight === "boolean" ? { highlight: row.highlight } : {}),
    }];
  });
  return rows.length > 0 ? { title: rec.title, rows } : undefined;
}

function extractAttachment(raw: unknown): BotFeedAttachment | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  if (rec.kind === "none") return { kind: "none" };
  if (rec.kind === "hero_image" && typeof rec.heroImageUrl === "string" && rec.heroImageUrl.trim() !== "") {
    return {
      kind: "hero_image", heroImageUrl: rec.heroImageUrl,
      ...(typeof rec.imageAlt === "string" ? { imageAlt: rec.imageAlt } : {}),
      ...(typeof rec.aspectRatio === "number" ? { aspectRatio: rec.aspectRatio } : {}),
    };
  }
  if (rec.kind === "carousel" && Array.isArray(rec.imageUrls)) {
    const imageUrls = rec.imageUrls.filter((u): u is string => typeof u === "string" && u.trim() !== "");
    return imageUrls.length > 0 ? { kind: "carousel", imageUrls } : undefined;
  }
  if (rec.kind === "widget" && typeof rec.widgetHtml === "string" && rec.widgetHtml.trim() !== "") {
    return { kind: "widget", ...(typeof rec.widgetTitle === "string" ? { widgetTitle: rec.widgetTitle } : {}), widgetHtml: rec.widgetHtml };
  }
  return undefined;
}

function extractCapabilities(raw: unknown): BotIdeaCapabilityItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const caps = raw.flatMap((it): BotIdeaCapabilityItem[] => {
    if (!it || typeof it !== "object" || Array.isArray(it)) return [];
    const rec = it as Record<string, unknown>;
    const kind = rec.kind as BotIdeaCapabilityKind;
    if (!VALID_IDEA_CAP_KINDS.has(kind) || typeof rec.title !== "string" || typeof rec.subtitle !== "string") return [];
    return [{ kind, title: rec.title, subtitle: rec.subtitle, ready: typeof rec.ready === "boolean" ? rec.ready : true }];
  });
  return caps.length > 0 ? caps : undefined;
}

export async function executeBotNativeTool(
  name: string,
  args: Record<string, unknown>,
  env: ToolEnv,
  host: BotNativeToolsHost,
): Promise<ToolOutput> {
  if (name === "bot_sense_apps") {
    const srcRaw = String(args.source ?? "all");
    const source = srcRaw === "email" || srcRaw === "calendar" || srcRaw === "processes" || srcRaw === "meetings_im" || srcRaw === "github" || srcRaw === "notion" ? srcRaw : "all";
    return textOutput(await host.senseApps(source));
  }

  if (name === "bot_stage_outbound_approval") {
    const kRaw = String(args.kind ?? "send-email");
    const kind = kRaw === "send-telegram" || kRaw === "send-feishu" || kRaw === "send-slack" || kRaw === "github-comment" || kRaw === "notion-page" || kRaw === "trigger-webhook" || kRaw === "shell" ? kRaw : "send-email";
    const staged = await host.stageOutboundApproval({
      kind, title: String(args.title ?? "外发确认"), summary: String(args.summary ?? "分身已为您备好外发内容草稿，确认后立即发送。"),
      ...(typeof args.recipient === "string" ? { recipient: args.recipient } : {}),
      ...(typeof args.subject === "string" ? { subject: args.subject } : {}),
      ...(typeof args.draftBody === "string" ? { draftBody: args.draftBody } : {}),
      ...(typeof args.command === "string" ? { command: args.command } : {}),
    });
    return textOutput(`Staged outbound approval (id: ${staged.id}) in right-side 「批准」 tab: ${staged.title}`);
  }

  if (name === "bot_manage_schedule") {
    const aRaw = String(args.action ?? "list");
    const action: BotManageScheduleInput["action"] = aRaw === "create" || aRaw === "update" || aRaw === "toggle" || aRaw === "delete" || aRaw === "run_now" ? aRaw : "list";
    const fRaw = args.frequency;
    const frequency: BotManageScheduleInput["frequency"] = fRaw === "interval" || fRaw === "hourly" || fRaw === "daily" || fRaw === "weekdays" || fRaw === "weekly" || fRaw === "once" ? fRaw : undefined;
    const pRaw = args.permissionMode;
    const permissionMode: BotManageScheduleInput["permissionMode"] = pRaw === "read-only" || pRaw === "ask" || pRaw === "workspace-write" ? pRaw : undefined;
    return textOutput(
      await host.manageSchedule({
        action,
        ...(typeof args.id === "string" ? { id: args.id } : {}),
        ...(typeof args.name === "string" ? { name: args.name } : {}),
        ...(typeof args.prompt === "string" ? { prompt: args.prompt } : {}),
        ...(frequency !== undefined ? { frequency } : {}),
        ...(typeof args.intervalMinutes === "number" ? { intervalMinutes: args.intervalMinutes } : {}),
        ...(typeof args.hour === "number" ? { hour: args.hour } : {}),
        ...(typeof args.minute === "number" ? { minute: args.minute } : {}),
        ...(typeof args.weekday === "number" ? { weekday: args.weekday } : {}),
        ...(typeof args.runAtIso === "string" ? { runAtIso: args.runAtIso } : {}),
        ...(typeof args.delayMinutes === "number" ? { delayMinutes: args.delayMinutes } : {}),
        ...(typeof args.enabled === "boolean" ? { enabled: args.enabled } : {}),
        ...(permissionMode !== undefined ? { permissionMode } : {}),
      }),
    );
  }

  if (name === "bot_manage_goal") {
    const aRaw = String(args.action ?? "create");
    const action: BotManageGoalInput["action"] = aRaw === "update" || aRaw === "complete" || aRaw === "reopen" || aRaw === "add_subgoal" || aRaw === "toggle_subgoal" ? aRaw : "create";
    const source: BotGoalSource | undefined = args.source === "assistant_tracking" || args.source === "chat_interview" || args.source === "manual" ? args.source : undefined;
    const momentumStatus: BotGoalMomentumStatus | undefined = args.momentumStatus === "on_track" || args.momentumStatus === "waiting_user" || args.momentumStatus === "stalled" ? args.momentumStatus : undefined;
    return textOutput(
      await host.manageGoal({
        action, sessionId: env.sessionId,
        ...(typeof args.id === "string" ? { id: args.id } : {}),
        ...(typeof args.title === "string" ? { title: args.title } : {}),
        ...(typeof args.category === "string" ? { category: args.category } : {}),
        ...(typeof args.summary === "string" ? { summary: args.summary } : {}),
        ...(typeof args.description === "string" ? { description: args.description } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(momentumStatus !== undefined ? { momentumStatus } : {}),
        ...(typeof args.timelineTitle === "string" ? { timelineTitle: args.timelineTitle } : {}),
        ...(typeof args.timelineDetail === "string" ? { timelineDetail: args.timelineDetail } : {}),
        ...(typeof args.subGoalTitle === "string" ? { subGoalTitle: args.subGoalTitle } : {}),
        ...(typeof args.subGoalId === "string" ? { subGoalId: args.subGoalId } : {}),
      }),
    );
  }

  if (name === "bot_manage_space") {
    return textOutput(
      await host.manageSpace({
        action: args.action === "append" ? "append" : "create",
        title: String(args.title ?? "未命名空间"),
        ...(typeof args.description === "string" ? { description: args.description } : {}),
        ...(typeof args.note === "string" ? { note: args.note } : {}),
      }),
    );
  }

  if (name === "bot_publish_briefing") {
    const actionKind: BotFeedActionKind | undefined = args.actionKind === "start" || args.actionKind === "discuss" ? args.actionKind : undefined;
    const origin: BotFeedOrigin | undefined = args.origin === "generated" || args.origin === "idea" ? args.origin : undefined;
    const editionKind: BotFeedEditionKind | undefined = args.editionKind === "morning" || args.editionKind === "midday" || args.editionKind === "evening" || args.editionKind === "adhoc" ? args.editionKind : undefined;
    const attachment = extractAttachment(args.attachment);
    const sourceLinks = extractSourceLinks(args.sourceLinks);
    const metricsCard = extractMetricsCard(args.metricsCard);
    return textOutput(
      await host.publishBriefing({
        title: String(args.title ?? "主动简报"), body: String(args.body ?? ""),
        ...(typeof args.kicker === "string" ? { kicker: args.kicker } : {}),
        ...(typeof args.category === "string" ? { category: args.category } : {}),
        ...(editionKind !== undefined ? { editionKind } : {}),
        ...(origin !== undefined ? { origin } : {}),
        ...(typeof args.seedPrompt === "string" ? { seedPrompt: args.seedPrompt } : {}),
        ...(typeof args.ideaId === "string" ? { ideaId: args.ideaId } : {}),
        ...(actionKind !== undefined ? { actionKind } : {}),
        ...(typeof args.icon === "string" ? { icon: args.icon } : {}),
        ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
        ...(attachment !== undefined ? { attachment } : {}),
        ...(sourceLinks !== undefined ? { sourceLinks } : {}),
        ...(metricsCard !== undefined ? { metricsCard } : {}),
      }),
    );
  }

  if (name === "bot_propose_idea") {
    const capabilities = extractCapabilities(args.capabilities);
    return textOutput(
      await host.proposeIdea({
        title: String(args.title ?? ""), description: String(args.description ?? ""),
        seedPrompt: String(args.seedPrompt ?? args.title ?? ""),
        ...(typeof args.category === "string" ? { category: args.category } : {}),
        ...(typeof args.sourceLabel === "string" ? { sourceLabel: args.sourceLabel } : {}),
        ...(typeof args.icon === "string" ? { icon: args.icon } : {}),
        ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
        ...(typeof args.howItWorks === "string" ? { howItWorks: args.howItWorks } : {}),
        ...(capabilities !== undefined ? { capabilities } : {}),
      }),
    );
  }

  if (name === "bot_remember_preference") {
    const ok = await host.rememberPreference(String(args.preference ?? ""));
    return textOutput(ok ? "Saved preference to transparent Bot memory." : "Preference already known or empty.");
  }

  if (name === "bot_watch_process") {
    const list = await host.watchProcess(String(args.processName ?? ""), args.remove === true);
    return textOutput(`Currently watched OS processes: ${list.length > 0 ? list.join(", ") : "(none)"}`);
  }

  if (name === "bot_request_takeover") {
    const rawEng = args.engine;
    const engine: BotComputerEngineId | undefined =
      rawEng === "local-linux" || rawEng === "local-win-pip" || rawEng === "remote-vm" || rawEng === "remote-pc"
        ? rawEng
        : undefined;
    return textOutput(
      await host.requestTakeover({
        reason: String(args.reason ?? "需要人工完成安全验证或登录"),
        targetUrlOrApp: String(args.targetUrlOrApp ?? ""),
        ...(engine ? { engine } : {}),
        sessionId: env.sessionId,
      }),
    );
  }

  return textOutput(`Unknown Bot tool: ${name}`, true);
}
