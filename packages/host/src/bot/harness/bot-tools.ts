/**
 * Proactive companion tools exclusively exposed inside `BotCompanionHarness`
 * (`packages/host/src/bot/harness/bot-tools.ts`).
 */
import type { ToolSchema } from "@qianji/llm";
import { textOutput, type ToolEnv, type ToolOutput } from "@qianji/tools";
import type { PendingBotApproval } from "@qianji/protocol";

export interface BotNativeToolsHost {
  senseApps(source: "all" | "email" | "calendar" | "processes" | "meetings_im"): Promise<string>;
  stageOutboundApproval(input: {
    kind: NonNullable<PendingBotApproval["kind"]>;
    title: string;
    summary: string;
    recipient?: string;
    subject?: string;
    draftBody?: string;
    command?: string;
  }): Promise<PendingBotApproval>;
  manageGoal(input: {
    action: "create" | "update" | "complete";
    id?: string;
    title: string;
    category?: string;
    summary?: string;
  }): Promise<string>;
  manageSpace(input: {
    action: "create" | "append";
    title: string;
    description?: string;
    note?: string;
  }): Promise<string>;
  publishBriefing(input: {
    title: string;
    body: string;
    actionLabel?: string;
    seedPrompt?: string;
  }): Promise<string>;
  rememberPreference(preference: string): Promise<boolean>;
  watchProcess(processName: string, remove?: boolean): Promise<string[]>;
}

export const BOT_NATIVE_TOOL_SCHEMAS: readonly ToolSchema[] = [
  {
    name: "bot_sense_apps",
    description: "Inspect the user's connected Email inbox, ICS Calendar & conflicts, active OS processes/focus state, or meeting transcripts & external IM.",
    parameters: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["all", "email", "calendar", "processes", "meetings_im"],
          description: "Which connected source to inspect live.",
        },
      },
      required: ["source"],
    },
  },
  {
    name: "bot_stage_outbound_approval",
    description: "Stage an outbound action (email reply draft, Telegram/Feishu message, or external shell command) into the Bot '批准' queue for the user's one-click confirmation. NEVER send external messages without staging here first.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["send-email", "send-telegram", "send-feishu", "shell"] },
        title: { type: "string", description: "Short clear card title shown in the Approvals tab." },
        summary: { type: "string", description: "Concise explanation of why you drafted this and what it affects." },
        recipient: { type: "string", description: "Email address or Telegram chat ID." },
        subject: { type: "string", description: "Email subject when kind='send-email'." },
        draftBody: { type: "string", description: "Full ready-to-send message/email draft body." },
        command: { type: "string", description: "Shell command when kind='shell'." },
      },
      required: ["kind", "title", "summary"],
    },
  },
  {
    name: "bot_manage_goal",
    description: "Proactively create, update, or complete a multi-day Goal for the user when you identify an ongoing objective.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "update", "complete"] },
        id: { type: "string" },
        title: { type: "string" },
        category: { type: "string" },
        summary: { type: "string" },
      },
      required: ["action", "title"],
    },
  },
  {
    name: "bot_manage_space",
    description: "Create a persistent topic Space or append structured progress notes to an existing Space markdown archive.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "append"] },
        title: { type: "string" },
        description: { type: "string" },
        note: { type: "string" },
      },
      required: ["action", "title"],
    },
  },
  {
    name: "bot_publish_briefing",
    description: "Publish an organized briefing card to the Bot '动态 (Feed)' stream with a follow-up prompt button.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        seedPrompt: { type: "string" },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "bot_remember_preference",
    description: "Persist a newly learned user habit, communication preference, key person, or quiet-time rule into transparent long-term memory.",
    parameters: {
      type: "object",
      properties: {
        preference: { type: "string" },
      },
      required: ["preference"],
    },
  },
  {
    name: "bot_watch_process",
    description: "Start or stop watching a long-running OS process (e.g. 'cargo', 'python', 'ffmpeg', 'tar') so you can proactively notify the user when it finishes.",
    parameters: {
      type: "object",
      properties: {
        processName: { type: "string" },
        remove: { type: "boolean" },
      },
      required: ["processName"],
    },
  },
];

export const BOT_NATIVE_TOOL_NAMES = new Set(BOT_NATIVE_TOOL_SCHEMAS.map((t) => t.name));

export async function executeBotNativeTool(
  name: string,
  args: Record<string, unknown>,
  _env: ToolEnv,
  host: BotNativeToolsHost,
): Promise<ToolOutput> {
  if (name === "bot_sense_apps") {
    const srcRaw = String(args.source ?? "all");
    const source =
      srcRaw === "email" || srcRaw === "calendar" || srcRaw === "processes" || srcRaw === "meetings_im"
        ? srcRaw
        : "all";
    return textOutput(await host.senseApps(source));
  }

  if (name === "bot_stage_outbound_approval") {
    const kRaw = String(args.kind ?? "send-email");
    const kind =
      kRaw === "send-telegram" || kRaw === "send-feishu" || kRaw === "shell" ? kRaw : "send-email";
    const staged = await host.stageOutboundApproval({
      kind,
      title: String(args.title ?? "外发确认"),
      summary: String(args.summary ?? "分身已为您备好外发内容草稿，确认后立即发送。"),
      ...(typeof args.recipient === "string" ? { recipient: args.recipient } : {}),
      ...(typeof args.subject === "string" ? { subject: args.subject } : {}),
      ...(typeof args.draftBody === "string" ? { draftBody: args.draftBody } : {}),
      ...(typeof args.command === "string" ? { command: args.command } : {}),
    });
    return textOutput(`Staged outbound approval (id: ${staged.id}) in right-side 「批准」 tab: ${staged.title}`);
  }

  if (name === "bot_manage_goal") {
    const aRaw = String(args.action ?? "create");
    const action = aRaw === "update" || aRaw === "complete" ? aRaw : "create";
    return textOutput(
      await host.manageGoal({
        action,
        ...(typeof args.id === "string" ? { id: args.id } : {}),
        title: String(args.title ?? "长期跟进事项"),
        ...(typeof args.category === "string" ? { category: args.category } : {}),
        ...(typeof args.summary === "string" ? { summary: args.summary } : {}),
      }),
    );
  }

  if (name === "bot_manage_space") {
    const action = args.action === "append" ? "append" : "create";
    return textOutput(
      await host.manageSpace({
        action,
        title: String(args.title ?? "未命名空间"),
        ...(typeof args.description === "string" ? { description: args.description } : {}),
        ...(typeof args.note === "string" ? { note: args.note } : {}),
      }),
    );
  }

  if (name === "bot_publish_briefing") {
    return textOutput(
      await host.publishBriefing({
        title: String(args.title ?? "主动简报"),
        body: String(args.body ?? ""),
        ...(typeof args.seedPrompt === "string" ? { seedPrompt: args.seedPrompt } : {}),
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

  return textOutput(`Unknown Bot tool: ${name}`, true);
}