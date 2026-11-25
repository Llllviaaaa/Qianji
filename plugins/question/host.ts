import type { Context } from "@deepseek-ai/cordis";
import "@qianji/commands";
import { ErrorCode } from "@qianji/protocol";
import { RpcError } from "@qianji/rpc";
import { currentBranch, type Session } from "@qianji/session";
import { SectionOrder } from "@qianji/system-prompt";
import { textOutput, type ToolDefinition } from "@qianji/tools";
import "@qianji/ui";
import {
  QUESTION_NAMESPACE,
  QUESTION_PLACEHOLDER,
  formatAnswerDisplay,
  isRecord,
  normalizeQuestionnaireInput,
  parseQuestionResponse,
  serializeQuestionEnvelope,
  type QuestionAnswerItem,
  type QuestionHistoryRecord,
  type QuestionResultPayload,
} from "./shared.ts";

export const name = "question";
export const inject = ["tools", "ui", "sessions", "commands", "rpc", "systemPrompt"];

export interface QuestionPluginConfig {
  maxQuestions?: number;
  allowCustomAnswerByDefault?: boolean;
  enableReviewStep?: boolean;
  injectPromptGuidance?: boolean;
}

export const QUESTION_SYSTEM_PROMPT = `Structured User Questions (\`question\`):
When a user's request has genuine product, architectural, or scope ambiguity that cannot be resolved by inspecting the workspace, call \`question\` to ask 1–4 concise multiple-choice questions instead of guessing or writing plain-text questions.
- Put your recommended option first and mark \`recommended: true\`.
- Group related clarifications into a single \`question\` call rather than asking one by one.
- Set \`multiple: true\` when the user may select more than one option.
- Never call \`question\` for facts discoverable from code, configs, or git history.`;

export function reconstructQuestionHistory(session: Session): QuestionHistoryRecord[] {
  const records: QuestionHistoryRecord[] = [];
  for (const event of currentBranch(session.events)) {
    if (event.type !== "custom" || event.data.ns !== QUESTION_NAMESPACE) continue;
    const raw = event.data.data;
    if (!isRecord(raw) || typeof raw.status !== "string" || !Array.isArray(raw.answers)) continue;
    records.push({
      id: typeof raw.id === "string" ? raw.id : `qhist_${event.seq}`,
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
      status: raw.status as QuestionResultPayload["status"],
      ...(typeof raw.title === "string" ? { title: raw.title } : {}),
      answers: raw.answers as QuestionResultPayload["answers"],
      ...(typeof raw.message === "string" ? { message: raw.message } : {}),
    });
  }
  return records;
}

function formatHistoryMarkdown(records: readonly QuestionHistoryRecord[]): string {
  if (records.length === 0) {
    return "当前会话暂无结构化追问记录。可输入 `/question <需求主题>` 让智能体先澄清关键选项再执行。";
  }
  const lines = [`### 当前会话追问记录（共 ${records.length} 次）`, ""];
  for (const rec of records.slice(-8)) {
    const statusLabel =
      rec.status === "answered" ? "已回答" : rec.status === "cancelled" ? "已取消" : "无人值守跳过";
    lines.push(`- **${rec.title ?? "需求澄清"}**（${statusLabel}）`);
    for (const item of rec.answers) {
      const noteSuffix = item.note ? `（补充：${item.note}）` : "";
      lines.push(`  - ${item.question} → **${item.display}**${noteSuffix}`);
    }
  }
  return lines.join("\n");
}

export function createQuestionTool(
  ctx: Context,
  config: QuestionPluginConfig,
): ToolDefinition<Record<string, unknown>> {
  return {
    name: "question",
    description:
      "Ask the user 1..N structured interactive questions (single-select, multi-select, yes/no confirm, or free-text input) and wait for their answers before proceeding.",
    readOnly: true,
    timeoutMs: 0,
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Optional overall title for the questionnaire card.",
        },
        questions: {
          type: "array",
          description: "Ordered list of structured questions to present to the user.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Short stable question identifier (e.g. 'storage_backend')." },
              header: { type: "string", description: "Short tab label (<= 16 chars, e.g. '存储方案')." },
              question: { type: "string", description: "Clear, concise question text." },
              type: {
                type: "string",
                enum: ["select", "confirm", "input", "editor"],
                description: "Input mode (defaults to 'select' when options are provided, otherwise 'input').",
              },
              multiple: {
                type: "boolean",
                description: "Allow selecting multiple options when type is 'select'.",
              },
              options: {
                type: "array",
                description: "Selectable choices (put the recommended choice first with recommended: true).",
                items: {
                  anyOf: [
                    { type: "string" },
                    {
                      type: "object",
                      properties: {
                        label: { type: "string", description: "Option label shown to the user." },
                        value: { type: "string", description: "Option value returned to the model (defaults to label)." },
                        description: { type: "string", description: "Optional short explanation or trade-off." },
                        recommended: { type: "boolean", description: "Highlight this option as recommended." },
                      },
                      required: ["label"],
                    },
                  ],
                },
              },
              allowOther: {
                type: "boolean",
                description: "Allow user to enter a custom free-text answer (default: true).",
              },
              placeholder: {
                type: "string",
                description: "Placeholder for text or custom answer input.",
              },
              prefill: {
                type: "string",
                description: "Initial prefilled text for input/editor questions.",
              },
            },
            required: ["question"],
          },
        },
        question: {
          type: "string",
          description: "Single-question shorthand when asking just one question.",
        },
        options: {
          type: "array",
          description: "Options for single-question shorthand.",
          items: {
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  label: { type: "string" },
                  value: { type: "string" },
                  description: { type: "string" },
                  recommended: { type: "boolean" },
                },
                required: ["label"],
              },
            ],
          },
        },
        multiple: {
          type: "boolean",
          description: "Multi-select flag for single-question shorthand.",
        },
        review: {
          type: "boolean",
          description: "Show a summary review step before final submission when asking multiple questions.",
        },
      },
    },
    async execute(args, env) {
      const envelope = normalizeQuestionnaireInput(args, {
        maxQuestions: config.maxQuestions ?? 6,
        allowCustomAnswerByDefault: config.allowCustomAnswerByDefault !== false,
        defaultReview: config.enableReviewStep !== false,
      });
      if (envelope === null) {
        return textOutput(
          "Invalid arguments for question: provide a non-empty `questions` array (or `question` string).",
          true,
        );
      }

      const session = await ctx.sessions.get(env.sessionId);

      if (!ctx.ui.canAsk(env.sessionId)) {
        const unattendedPayload: QuestionResultPayload = {
          status: "unattended",
          ...(envelope.title === undefined ? {} : { title: envelope.title }),
          answers: envelope.questions.map((q) => ({
            id: q.id,
            ...(q.header === undefined ? {} : { header: q.header }),
            question: q.question,
            answer: null,
            display: "无人值守（未挂载交互界面）",
          })),
          message:
            "No interactive UI is attached to answer questions in this session. Proceed with the safest recommended default and state your assumption clearly.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(unattendedPayload, null, 2) }],
          details: unattendedPayload,
        };
      }

      const rawResponse = await ctx.ui.ask(
        env.sessionId,
        {
          kind: "input",
          title: serializeQuestionEnvelope(envelope),
          placeholder: QUESTION_PLACEHOLDER,
        },
        env.signal,
      );

      const parsed = parseQuestionResponse(rawResponse);
      const byId = new Map<string, QuestionAnswerItem>();
      for (const item of parsed?.answers ?? []) {
        byId.set(item.id, item);
      }

      const cancelled = parsed === null || parsed.cancelled === true;
      const resultPayload: QuestionResultPayload = {
        status: cancelled ? "cancelled" : "answered",
        ...(envelope.title === undefined ? {} : { title: envelope.title }),
        answers: envelope.questions.map((q) => {
          const ans = byId.get(q.id);
          const note = typeof ans?.note === "string" && ans.note.trim() !== "" ? ans.note.trim() : undefined;
          return {
            id: q.id,
            ...(q.header === undefined ? {} : { header: q.header }),
            question: q.question,
            answer: cancelled ? null : (ans?.value ?? null),
            display: cancelled ? "用户已取消提问" : formatAnswerDisplay(q, ans),
            ...(ans?.wasCustom ? { wasCustom: true } : {}),
            ...(note === undefined ? {} : { note }),
          };
        }),
        ...(cancelled
          ? { message: "The user dismissed the questionnaire without submitting answers. Ask in plain text or wait for instructions before making destructive changes." }
          : {}),
      };

      if (session !== undefined) {
        const record: QuestionHistoryRecord = {
          id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          createdAt: Date.now(),
          ...resultPayload,
        };
        session.append("custom", { ns: QUESTION_NAMESPACE, data: record });
      }

      return {
        content: [{ type: "text", text: JSON.stringify(resultPayload, null, 2) }],
        details: resultPayload,
      };
    },
  };
}

export function apply(ctx: Context, config: QuestionPluginConfig = {}): void {
  ctx.effect(() => ctx.tools.register(createQuestionTool(ctx, config)), `${name}: tool question`);

  if (config.injectPromptGuidance !== false) {
    ctx.effect(
      () =>
        ctx.systemPrompt.section(
          "question-guidance",
          ({ tools }) => (tools.some((t) => t.name === "question") ? QUESTION_SYSTEM_PROMPT : undefined),
          { order: SectionOrder.guidelines + 22 },
        ),
      `${name}: system-prompt`,
    );
  }

  ctx.effect(
    () =>
      ctx.commands.register({
        name: "question",
        description: "查看当前会话的交互追问记录，或针对指定需求让智能体先发起结构化澄清问卷",
        argsHint: "[history | 待澄清的需求描述]",
        source: "plugin",
        async execute(rawArgs, env) {
          const trimmed = rawArgs.trim();
          if (trimmed === "" || trimmed.toLowerCase() === "history" || trimmed.toLowerCase() === "list") {
            if (!env.sessionId) {
              return { output: "当前会话尚未开始。可输入 `/question <需求描述>` 让智能体通过交互问卷先对齐细节。" };
            }
            const session = await ctx.sessions.get(env.sessionId);
            if (!session) return { output: "未找到当前会话。", isError: true };
            return { output: formatHistoryMarkdown(reconstructQuestionHistory(session)) };
          }
          return {
            prompt: `在处理以下需求前，请先调用 \`question\` 工具向我提出 1–4 个关键设计或范围选择题（将推荐方案排在首位并标记 recommended），待我确认后再开始实施：\n\n${trimmed}`,
          };
        },
      }),
    `${name}: /question`,
  );

  ctx.effect(
    () =>
      ctx.rpc.method("question.history", async (params) => {
        const p = isRecord(params) ? params : {};
        if (typeof p.sessionId !== "string" || p.sessionId.trim() === "") {
          throw new RpcError(ErrorCode.InvalidParams, "sessionId must be a non-empty string");
        }
        const session = await ctx.sessions.get(p.sessionId);
        if (!session) {
          throw new RpcError(ErrorCode.SessionNotFound, `No session ${p.sessionId}`);
        }
        return { records: reconstructQuestionHistory(session) };
      }),
    `${name}: question.history`,
  );
}

export default {
  name,
  inject,
  apply,
};
