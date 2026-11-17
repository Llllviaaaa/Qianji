import assert from "node:assert/strict";
import {
  compactRelativeTime,
  groupSessionsByTimeBucket,
  visibleProjectSessions,
} from "../src/components/sidebar/sidebarHelpers.ts";
import {
  reconcileSidebarOrder,
  reorderSidebarWorkspaces,
  sortSidebarProjectGroups,
  sortSidebarSessions,
  type SidebarOrder,
  type SidebarProjectGroup,
} from "../src/lib/sidebarProjectOrder.ts";
import type { ProjectConfig, SessionInfo } from "../src/types.ts";
import { test } from "vitest";

test("sidebar session recency sorting and fixed project order", async () => {
  function session(file: string, cwd: string, updatedAt: number): SessionInfo {
    return {
      file,
      sessionId: file,
      cwd,
      messageCount: 1,
      updatedAt,
    };
  }

  const alpha = session("alpha", "D:\\alpha", 300);
  const beta = session("beta", "D:\\beta", 200);
  const olderRestored = session("older", "D:\\alpha", 100);
  const groups: SidebarProjectGroup[] = [
    [alpha.cwd, [alpha]],
    [beta.cwd, [beta]],
  ];

  assert.deepEqual(
    sortSidebarProjectGroups(groups, [], [alpha.cwd, beta.cwd]).map(([workspace]) => workspace),
    [alpha.cwd, beta.cwd],
    "projects should follow their persisted workspace order",
  );

  const refreshedBeta = session(beta.file, beta.cwd, 900);
  assert.deepEqual(
    sortSidebarSessions([alpha, refreshedBeta, olderRestored], []).map((item) => item.file),
    [refreshedBeta.file, alpha.file, olderRestored.file],
    "sessions must sort strictly descending by conversation updatedAt",
  );
  assert.deepEqual(
    sortSidebarSessions([olderRestored, alpha, refreshedBeta], []).map((item) => item.file),
    [refreshedBeta.file, alpha.file, olderRestored.file],
    "restoring an older session places it by its true updatedAt rather than jumping to the top",
  );
  assert.deepEqual(
    sortSidebarProjectGroups([[beta.cwd, [refreshedBeta]], [alpha.cwd, [alpha]]], [], [alpha.cwd, beta.cwd])
      .map(([workspace]) => workspace),
    [alpha.cwd, beta.cwd],
    "project groups must not move when an existing session becomes active",
  );

  assert.deepEqual(
    sortSidebarSessions([refreshedBeta, alpha, olderRestored], [olderRestored.file.toUpperCase()]).map((item) => item.file),
    [olderRestored.file, refreshedBeta.file, alpha.file],
    "pinned sessions should sort before unpinned ones with case-insensitive path matching",
  );

  const configs: ProjectConfig[] = [
    { path: beta.cwd.toUpperCase(), name: "", pinned: true, hidden: false },
  ];
  assert.deepEqual(
    sortSidebarProjectGroups(groups, configs, [alpha.cwd, beta.cwd]).map(([workspace]) => workspace),
    [beta.cwd, alpha.cwd],
    "pinned projects should override workspace order",
  );
  assert.deepEqual(
    groups.map(([workspace]) => workspace),
    [alpha.cwd, beta.cwd],
    "sorting must not mutate the source group order",
  );
});

test("archiving preserves project slots while newly opened projects insert at the top", () => {
  function session(file: string, cwd: string, updatedAt = 100): SessionInfo {
    return { file, sessionId: file, cwd, messageCount: 1, updatedAt };
  }
  function groupsOf(sessions: SessionInfo[], emptyProjects: string[] = []): SidebarProjectGroup[] {
    const result = new Map<string, SessionInfo[]>();
    for (const item of sessions) result.set(item.cwd, [...(result.get(item.cwd) ?? []), item]);
    for (const path of emptyProjects) if (!result.has(path)) result.set(path, []);
    return [...result.entries()];
  }
  function projectOrder(order: SidebarOrder, sessions: SessionInfo[], emptyProjects: string[] = []): string[] {
    return sortSidebarProjectGroups(groupsOf(sessions, emptyProjects), [], order.workspaces)
      .map(([workspace]) => workspace);
  }

  const alphaNew = session("alpha-new", "D:\\alpha", 300);
  const beta = session("beta", "D:\\beta", 200);
  const alphaOld = session("alpha-old", "D:\\alpha", 100);
  const listed = [alphaNew, beta, alphaOld];

  // Legacy order with sessions only: projects follow their newest session.
  const upgraded = reconcileSidebarOrder({ sessions: listed.map((item) => item.file), workspaces: [] }, listed);
  assert.deepEqual(projectOrder(upgraded, listed), ["D:\\alpha", "D:\\beta"], "existing order should carry over");
  assert.deepEqual(reconcileSidebarOrder(upgraded, listed), upgraded, "reconciling should be idempotent");

  const afterArchive = reconcileSidebarOrder(upgraded, [beta, alphaOld]);
  assert.deepEqual(
    projectOrder(afterArchive, [beta, alphaOld]),
    ["D:\\alpha", "D:\\beta"],
    "archiving a project's newest session must not move the project",
  );

  const afterArchivingAll = reconcileSidebarOrder(afterArchive, [beta], ["D:\\alpha"]);
  assert.deepEqual(
    projectOrder(afterArchivingAll, [beta], ["D:\\alpha"]),
    ["D:\\alpha", "D:\\beta"],
    "a project whose chats are all archived should keep its slot",
  );

  const betaNew = session("beta-new", "D:\\beta", 500);
  const afterNewChat = reconcileSidebarOrder(afterArchive, [betaNew, beta, alphaOld]);
  assert.deepEqual(
    projectOrder(afterNewChat, [betaNew, beta, alphaOld]),
    ["D:\\alpha", "D:\\beta"],
    "a new chat in an existing workspace must keep workspace group order fixed",
  );
  assert.deepEqual(
    sortSidebarSessions([beta, betaNew], []).map((item) => item.file),
    [betaNew.file, beta.file],
    "the new chat moves to the top inside its own workspace",
  );

  // Opening a newly picked workspace inserts it at the top and keeps it fixed across subsequent chats.
  const withGammaOpened = reconcileSidebarOrder(
    afterNewChat,
    [betaNew, beta, alphaOld],
    ["D:\\alpha", "D:\\beta", "D:\\gamma"],
  );
  assert.deepEqual(
    projectOrder(withGammaOpened, [betaNew, beta, alphaOld], ["D:\\gamma"]),
    ["D:\\gamma", "D:\\alpha", "D:\\beta"],
    "a newly opened workspace should insert at the top",
  );
  const gammaChat = session("gamma-1", "D:\\gamma", 600);
  const afterGammaChat = reconcileSidebarOrder(
    withGammaOpened,
    [gammaChat, betaNew, beta, alphaOld],
    ["D:\\alpha", "D:\\beta", "D:\\gamma"],
  );
  assert.deepEqual(
    projectOrder(afterGammaChat, [gammaChat, betaNew, beta, alphaOld]),
    ["D:\\gamma", "D:\\alpha", "D:\\beta"],
    "starting a session in the top workspace keeps the fixed order stable",
  );

  assert.equal(
    reconcileSidebarOrder(afterNewChat, []),
    afterNewChat,
    "an empty list (sessions not loaded yet) must not wipe the remembered order",
  );
  assert.equal(
    reconcileSidebarOrder(withGammaOpened, [], ["D:\\alpha", "D:\\beta", "D:\\gamma"]),
    withGammaOpened,
    "registered projects arriving before sessions load must not churn an already-remembered order",
  );

  const fresh = reconcileSidebarOrder({ sessions: [], workspaces: [] }, listed);
  assert.deepEqual(projectOrder(fresh, listed), ["D:\\alpha", "D:\\beta"], "a first run should list projects by newest chat");

  const caseShifted = reconcileSidebarOrder(afterArchive, [session("BETA", "d:\\BETA"), session("ALPHA-OLD", "d:\\ALPHA")]);
  assert.deepEqual(caseShifted.workspaces, afterArchive.workspaces, "paths should match case-insensitively");
});

test("manual workspace drag-and-drop reorder", () => {
  const initial = ["d:/alpha", "d:/beta", "d:/gamma"];
  assert.deepEqual(
    reorderSidebarWorkspaces(initial, "D:\\gamma", "D:\\alpha", "before"),
    ["d:/gamma", "d:/alpha", "d:/beta"],
    "moving before the first workspace places it at the top",
  );
  assert.deepEqual(
    reorderSidebarWorkspaces(initial, "D:\\alpha", "D:\\beta", "after"),
    ["d:/beta", "d:/alpha", "d:/gamma"],
    "moving after a middle workspace inserts right after it",
  );
  assert.deepEqual(
    reorderSidebarWorkspaces(initial, "D:\\alpha", "D:\\alpha", "before"),
    initial,
    "dropping onto itself is a no-op",
  );
});

test("visibleProjectSessions, time buckets, and compact relative timestamps", () => {
  const chats: SessionInfo[] = Array.from({ length: 7 }, (_, index) => ({
    file: `s-${index}`,
    sessionId: `s-${index}`,
    cwd: "D:\\proj",
    messageCount: 1,
    updatedAt: 1_000 - index * 10,
  }));

  const collapsed = visibleProjectSessions(chats, false, (item) => item.file === "s-6", 5);
  assert.deepEqual(
    collapsed.visible.map((item) => item.file),
    ["s-0", "s-1", "s-2", "s-3", "s-4", "s-6"],
    "active/running/approval sessions beyond the cap stay visible when collapsed",
  );
  assert.equal(collapsed.hiddenCount, 1);

  const expanded = visibleProjectSessions(chats, true, (item) => item.file === "s-6", 5);
  assert.equal(expanded.visible.length, 7);
  assert.equal(expanded.hiddenCount, 0);

  const now = new Date(2026, 10, 17, 15, 30, 0).getTime();
  const sPinned: SessionInfo = { file: "p", sessionId: "p", cwd: "D:\\p", messageCount: 1, updatedAt: new Date(2026, 0, 5).getTime() };
  const sToday: SessionInfo = { file: "t", sessionId: "t", cwd: "D:\\p", messageCount: 1, updatedAt: now - 5 * 60_000 };
  const sYesterday: SessionInfo = { file: "y", sessionId: "y", cwd: "D:\\p", messageCount: 1, updatedAt: new Date(2026, 10, 16, 18, 0).getTime() };
  const sWeek: SessionInfo = { file: "w", sessionId: "w", cwd: "D:\\p", messageCount: 1, updatedAt: new Date(2026, 10, 13, 12, 0).getTime() };
  const sMonth: SessionInfo = { file: "m", sessionId: "m", cwd: "D:\\p", messageCount: 1, updatedAt: new Date(2026, 9, 25, 12, 0).getTime() };
  const sOlder: SessionInfo = { file: "o", sessionId: "o", cwd: "D:\\p", messageCount: 1, updatedAt: new Date(2025, 11, 10, 12, 0).getTime() };

  const buckets = groupSessionsByTimeBucket(
    [sOlder, sMonth, sWeek, sYesterday, sToday, sPinned],
    [sPinned.file],
    now,
  );
  assert.deepEqual(
    buckets.map((bucket) => [bucket.label, bucket.sessions.map((item) => item.file)]),
    [
      ["置顶", ["p"]],
      ["今天", ["t"]],
      ["昨天", ["y"]],
      ["过去 7 天", ["w"]],
      ["过去 30 天", ["m"]],
      ["更早", ["o"]],
    ],
  );

  assert.equal(compactRelativeTime({ ...sToday, updatedAt: now - 20_000 }, now), "刚刚");
  assert.equal(compactRelativeTime(sToday, now), "5m");
  assert.equal(compactRelativeTime({ ...sToday, updatedAt: now - 3 * 3_600_000 }, now), "3h");
  assert.equal(compactRelativeTime(sWeek, now), "4d");
  assert.equal(compactRelativeTime(sPinned, now), "01/05");
  assert.equal(compactRelativeTime(sOlder, now), "25/12");
});
