/**
 * Bridges `BotCompanionHarness` native tools (`bot_*`) & `ProactivePulseEngine`
 * to `BotStateStore` & `@qianji/schedule` (`packages/host/src/bot/harness/bot-tools-host.ts`).
 */
import type { PendingBotApproval } from "@qianji/protocol";
import type { Schedule, ScheduledTask } from "@qianji/schedule";
import { createSpaceRecord } from "../store-actions.ts";
import { isConnectorWriteAllowed, mutateWatchedProcessList, rememberPreferenceEntry } from "../store-proactive.ts";
import { truncateCodepoints } from "../store-turn-namer.ts";
import type { BotStateStore } from "../store.ts";
import type { BotHarnessHost } from "./bot-harness.ts";
import type { BotManageScheduleInput } from "./bot-tools.ts";

function parseTargetRunAtMs(input: BotManageScheduleInput, nowMs = Date.now()): number | undefined {
  if (typeof input.delayMinutes === "number" && Number.isFinite(input.delayMinutes) && input.delayMinutes > 0) {
    return nowMs + Math.round(input.delayMinutes * 60_000);
  }
  const raw = input.runAtIso?.trim();
  if (!raw) return undefined;
  const localMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(raw);
  if (localMatch) {
    const dt = new Date(
      Number(localMatch[1]),
      Number(localMatch[2]) - 1,
      Number(localMatch[3]),
      Number(localMatch[4]),
      Number(localMatch[5]),
      Number(localMatch[6] ?? 0),
    );
    const ms = dt.getTime();
    if (Number.isFinite(ms)) return ms;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function findBotScheduledTask(tasks: readonly ScheduledTask[], input: BotManageScheduleInput): ScheduledTask | undefined {
  const idQuery = input.id?.trim();
  if (idQuery) {
    const exactId = tasks.find((t) => t.id === idQuery);
    if (exactId) return exactId;
    const partialId = tasks.find((t) => t.id.toLowerCase().includes(idQuery.toLowerCase()));
    if (partialId) return partialId;
  }
  const nameQuery = input.name?.trim().toLowerCase();
  if (nameQuery) {
    const exactName = tasks.find((t) => t.name.trim().toLowerCase() === nameQuery);
    if (exactName) return exactName;
    return tasks.find(
      (t) => t.name.toLowerCase().includes(nameQuery) || nameQuery.includes(t.name.trim().toLowerCase()),
    );
  }
  return tasks.length === 1 ? tasks[0] : undefined;
}

export function createBotHarnessHost(
  store: BotStateStore,
  notifyUpdated: (reason: string, extra?: Record<string, unknown>) => void,
  getSchedule: () => Schedule | undefined = () => undefined,
): BotHarnessHost {
  const listBotTasks = (): ScheduledTask[] => {
    const svc = getSchedule();
    if (!svc) return [];
    return svc.list().filter((t) => t.scope === "bot" || store.matchesBotWorkspace(t.cwd));
  };

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
    resolvePrimaryModel: (st) => store.resolvePrimaryModel(st),
    getReflectionModel: (st) => st.modelConfig?.patrol ?? st.modelConfig?.primary,
    executeToolInVm: (call, env) => store.executeToolInVm(call, env),
    recordTurnProgress: (session, options) => store.recordTurnProgress(session, options),
    recordSettledTurn: (session, options) => store.recordSettledTurn(session, options),
    listScheduledTasks: listBotTasks,
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
      if (source === "all" || source === "github") {
        const ghs = st.inboxItems
          .filter((m) => m.source === "github")
          .slice(0, 6)
          .map((m) => `- ${m.sender} | ${m.subject} (${m.replyTo ?? ""})`)
          .join("\n");
        sections.push(`[GitHub]\n${ghs || "- No GitHub issues/PRs synced yet (or GitHub connector disabled)."}`);
      }
      if (source === "all" || source === "notion") {
        const notions = st.inboxItems
          .filter((m) => m.source === "notion")
          .slice(0, 6)
          .map((m) => `- ${m.subject} (${m.preview})`)
          .join("\n");
        sections.push(`[Notion]\n${notions || "- No Notion pages synced yet (or Notion connector disabled)."}`);
      }
      return sections.join("\n\n");
    },

    async stageOutboundApproval(input) {
      const st = await store.ensureLoaded();
      if (!isConnectorWriteAllowed(st, input.kind)) {
        throw new Error(`连接器权限受限：当前对应连接器设置为「仅只读 (read-only)」，禁止生成 ${input.kind} 外发草稿。`);
      }
      const sigMap: Record<string, string> = {
        "send-email": `发送邮件 → ${input.recipient ?? "(未指定)"}`,
        "send-telegram": `Telegram 回复 → ${input.recipient ?? "默认会话"}`,
        "send-feishu": "飞书机器人推送",
        "send-slack": "Slack 频道推送",
        "github-comment": `GitHub 评论 → ${input.recipient ?? "(未指定仓库#编号)"}`,
        "notion-page": `Notion 归档 → ${input.subject || input.title}`,
        "trigger-webhook": "触发外部 Webhook",
      };
      const approval = await store.enqueueApproval(
        {
          kind: input.kind,
          title: input.title,
          commandSignature: sigMap[input.kind] ?? input.command ?? input.title,
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

    async manageSchedule(input) {
      const st = await store.ensureLoaded();
      if (input.id?.trim().toLowerCase() === "heartbeat" || input.name?.trim().toLowerCase() === "heartbeat") {
        if (input.action === "toggle" || input.action === "update") {
          const nextEnabled = typeof input.enabled === "boolean" ? input.enabled : !(st.pacing?.heartbeatEnabled ?? true);
          const nextInterval = typeof input.intervalMinutes === "number" ? input.intervalMinutes : st.pacing?.heartbeatIntervalMinutes ?? 30;
          await store.configureProactive({
            pacing: { heartbeatEnabled: nextEnabled, heartbeatIntervalMinutes: nextInterval },
          });
          notifyUpdated("schedule-managed", { taskId: "heartbeat", action: input.action });
          return `Updated Heartbeat routine: enabled=${nextEnabled}, interval=${nextInterval}m`;
        }
      }

      const scheduleSvc = getSchedule();
      if (!scheduleSvc) {
        return "定时任务服务 (schedule) 当前未启用，无法管理预定任务。";
      }

      const botTasks = listBotTasks();
      if (input.action === "list") {
        if (botTasks.length === 0) {
          return `Heartbeat: ${st.pacing?.heartbeatEnabled !== false ? "enabled" : "paused"} (${st.pacing?.heartbeatIntervalMinutes ?? 30}m)\nCustom Bot scheduled tasks: (none)`;
        }
        const lines = botTasks.map(
          (t) =>
            `- [${t.id}] "${t.name}" | frequency=${t.frequency} | enabled=${t.enabled} | nextRunAt=${t.nextRunAt ? new Date(t.nextRunAt).toLocaleString("zh-CN", { hour12: false }) : "none"}`,
        );
        return [`Heartbeat: ${st.pacing?.heartbeatEnabled !== false ? "enabled" : "paused"}`, ...lines].join("\n");
      }

      if (input.action === "create") {
        const runAt = parseTargetRunAtMs(input);
        const runAtDate = runAt !== undefined ? new Date(runAt) : undefined;
        const frequency =
          input.frequency ??
          (runAt !== undefined ? "once" : typeof input.intervalMinutes === "number" ? "interval" : "daily");
        const name = input.name?.trim() || truncateCodepoints(input.prompt?.trim() || "预定提醒任务", 24);
        const prompt = input.prompt?.trim() || name;
        const saved = scheduleSvc.save({
          ...(input.id?.trim() ? { id: input.id.trim() } : {}),
          name,
          prompt,
          cwd: store.botWorkspaceDir,
          scope: "bot",
          frequency,
          ...(typeof input.intervalMinutes === "number" ? { intervalMinutes: input.intervalMinutes } : {}),
          ...(runAt !== undefined ? { runAt } : {}),
          hour: typeof input.hour === "number" ? Math.max(0, Math.min(23, Math.round(input.hour))) : runAtDate ? runAtDate.getHours() : 9,
          minute: typeof input.minute === "number" ? Math.max(0, Math.min(59, Math.round(input.minute))) : runAtDate ? runAtDate.getMinutes() : 0,
          weekday: typeof input.weekday === "number" ? Math.max(0, Math.min(6, Math.round(input.weekday))) : 1,
          permissionMode: input.permissionMode ?? "ask",
          ...(st.modelConfig?.primary ? { model: st.modelConfig.primary } : {}),
          enabled: input.enabled ?? true,
        });
        notifyUpdated("schedule-managed", { taskId: saved.id, action: "create" });
        return `Created Bot scheduled task (id: ${saved.id}): "${saved.name}" [frequency=${saved.frequency}, enabled=${saved.enabled}]`;
      }

      const target = findBotScheduledTask(botTasks, input) ?? findBotScheduledTask(scheduleSvc.list(), input);
      if (!target) {
        return `未找到匹配的预定任务（id=${input.id ?? ""}, name=${input.name ?? ""}），请先调用 action="list" 核对。`;
      }

      if (input.action === "delete") {
        scheduleSvc.delete(target.id);
        notifyUpdated("schedule-managed", { taskId: target.id, action: "delete" });
        return `Deleted Bot scheduled task (id: ${target.id}): "${target.name}"`;
      }

      if (input.action === "toggle") {
        const nextEnabled = typeof input.enabled === "boolean" ? input.enabled : !target.enabled;
        const saved = scheduleSvc.save({ ...target, scope: "bot", cwd: target.cwd || store.botWorkspaceDir, enabled: nextEnabled });
        notifyUpdated("schedule-managed", { taskId: saved.id, action: "toggle" });
        return `${saved.enabled ? "Enabled" : "Paused"} Bot scheduled task (id: ${saved.id}): "${saved.name}" [enabled=${saved.enabled}]`;
      }

      if (input.action === "run_now") {
        const run = await scheduleSvc.run(target.id, "manual");
        notifyUpdated("schedule-managed", { taskId: target.id, action: "run_now", runId: run.id });
        return `Executed Bot scheduled task "${target.name}" (status=${run.status}): ${truncateCodepoints(run.output || "completed", 160)}`;
      }

      const runAt = parseTargetRunAtMs(input);
      const saved = scheduleSvc.save({
        ...target,
        name: input.name?.trim() || target.name,
        prompt: input.prompt?.trim() || target.prompt,
        cwd: store.botWorkspaceDir,
        scope: "bot",
        frequency: input.frequency ?? target.frequency,
        ...(typeof input.intervalMinutes === "number" ? { intervalMinutes: input.intervalMinutes } : {}),
        ...(runAt !== undefined ? { runAt } : {}),
        ...(typeof input.hour === "number" ? { hour: Math.max(0, Math.min(23, Math.round(input.hour))) } : {}),
        ...(typeof input.minute === "number" ? { minute: Math.max(0, Math.min(59, Math.round(input.minute))) } : {}),
        ...(typeof input.weekday === "number" ? { weekday: Math.max(0, Math.min(6, Math.round(input.weekday))) } : {}),
        permissionMode: input.permissionMode ?? target.permissionMode ?? "ask",
        enabled: input.enabled ?? target.enabled,
      });
      notifyUpdated("schedule-managed", { taskId: saved.id, action: "update" });
      return `Updated Bot scheduled task (id: ${saved.id}): "${saved.name}" [frequency=${saved.frequency}, enabled=${saved.enabled}]`;
    },

    async manageGoal(input) {
      if (input.action === "create") {
        const created = await store.createGoal(
          {
            title: input.title?.trim() || "长期跟进事项",
            category: input.category || "日常跟进",
            ...(input.summary ? { summary: input.summary } : {}),
            ...(input.description ? { description: input.description } : {}),
            ...(input.source ? { source: input.source } : {}),
            ...(input.momentumStatus ? { momentumStatus: input.momentumStatus } : {}),
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input.subGoalTitle?.trim() ? { subGoals: [input.subGoalTitle.trim()] } : {}),
          },
          "日常跟进",
          { recordActivity: false },
        );
        notifyUpdated("goal-created", { goalId: created.id });
        return `Created Goal (id: ${created.id}): ${created.title} (${created.category})`;
      }
      const st = await store.ensureLoaded();
      const titleQuery = input.title?.trim().toLowerCase() ?? "";
      const target = st.goals.find(
        (g) =>
          (input.id && g.id === input.id) ||
          (titleQuery !== "" &&
            (g.title.toLowerCase().includes(titleQuery) || titleQuery.includes(g.title.toLowerCase()))),
      );
      if (!target) return `Goal "${input.id ?? input.title ?? ""}" not found; consider creating it.`;

      const resolvedToggleSubId =
        input.action === "toggle_subgoal"
          ? input.subGoalId ??
            target.subGoals?.find(
              (s) => input.subGoalTitle && s.title.toLowerCase().includes(input.subGoalTitle.toLowerCase()),
            )?.id
          : undefined;

      const updated = await store.updateGoal({
        id: target.id,
        ...(input.action === "update" && input.title?.trim() ? { title: input.title.trim() } : {}),
        ...(input.category ? { category: input.category } : {}),
        ...(input.summary ? { summary: input.summary } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.momentumStatus ? { momentumStatus: input.momentumStatus } : {}),
        ...(input.action === "complete" ? { status: "completed" } : {}),
        ...(input.action === "reopen" ? { status: "active" } : {}),
        ...(input.action === "add_subgoal" && input.subGoalTitle?.trim()
          ? { addSubGoal: input.subGoalTitle.trim() }
          : {}),
        ...(resolvedToggleSubId ? { toggleSubGoalId: resolvedToggleSubId } : {}),
        ...(input.timelineTitle?.trim()
          ? {
              timelineEntry: {
                title: input.timelineTitle.trim(),
                ...(input.timelineDetail?.trim() ? { detail: input.timelineDetail.trim() } : {}),
              },
            }
          : {}),
      });
      notifyUpdated("goal-updated", { goalId: target.id });
      return `Updated Goal (id: ${target.id}) "${updated?.title ?? target.title}" (${updated?.status ?? target.status}).`;
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
      const created = createSpaceRecord(st, store.botWorkspaceDir, input.title, input.description || input.note, {
        recordActivity: false,
      });
      store.persist();
      notifyUpdated("space-created");
      return `Created Space "${created.title}".`;
    },

    async publishBriefing(input) {
      const item = await store.createFeedItem({
        ...input,
        reason: input.reason ?? "在对话执行中为你整理并发布到动态版块",
      });
      notifyUpdated("feed-created", { feedId: item.id });
      return `Published briefing to Feed (id: ${item.id}, actionKind: ${item.actionKind ?? "discuss"}): ${item.title}`;
    },

    async proposeIdea(input) {
      const added = await store.proposeIdeas([
        {
          title: input.title,
          description: input.description,
          seedPrompt: input.seedPrompt,
          category: input.category ?? null,
          ...(input.sourceLabel ? { sourceLabel: input.sourceLabel } : {}),
          icon: input.icon ?? "✦",
          reason: input.reason ?? "结合当前对话上下文为你定制的行动点子",
          ...(input.howItWorks ? { howItWorks: input.howItWorks } : {}),
          ...(input.capabilities ? { capabilities: input.capabilities } : {}),
        },
      ]);
      if (added.length > 0) notifyUpdated("idea-proposed");
      return added[0]
        ? `Proposed personalized Idea (id: ${added[0].id}): ${added[0].title}`
        : `Idea "${input.title}" skipped (duplicate or dismissed).`;
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

    async requestTakeover(input) {
      const res = await store.computer.takeover({
        action: "request",
        reason: input.reason,
        targetUrlOrApp: input.targetUrlOrApp,
        ...(input.engine ? { engine: input.engine } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      });
      notifyUpdated("computer-takeover", { status: res.takeover.status });
      return `Requested human takeover (${res.takeover.status}) on ${res.takeover.engine ?? res.snapshot.activeEngine} for "${input.targetUrlOrApp}": ${input.reason}`;
    },
  };
}
