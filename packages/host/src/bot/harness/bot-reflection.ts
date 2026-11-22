/**
 * Asynchronous post-turn reflection engine for `BotCompanionHarness`
 * (`packages/host/src/bot/harness/bot-reflection.ts`).
 *
 * Extracts unspoken user needs, enduring habits/preferences, implicit multi-day
 * goals, and topic space notes from settled conversations without delaying replies.
 */
import type { Context } from "@deepseek-ai/cordis";
import { BlockAssembler } from "@qianji/llm";
import type { ModelRef, Session } from "@qianji/session";
import type { PersistedBotState } from "../defaults.ts";
import { createGoalRecord, createSpaceRecord } from "../store-actions.ts";
import { rememberPreferenceEntry } from "../store-proactive.ts";

interface ReflectionOutput {
  preferences?: string[];
  goals?: Array<{ title: string; category?: string }>;
  space?: { title: string; description?: string };
}

function parseReflectionJson(raw: string): ReflectionOutput | null {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as ReflectionOutput)
      : null;
  } catch {
    return null;
  }
}

export async function reflectOnSettledTurn(options: {
  ctx: Context;
  session: Session;
  state: PersistedBotState;
  memoryFile: string;
  botWorkspaceDir: string;
  reflectionModel?: ModelRef;
  onPersistAndNotify: (reason: string) => void;
}): Promise<boolean> {
  const model = options.reflectionModel ?? options.session.state().model;
  const llm = options.ctx.get("llm");
  if (!model || !llm) return false;

  const recentMsgs = options.session.state().messages.slice(-4);
  const lastUser = [...recentMsgs].reverse().find((m) => m.role === "user");
  const lastAssistant = [...recentMsgs].reverse().find((m) => m.role === "assistant");
  if (!lastUser || !lastAssistant) return false;

  const userText = lastUser.content
    .flatMap((b) => (b.type === "text" && b.meta !== true ? [b.text] : []))
    .join("\n")
    .trim();
  const assistantText = lastAssistant.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim();
  if (userText.length < 6) return false;

  const system = [
    "You are the background reflection module for a caring personal Bot.",
    "Analyze the latest exchange and extract ONLY genuine, high-signal updates:",
    "- `preferences`: durable personal habits, tones, quiet hours, or key people mentioned by the user (short Chinese bullet strings).",
    "- `goals`: implicit multi-day objectives the user clearly wants to achieve (only when genuinely mentioned; max 1).",
    "- `space`: if an ongoing project/topic worth tracking emerged cleanly.",
    'Respond STRICTLY with JSON: {"preferences":[],"goals":[],"space":null}. Empty arrays when nothing notable was said.',
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const assembler = new BlockAssembler();
    for await (const chunk of llm.stream(
      {
        provider: model.provider,
        model: model.model,
        sessionId: `${options.session.id}:reflect`,
        system,
        messages: [
          {
            role: "user",
            content: [{
              type: "text",
              text: `用户刚才说：\n${userText.slice(0, 1200)}\n\n分身回复：\n${assistantText.slice(0, 1200)}`,
            }],
          },
        ],
      },
      controller.signal,
    )) {
      assembler.push(chunk);
    }
    const result = assembler.result();
    const rawText = result.message.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("\n");
    const extracted = parseReflectionJson(rawText);
    if (!extracted) return false;

    let changed = false;
    for (const pref of (extracted.preferences ?? []).slice(0, 3)) {
      if (typeof pref === "string" && rememberPreferenceEntry(options.state, options.memoryFile, pref)) {
        changed = true;
      }
    }
    for (const g of (extracted.goals ?? []).slice(0, 1)) {
      if (
        g &&
        typeof g.title === "string" &&
        g.title.trim() !== "" &&
        !options.state.goals.some((existing) => existing.title.toLowerCase() === g.title.trim().toLowerCase())
      ) {
        createGoalRecord(options.state, options.botWorkspaceDir, g.title.trim(), g.category?.trim() || "日常跟进");
        changed = true;
      }
    }
    if (
      extracted.space &&
      typeof extracted.space.title === "string" &&
      extracted.space.title.trim() !== "" &&
      !options.state.spaces.some((s) => s.title.toLowerCase() === extracted.space?.title.trim().toLowerCase())
    ) {
      createSpaceRecord(
        options.state,
        options.botWorkspaceDir,
        extracted.space.title.trim(),
        extracted.space.description,
      );
      changed = true;
    }

    if (changed) options.onPersistAndNotify("reflection-updated");
    return changed;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}