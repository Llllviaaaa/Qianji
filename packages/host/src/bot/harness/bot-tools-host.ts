/**
 * Bridges `BotCompanionHarness` native tools (`bot_*`) & `ProactivePulseEngine`
 * to `BotStateStore` (`packages/host/src/bot/harness/bot-tools-host.ts`).
 */
import type { PendingBotApproval } from "@qianji/protocol";
import { createSpaceRecord } from "../store-actions.ts";
import { mutateWatchedProcessList, rememberPreferenceEntry } from "../store-proactive.ts";
import type { BotStateStore } from "../store.ts";
import type { BotHarnessHost } from "./bot-harness.ts";

export function createBotHarnessHost(
  store: BotStateStore,
  notifyUpdated: (reason: string, extra?: Record<string, unknown>) => void,
): BotHarnessHost {
  return {
    get botWorkspaceDir() {
      return store.botWorkspaceDir;
    },
    get memoryFile() {
      return store.memoryFile;
    },
    isBotSession: (sessionId) => store.isBotSession(sessionId),
    ensureLoaded: () => store.ensureLoaded(),
    readSoul: () => store.readSoul(),
    readMemory: () => store.readMemory(),
    persist: () => store.persist(),
    getReflectionModel: (st) => st.modelConfig?.patrol ?? st.modelConfig?.primary,
    executeToolInVm: (call, env) => store.executeToolInVm(call, env),
    recordSettledTurn: (session) => store.recordSettledTurn(session),
    notifyUpdated,

    async senseApps(source) {
      const st = await store.ensureLoaded();
      const delta = await store.collectConnectorDelta();
      store.persist();
      notifyUpdated("apps-sensed");

      const sections: string[] = [];
      if (source === "all" || source === "email") {
        const items = st.inboxItems.filter((m) => m.source !== "telegram").slice(0, 6);
        sections.push(
          items.length > 0
            ? `[Email Inbox (${items.length} recent)]\n` +
                items.map((m) => `- From: ${m.sender} <${m.replyTo ?? ""}> | Subject: ${m.subject}\n  Preview: ${m.fullBody?.slice(0, 260) ?? m.preview}`).join("\n")
            : "[Email Inbox] No emails synced yet (or email connector disabled).",
        );
      }
      if (source === "all" || source === "calendar") {
        const evs = delta.awareness.todayEvents;
        sections.push(
          `[Calendar Today (${evs.length} events, ${delta.conflicts.length} conflicts)]\n` +
            (evs.length > 0
              ? evs.map((e) => `- ${e.timeRangeLabel}: ${e.title}${e.conflictWith ? ` (CONFLICT with ${e.conflictWith})` : ""}`).join("\n")
              : "- No calendar events today.") +
            (delta.freeBlocks.length > 0
              ? `\nOpen Focus Windows: ${delta.freeBlocks.map((b) => `${b.startLabel}-${b.endLabel} (${b.minutes}m)`).join(", ")}`
              : ""),
        );
      }
      if (source === "all" || source === "processes") {
        sections.push(
          `[OS Work & Process Sensor]\nBusy State: ${delta.awareness.busyState}\nActive Window: ${delta.awareness.activeWindowTitle ?? "(unknown)"}\nRunning Watched: ${delta.awareness.runningWatched.join(", ") || "(none)"}\nNewly Completed: ${delta.completedProcesses.join(", ") || "(none)"}`,
        );
      }
      if (source === "all" || source === "meetings_im") {
        const notes = delta.newMeetingNotes
          .map((n) => `- Transcript ${n.fileName}:\n${n.excerpt.slice(0, 400)}`)
          .join("\n");
        const tgs = st.inboxItems
          .filter((m) => m.source === "telegram")
          .slice(0, 5)
          .map((m) => `- Telegram from ${m.sender} (chat ${m.replyTo ?? ""}): ${m.preview}`)
          .join("\n");
        sections.push(`[Meetings & IM]\n${notes || "- No new meeting transcripts."}\n${tgs || "- No recent Telegram messages."}`);
      }
      return sections.join("\n\n");
    },

    async stageOutboundApproval(input) {
      const approval = await store.enqueueApproval(
        {
          kind: input.kind,
          title: input.title,
          commandSignature:
            input.kind === "send-email"
              ? `发送邮件 → ${input.recipient ?? "(未指定)"}`
              : input.kind === "send-telegram"
                ? `Telegram 回复 → ${input.recipient ?? "默认会话"}`
                : input.kind === "send-feishu"
                  ? "飞书机器人推送"
                  : (input.command ?? input.title),
          summary: input.summary,
          ...(input.recipient ? { recipient: input.recipient } : {}),
          ...(input.subject ? { subject: input.subject } : {}),
          ...(input.draftBody ? { draftBody: input.draftBody } : {}),
        } satisfies Omit<PendingBotApproval, "id" | "createdAt" | "expiresAt">,
        input.command,
      );
      notifyUpdated("approval-queued", { approvalId: approval.id });
      return approval;
    },

    async manageGoal(input) {
      if (input.action === "create") {
        const created = await store.createGoal(input.title, input.category || "日常跟进");
        if (input.summary) {
          const st = await store.ensureLoaded();
          const target = st.goals.find((g) => g.id === created.id);
          if (target) target.summary = input.summary;
          store.persist();
        }
        notifyUpdated("goal-created");
        return `Created Goal: ${created.title} (${created.category})`;
      }
      const st = await store.ensureLoaded();
      const target = st.goals.find(
        (g) => (input.id && g.id === input.id) || g.title.toLowerCase().includes(input.title.toLowerCase()),
      );
      if (!target) return `Goal "${input.title}" not found; consider creating it.`;
      if (input.action === "complete") target.status = "completed";
      if (input.summary) target.summary = input.summary;
      target.updatedAt = Date.now();
      store.persist();
      notifyUpdated("goal-updated");
      return `Updated Goal "${target.title}" (${target.status}).`;
    },

    async manageSpace(input) {
      const st = await store.ensureLoaded();
      const existing = st.spaces.find((s) => s.title.toLowerCase().includes(input.title.toLowerCase()));
      if (input.action === "append" && existing) {
        if (input.note) existing.description = `${existing.description} · ${input.note.slice(0, 120)}`;
        existing.updatedAt = Date.now();
        existing.updatedLabel = "刚刚";
        store.persist();
        notifyUpdated("space-updated");
        return `Updated Space "${existing.title}".`;
      }
      const created = createSpaceRecord(st, store.botWorkspaceDir, input.title, input.description || input.note);
      store.persist();
      notifyUpdated("space-created");
      return `Created Space "${created.title}".`;
    },

    async publishBriefing(input) {
      const item = await store.createFeedItem(input.title, input.body, input.seedPrompt);
      notifyUpdated("feed-created");
      return `Published briefing to Feed (id: ${item.id}): ${item.title}`;
    },

    async rememberPreference(preference) {
      const st = await store.ensureLoaded();
      const added = rememberPreferenceEntry(st, store.memoryFile, preference);
      if (added) {
        store.persist();
        notifyUpdated("preference-remembered");
      }
      return added;
    },

    async watchProcess(processName, remove = false) {
      const st = await store.ensureLoaded();
      const updated = mutateWatchedProcessList(st, processName, remove);
      store.persist();
      notifyUpdated("watch-process-updated");
      return updated;
    },
  };
}