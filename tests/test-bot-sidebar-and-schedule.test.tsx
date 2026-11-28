/**
 * End-to-end unit & microkernel verification suite for Qianji Bot Mode's
 * Muse-surpassing Left Sidebar, Natural-Language Scheduled Tasks Hub, and
 * 2-Column Step-by-Step Activity Execution Trace (`<= 440` lines).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { AgentLoop } from "@qianji/agent-loop";
import { ClientSlotsService, SlotRegistry, SlotRoot } from "@qianji/client-slots";
import { Credentials, LlmService } from "@qianji/llm";
import { Sessions } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { ScriptedProvider, textReply, useScriptedProvider } from "@qianji/testkit";
import { Tools } from "@qianji/tools";
import { Ui } from "@qianji/ui";
import { Schedule, nextRunAfter } from "../packages/schedule/src/index";
import { createHost } from "../packages/host/src/host";
import * as botHostPlugin from "../packages/host/src/bot/index";
import { botModePlugin } from "../src/builtin-plugins/bot-mode";
import { BotScheduledNlQuickBar } from "../src/builtin-plugins/bot-mode/BotScheduledEditorPane";
import { BotDrawerTopBar, BotDrawerThreadRow } from "../src/builtin-plugins/bot-mode/BotSideDrawerMenus";
import {
  formatBotScheduleCadence,
  formatRelativeNextRun,
  parseNaturalScheduleInput,
  syncBotScheduledTasks,
} from "../src/builtin-plugins/bot-mode/botScheduleStore";
import {
  botDataStore,
  botUiStore,
  FALLBACK_BOT_SNAPSHOT,
  INITIAL_BOT_UI_STATE,
  openBotActivityDetail,
  openBotScheduledModal,
  patchBotUi,
} from "../src/builtin-plugins/bot-mode/botStore";
import { coreShellPlugin } from "../src/builtin-plugins/core-shell";
import { registerFrontendServices } from "../src/kernel/services";

const FIXED_WED_MORNING = new Date(2026, 10, 25, 8, 0, 0, 0).getTime(); // Wed 2026-11-25 08:00

async function createBotShellHarness() {
  const root = new Context();
  const registry = new SlotRegistry();
  await root.plugin(ClientSlotsService, registry);
  await registerFrontendServices(root, { shortcutTarget: null });
  const shellFiber = await root.plugin(coreShellPlugin);
  const botFiber = await root.plugin(botModePlugin);
  return {
    root,
    renderHtml: () => renderToStaticMarkup(createElement(SlotRoot, { registry, ctx: root })),
    dispose: async () => {
      await botFiber.dispose();
      await shellFiber.dispose();
    },
  };
}

describe("Bot Sidebar, Natural-Language Scheduled Tasks & Step Execution Trace", () => {
  const tempDirs: string[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    botUiStore.set(INITIAL_BOT_UI_STATE);
    botDataStore.set(FALLBACK_BOT_SNAPSHOT);
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses Chinese natural-language schedules across all 6 cadences and formats cadence & relative runs", () => {
    expect(parseNaturalScheduleInput("每15分钟巡检收件箱告警", FIXED_WED_MORNING)).toMatchObject({
      matched: true, frequency: "interval", intervalMinutes: 15, summaryZh: "每 15 分钟", cleanPrompt: "巡检收件箱告警",
    });
    expect(parseNaturalScheduleInput("每半小时检查一次构建流水线", FIXED_WED_MORNING)).toMatchObject({
      matched: true, frequency: "interval", intervalMinutes: 30,
    });
    expect(parseNaturalScheduleInput("每小时 20 分扫描待办队列", FIXED_WED_MORNING)).toMatchObject({
      matched: true, frequency: "hourly", minute: 20, summaryZh: "每小时 :20",
    });
    expect(parseNaturalScheduleInput("每天早上 9:30 帮我汇总未读邮件与仓库 PR", FIXED_WED_MORNING)).toMatchObject({
      matched: true, frequency: "daily", hour: 9, minute: 30, summaryZh: "每天 09:30", cleanPrompt: "帮我汇总未读邮件与仓库 PR",
    });
    expect(parseNaturalScheduleInput("每天下午 3 点整理研发日报", FIXED_WED_MORNING)).toMatchObject({
      matched: true, frequency: "daily", hour: 15, minute: 0, summaryZh: "每天 15:00",
    });
    expect(parseNaturalScheduleInput("每个工作日早上 10:00 同步团队看板", FIXED_WED_MORNING)).toMatchObject({
      matched: true, frequency: "weekdays", hour: 10, minute: 0, summaryZh: "工作日 10:00",
    });
    expect(parseNaturalScheduleInput("每周五下午 5 点输出架构演进周报", FIXED_WED_MORNING)).toMatchObject({
      matched: true, frequency: "weekly", weekday: 5, hour: 17, minute: 0, summaryZh: "每周五 17:00",
    });

    const onceTomorrow = parseNaturalScheduleInput("明天上午 10:30 提醒我发布版本说明", FIXED_WED_MORNING);
    expect(onceTomorrow).toMatchObject({ matched: true, frequency: "once", hour: 10, minute: 30 });
    expect((onceTomorrow.runAt ?? 0) > FIXED_WED_MORNING).toBe(true);
    expect(parseNaturalScheduleInput("今天下午 4 点提醒我核对灰度指标", FIXED_WED_MORNING)).toMatchObject({
      matched: true, frequency: "once", hour: 16, minute: 0,
    });

    expect(formatBotScheduleCadence({ frequency: "interval", intervalMinutes: 20 })).toBe("每 20 分钟");
    expect(formatBotScheduleCadence({ frequency: "hourly", minute: 5 })).toBe("每小时 :05");
    expect(formatBotScheduleCadence({ frequency: "daily", hour: 9, minute: 30 })).toBe("每天 09:30");
    expect(formatBotScheduleCadence({ frequency: "weekdays", hour: 9, minute: 0 })).toBe("工作日 09:00");
    expect(formatBotScheduleCadence({ frequency: "weekly", weekday: 5, hour: 17, minute: 0 })).toBe("每周五 17:00");
    expect(formatBotScheduleCadence({ frequency: "once", runAt: new Date(2026, 10, 26, 10, 30).getTime() })).toBe("单次 · 11/26 10:30");

    expect(formatRelativeNextRun(FIXED_WED_MORNING - 1_000, FIXED_WED_MORNING)).toBe("即将执行");
    expect(formatRelativeNextRun(FIXED_WED_MORNING + 20_000, FIXED_WED_MORNING)).toBe("1 分钟内");
    expect(formatRelativeNextRun(FIXED_WED_MORNING + 15 * 60_000, FIXED_WED_MORNING)).toBe("15 分钟后");
    expect(formatRelativeNextRun(FIXED_WED_MORNING + 3 * 3_600_000, FIXED_WED_MORNING)).toBe("今天 11:00");
    expect(formatRelativeNextRun(FIXED_WED_MORNING + 2 * 86_400_000, FIXED_WED_MORNING)).toBe("11月27日 08:00");
  });

  it("computes interval & once nextRunAfter and auto-disables one-shot tasks upon scheduled execution", async () => {
    expect(nextRunAfter({ frequency: "interval", intervalMinutes: 2, hour: 0, minute: 0, weekday: 1 }, FIXED_WED_MORNING)).toBe(FIXED_WED_MORNING + 5 * 60_000);
    expect(nextRunAfter({ frequency: "interval", intervalMinutes: 25, hour: 0, minute: 0, weekday: 1 }, FIXED_WED_MORNING)).toBe(FIXED_WED_MORNING + 25 * 60_000);
    const onceTarget = FIXED_WED_MORNING + 10 * 60_000;
    expect(nextRunAfter({ frequency: "once", runAt: onceTarget, hour: 8, minute: 10, weekday: 3 }, FIXED_WED_MORNING)).toBe(onceTarget);
    expect(nextRunAfter({ frequency: "once", runAt: FIXED_WED_MORNING, hour: 8, minute: 0, weekday: 3 }, FIXED_WED_MORNING)).toBeUndefined();

    const dir = mkdtempSync(join(tmpdir(), "qj-sched-once-"));
    tempDirs.push(dir);
    let clockMs = FIXED_WED_MORNING;
    const ctx = new Context();
    cleanups.push(async () => { await ctx.fiber.dispose(); });
    await ctx.plugin(LlmService, { maxAttempts: 1 });
    await ctx.plugin(Sessions);
    await ctx.plugin(Ui);
    await ctx.plugin(Tools);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(AgentLoop);
    useScriptedProvider(ctx, new ScriptedProvider([textReply("单次提醒已送达"), textReply("定时单次任务执行完毕")]));
    await ctx.plugin(Schedule, {
      tasksFile: join(dir, "schedules.json"),
      runsFile: join(dir, "schedule-runs.jsonl"),
      defaultModel: { provider: "scripted", model: "scripted-1" },
      tickMs: 600_000,
      now: () => clockMs,
    });

    const savedOnce = ctx.schedule.save({
      id: "once-release-note", name: "发布说明提醒", prompt: "检查 CHANGELOG 并生成发布摘要",
      cwd: dir, scope: "bot", frequency: "once", runAt: onceTarget,
      hour: 8, minute: 10, weekday: 3, permissionMode: "read-only", enabled: true,
    });
    expect(savedOnce.nextRunAt).toBe(onceTarget);

    // Manual preview run keeps future one-shot schedule armed
    const manualRun = await ctx.schedule.run(savedOnce.id, "manual");
    expect(manualRun.status).toBe("success");
    expect(ctx.schedule.list()[0]?.enabled).toBe(true);
    expect(ctx.schedule.list()[0]?.nextRunAt).toBe(onceTarget);

    // Scheduled trigger at target time auto-disables the one-shot task
    clockMs = onceTarget;
    const scheduledRun = await ctx.schedule.run(savedOnce.id, "scheduled");
    expect(scheduledRun.status).toBe("success");
    expect(ctx.schedule.list()[0]?.enabled).toBe(false);
    expect(ctx.schedule.list()[0]?.nextRunAt).toBeUndefined();
  });

  it("manages sideChat pin/rename/archive, auto-titles & strips <think> on settled turns, and extracts chronological activity traces", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "qj-bot-threads-"));
    tempDirs.push(dataDir);
    const host = createHost({
      version: "0.3.0-test",
      dataDir,
      plugins: [
        [Credentials], [Sessions], [SystemPrompt], [Tools],
        [botHostPlugin, { dataDir, distroName: "qianji-bot-threads-noop", displayName: "千机" }],
      ],
    });
    await host.start();
    cleanups.push(() => host.stop());

    const store = new botHostPlugin.BotStateStore(
      host.ctx.sessions,
      { dataDir, distroName: "qianji-bot-threads-noop", displayName: "千机" },
      host.ctx.credentials,
    );
    await store.snapshot();

    const untitled = await store.createSideChat("新旁聊 · 09:15");
    const sideSession = await host.ctx.sessions.get(untitled.sessionId);
    expect(sideSession).toBeDefined();
    if (!sideSession) return;

    sideSession.append("user", {
      content: [{ type: "text", text: "[已关联连接器上下文: GitHub]\n# 排查 WebSocket 断线重连根因" }],
    });
    sideSession.append("tool-call", {
      callId: "call-git-1", name: "bash", args: { command: "git status -sb", cwd: store.botWorkspaceDir },
    });
    sideSession.append("tool-result", {
      callId: "call-git-1", name: "bash",
      content: [{ type: "text", text: "## main...origin/main\n[exit code: 0]" }],
      isError: false,
    });
    sideSession.append("assistant", {
      content: [{ type: "text", text: "<thinking>先核对重连退避计时器是否泄漏</thinking>\n已定位到重连心跳未清理旧定时器，建议统一收敛至单实例保活。" }],
      model: { provider: "qianji", model: "bot-test" },
      usage: { inputTokens: 12, outputTokens: 24, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stop: "stop",
    });

    await store.recordSettledTurn(sideSession);
    const afterSettle = await store.snapshot();
    const autoTitled = afterSettle.sideThreads.find((t) => t.id === untitled.id);
    expect(autoTitled?.title).toBe("排查 WebSocket 断线重连根因");
    expect(autoTitled?.snippet).not.toContain("<thinking>");
    expect(autoTitled?.snippet).toContain("已定位到重连心跳未清理旧定时器");

    const pinned = await store.updateSideChat({ id: untitled.id, title: "WS 保活专项排查", pinned: true });
    expect(pinned).toMatchObject({ id: untitled.id, title: "WS 保活专项排查", pinned: true });
    const archived = await store.updateSideChat({ id: untitled.id, archived: true });
    expect(archived?.archived).toBe(true);

    const schedSession = host.ctx.sessions.create({ cwd: store.botWorkspaceDir });
    const bridged = await store.recordScheduledRun({
      id: "run-morning-pr", taskId: "task-morning-pr", taskName: "每日晨间 PR 简报",
      cwd: store.botWorkspaceDir, scope: "bot", sessionId: schedSession.id,
      trigger: "scheduled", status: "success", startedAt: FIXED_WED_MORNING,
      finishedAt: FIXED_WED_MORNING + 1_800, durationMs: 1_800,
      output: "<THINKING>内部过滤低优先级通知</THINKING>共有 2 个核心 PR 通过全部门禁。",
    });
    expect(bridged).toBe(true);
    const bridgedSnap = await store.snapshot();
    expect(bridgedSnap.sideThreads[0]).toMatchObject({
      title: "每日晨间 PR 简报（定时）", source: "scheduled", snippet: "共有 2 个核心 PR 通过全部门禁。",
    });

    const chatActivity = bridgedSnap.activityGroups.flatMap((g) => g.items).find((item) => item.sessionId === sideSession.id);
    expect(chatActivity).toBeDefined();
    const trace = await store.getActivityTrace({ activityId: chatActivity?.id, sessionId: sideSession.id });
    expect(trace.steps.map((s) => s.kind)).toEqual(["start", "tool", "done"]);
    expect(trace.steps[1]).toMatchObject({
      kind: "tool", toolName: "bash", commandOrInput: "git status -sb", exitCode: 0, status: "completed",
    });
    expect(trace.summary).not.toContain("<thinking>");
    expect(trace.summary).toContain("已定位到重连心跳未清理旧定时器");
  });

  it("integrates 7-item BotLeftRail, pure-conversation BotSideChatDrawer, BotCompanionPanel scheduled/activity sections, BotScheduledModal, and BotActivityDetailModal", async () => {
    const harness = await createBotShellHarness();
    cleanups.push(harness.dispose);
    harness.root.navigationService.setShellMode("bot", { persist: false });

    const activityEntry = {
      id: "act-trace-1", dateGroup: "今天", title: "执行仓库健康度巡检",
      description: "已完成类型检查、Lint 与构建门禁核验。", timeLabel: "09:30",
      createdAt: FIXED_WED_MORNING, sessionId: "sess-trace-1", status: "completed" as const, kind: "scheduled" as const,
      steps: [
        { id: "start", kind: "start" as const, title: "已开始", status: "completed" as const, output: "开始巡检" },
        {
          id: "tool-1", kind: "tool" as const, title: "执行命令：npm run typecheck", status: "completed" as const,
          toolName: "bash", commandOrInput: "npm run typecheck", cwd: "/workspace", exitCode: 0, durationMs: 820, output: "0 errors",
        },
        { id: "done", kind: "done" as const, title: "已完成", status: "completed" as const, output: "全部门禁通过。" },
      ],
    };

    botDataStore.set((prev) => ({
      ...prev,
      sideThreads: [
        {
          id: "th-pinned", sessionId: "sess-pinned", sessionFile: "harness:sess-pinned",
          title: "Q4 核心架构评审纪要", createdAt: FIXED_WED_MORNING - 7_200_000,
          updatedAt: FIXED_WED_MORNING - 1_800_000, snippet: "已对齐三平面边界与插件槽位契约", pinned: true,
        },
        {
          id: "th-side", sessionId: "sess-side", sessionFile: "harness:sess-side",
          title: "预定任务自然语言解析调优", createdAt: FIXED_WED_MORNING - 3_600_000,
          updatedAt: FIXED_WED_MORNING - 600_000, snippet: "支持每天、工作日、每周与单次提醒",
        },
        {
          id: "th-archived", sessionId: "sess-archived", sessionFile: "harness:sess-archived",
          title: "旧版原型归档记录", createdAt: FIXED_WED_MORNING - 86_400_000,
          updatedAt: FIXED_WED_MORNING - 80_000_000, archived: true,
        },
      ],
      activityGroups: [{ date: "今天", items: [activityEntry] }],
    }));

    syncBotScheduledTasks(
      [{
        id: "sched-daily-pr", name: "每日晨间收件箱与 PR 汇总", prompt: "汇总未读邮件与仓库 PR 状态",
        cwd: "/workspace", frequency: "daily", hour: 9, minute: 30, weekday: 1,
        permissionMode: "ask", enabled: true, running: false, nextRunAt: FIXED_WED_MORNING + 5_400_000,
        lastStatus: "success", lastMessage: "已汇总 2 个 PR",
      }],
      botDataStore.get().pacing,
    );

    const botModeCss = readFileSync(resolve(__dirname, "../src/styles/bot-mode.css"), "utf8");
    expect(botModeCss).toMatch(/\.qj-bot-rail-layer\s*\{[^}]*width:\s*72px/);

    patchBotUi({ chatDrawerOpen: true });
    const drawerHtml = harness.renderHtml();
    expect(drawerHtml).toContain('data-testid="bot-left-rail"');
    for (const navId of ["chat", "search", "feed", "ideas", "goals", "library", "spaces"]) {
      expect(drawerHtml).toContain(`data-bot-nav="${navId}"`);
    }
    expect(drawerHtml).not.toContain('data-bot-nav="scheduled"');
    expect(drawerHtml).not.toContain('data-testid="bot-scheduled-view"');

    // Left drawer is purely focused on Conversations
    expect(drawerHtml).toContain('data-testid="bot-side-drawer"');
    expect(drawerHtml).toContain('placeholder="搜索对话"');
    expect(drawerHtml).not.toContain('data-testid="bot-drawer-scheduled-section"');
    expect(drawerHtml).not.toContain('data-testid="bot-drawer-activity-row"');
    for (const label of ["主要聊天", "置顶", "Q4 核心架构评审纪要", "旁聊", "预定任务自然语言解析调优"]) {
      expect(drawerHtml).toContain(label);
    }
    expect(drawerHtml).toContain('data-testid="bot-drawer-options-btn"');
    expect(drawerHtml).not.toContain("旧版原型归档记录");

    // Right CompanionPanel owns Scheduled Tasks (`Heartbeat` + custom + `+` + `查看所有预定任务`) & Activity rows
    expect(drawerHtml).toContain('data-testid="bot-companion-panel"');
    expect(drawerHtml).toContain("2 项预定任务");
    expect(drawerHtml).toContain("Heartbeat");
    expect(drawerHtml).toContain("每日晨间收件箱与 PR 汇总");
    expect(drawerHtml).toContain('data-testid="bot-companion-new-scheduled"');
    expect(drawerHtml).toContain('class="qj-sheet-view-all-btn"');
    expect(drawerHtml).toContain("查看所有预定任务");
    expect(drawerHtml).toContain('data-testid="bot-activity-row"');

    patchBotUi({ chatDrawerShowArchived: true });
    expect(harness.renderHtml()).toContain("旧版原型归档记录");

    const optionsMenuHtml = renderToStaticMarkup(createElement(BotDrawerTopBar, {
      filterText: "", optionsOpen: true, pinned: true, showArchived: true, archivedCount: 1,
      onFilterChange: () => undefined, onToggleOptions: () => undefined, onTogglePinned: () => undefined,
      onToggleShowArchived: () => undefined, onCollapse: () => undefined,
    }));
    expect(optionsMenuHtml).toContain("保持显示聊天面板");
    expect(optionsMenuHtml).toContain("显示已归档的聊天");
    expect(optionsMenuHtml).not.toContain("管理所有预定任务");

    const rowMenuHtml = renderToStaticMarkup(createElement(BotDrawerThreadRow, {
      thread: botDataStore.get().sideThreads[1] ?? {
        id: "th-side", sessionId: "sess-side", sessionFile: "harness:sess-side",
        title: "旁聊", createdAt: FIXED_WED_MORNING, updatedAt: FIXED_WED_MORNING,
      },
      active: false, menuOpen: true, isRenaming: false, renameDraft: "",
      onSelect: () => undefined, onToggleMenu: () => undefined, onCloseMenu: () => undefined,
      onStartRename: () => undefined, onRenameDraftChange: () => undefined, onCommitRename: () => undefined,
      onCancelRename: () => undefined, onTogglePin: () => undefined, onToggleArchive: () => undefined,
      onHandoff: () => undefined, onDelete: () => undefined,
    }));
    for (const action of ["置顶", "重命名", "归档", "在工作台中打开", "删除"]) {
      expect(rowMenuHtml).toContain(action);
    }

    // Companion `+` quick-create opens `<BotScheduledModal>` directly in `"新建预定任务"` mode
    openBotScheduledModal("create");
    expect(harness.renderHtml()).toContain("新建预定任务");

    // `查看所有预定任务` opens modal INSIDE Bot mode (`shellMode === "bot"`)
    openBotScheduledModal(null);
    expect(harness.root.navigationService.getSnapshot().shellMode).toBe("bot");
    const schedModalHtml = harness.renderHtml();
    expect(schedModalHtml).toContain('data-testid="bot-scheduled-modal"');
    expect(schedModalHtml).toContain('data-testid="bot-scheduled-nl-input"');
    expect(schedModalHtml).toContain("高频巡检");
    expect(schedModalHtml).toContain("每日与工作日");

    const nlBarHtml = renderToStaticMarkup(createElement(BotScheduledNlQuickBar, {
      nlText: "每天早上 9:30 帮我汇总未读邮件与仓库 PR",
      onChangeNlText: () => undefined, onQuickCreate: () => undefined, onOpenAdvanced: () => undefined,
    }));
    expect(nlBarHtml).toContain("已识别：每天 09:30");

    openBotScheduledModal("sched-daily-pr");
    const detailHtml = harness.renderHtml();
    expect(detailHtml).toContain("已定时");
    expect(detailHtml).toContain('data-testid="bot-scheduled-run-history"');
    expect(detailHtml).toContain("查看权限");
    expect(detailHtml).toContain("删除");

    patchBotUi({ modal: null });
    openBotActivityDetail(activityEntry);
    const traceModalHtml = harness.renderHtml();
    expect(traceModalHtml).toContain('data-testid="bot-activity-detail-modal"');
    expect(traceModalHtml).toContain('data-testid="activity-trace-step-list"');
    expect(traceModalHtml).toContain('data-testid="activity-trace-inspector"');
    expect(traceModalHtml).toContain("执行命令：npm run typecheck");
  });
});
