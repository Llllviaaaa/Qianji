/**
 * Dynamic `swarm-protocol` system prompt section, initial worker brief wrapper,
 * `<swarm-doorbell>` wakeup message formatter, and `/swarm` Coordinator kickoff prompt.
 */
import type {
  SwarmBoardMessage,
  SwarmMemberInfo,
  SwarmRunInfo,
  SwarmSnapshotResult,
} from "@qianji/protocol";

export function buildSwarmProtocolSection(
  snapshot: SwarmSnapshotResult,
  sessionId: string,
): string | undefined {
  const { run, members } = snapshot;
  if (run.status === "stopped" || run.status === "completed") return undefined;

  if (run.coordinatorSessionId === sessionId) {
    const activeWorkers = members.filter((m) => m.role !== "coordinator" && !m.killed);
    const rosterSummary = activeWorkers.length === 0
      ? "none spawned yet"
      : activeWorkers.map((m) => `@${m.name} (${m.role}, ${m.state}, ${m.workspaceMode})`).join(", ");
    const outcomeWorkers = activeWorkers.filter((m) => m.role !== "monitor");
    const completedWorkers = outcomeWorkers.filter((m) => m.completedAt !== undefined).length;
    const threadCount = run.plan?.threads.length ?? 0;
    return [
      `<swarm-coordinator id="${run.id}" status="${run.status}">`,
      `Active Swarm: "${run.title}" — Goal: ${run.goal}`,
      `Workers: ${rosterSummary} | Outcomes: ${completedWorkers}/${outcomeWorkers.length} done (${threadCount} threads) | Board head: #${run.headSeq}`,
      "4-Tool Swarm Kernel (`swarm`, `post_message`, `read_board`, `swarm_wait`):",
      "1. Spawn named specialists via `swarm(action:\"add\", name, role, brief)` with non-overlapping file ownership: ALWAYS pass the accurate `role` (`\"planner\" | \"explorer\" | \"worker\" | \"verifier\" | \"monitor\"`) and leave `model`/`provider` omitted unless the user explicitly requested a model override, so each role automatically uses the user's configured role model & reasoning effort. Read-only roles (`explorer`, `planner`, `verifier`, `monitor`) default to `inherit`; `worker` defaults to isolated `share` Git worktree.",
      "2. Publish outcome threads via `swarm(action:\"plan\", goalTitle, goalLine, memberTasks, threads)` grouping workers into 1–6 outcome-oriented deliverable threads (never 1-per-agent unless single piece).",
      "3. Sleep on `swarm_wait(since)` using your highest read `#seq`, cite earlier posts by `#seq` instead of re-quoting, verify & merge isolated `share` worktrees via `swarm(action:\"merge\", name)` before `kill`, and close with `[done]`.",
      "- `@name` is a wakeup doorbell (parked workers cost 0 tokens while `waiting`); never use `@all` for routine status.",
      "</swarm-coordinator>",
    ].join("\n");
  }

  const member = members.find((m) => m.sessionId === sessionId && !m.killed);
  if (member === undefined) return undefined;

  const workspaceLine = member.workspaceMode === "inherit"
    ? `Workspace: shared read/inspect workspace (${run.cwd}).`
    : `Workspace: isolated Git worktree (${member.workspaceMode}) at ${member.worktreePath ?? run.cwd}${member.branchName !== undefined ? ` on branch ${member.branchName}` : ""}. Focus strictly on your assigned files.`;

  return [
    `<swarm-worker swarm="${run.id}" name="${member.name}" role="${member.role}">`,
    `You are @${member.name} (${member.role}) in swarm "${run.title}". Subscribed channels: ${member.channels.map((c) => `#${c}`).join(", ")}.`,
    workspaceLine,
    "4-Tool Board Discipline (`read_board`, `post_message`, `swarm_wait`, `swarm`):",
    "- Start immediately on your brief. Use `read_board` (`since` = last seen seq) before picking up unassigned work; no greetings or empty acknowledgements. Refer to earlier posts by `#seq`.",
    "- `@name` is a wakeup doorbell: on peer handoffs (e.g. `@verifier [done] ...`), tag ONLY the next peer, not `@coordinator`, unless final deliverable is ready or you are blocked. If blocked on a peer question, `@peer ...?` marks `waitingOn` until they reply.",
    "- When capturing visual proof, include `Screenshot: <path> | <caption>` on its own line.",
    "- When finished, post `@<target> [done] <concise summary & verified files>` via `post_message`; ending your turn automatically parks you in 0-token `waiting` state until someone `@mentions` you.",
    "</swarm-worker>",
  ].join("\n");
}

export function buildWorkerInitialPrompt(
  run: SwarmRunInfo,
  member: SwarmMemberInfo,
  briefSeq: number,
): string {
  const modeDesc = member.workspaceMode === "inherit"
    ? `inherit (${run.cwd})`
    : `${member.workspaceMode} worktree (${member.worktreePath ?? run.cwd})`;
  return [
    `<swarm-assignment swarm="${run.id}" name="${member.name}" role="${member.role}" workspace="${modeDesc}" seq="${briefSeq}">`,
    `Swarm Goal: ${run.goal}`,
    `Assigned by @${member.addedBy} (board #${briefSeq}):`,
    member.brief,
    "</swarm-assignment>",
  ].join("\n");
}

export function buildDoorbellPrompt(
  run: SwarmRunInfo,
  member: SwarmMemberInfo,
  unread: SwarmBoardMessage[],
  nudgeNote?: string,
): string {
  const lines = unread.map(
    (msg) => `[#${msg.seq} #${msg.channel} @${msg.sender}] ${msg.text}`,
  );
  const body = lines.length > 0 ? lines.join("\n\n") : "(No new board messages)";
  const extra = nudgeNote !== undefined && nudgeNote.trim() !== ""
    ? `\n\nDirect control note:\n${nudgeNote.trim()}`
    : "";
  return [
    `<swarm-doorbell swarm="${run.id}" member="${member.name}" head_seq="${run.headSeq}">`,
    `New board activity addressed to @${member.name}:`,
    body,
    "</swarm-doorbell>",
    extra,
  ].filter(Boolean).join("\n");
}

export function buildCoordinatorKickoffPrompt(
  snapshot: SwarmSnapshotResult,
  goal: string,
): string {
  return [
    `Swarm "${snapshot.run.title}" (swarmId: \`${snapshot.run.id}\`) is active.`,
    "",
    `Goal: ${goal}`,
    "",
    "Orchestrate this goal using the 4-tool Swarm kernel (`swarm`, `post_message`, `read_board`, `swarm_wait`):",
    "1. Inspect relevant files briefly, then spawn named role-typed specialists via `swarm(action: \"add\", name, role, brief)` with exclusive file boundaries — always pass accurate `role` (`\"planner\" | \"explorer\" | \"worker\" | \"verifier\" | \"monitor\"`) and leave `model` omitted unless explicitly requested so role model settings apply.",
    "2. Publish 1–6 outcome threads via `swarm(action: \"plan\", goalTitle, goalLine, memberTasks, threads)` (group members by deliverable outcome, never 1-per-agent unless single piece).",
    "3. Sleep on `swarm_wait(since)` while workers execute in parallel, cite board posts by `#seq`, verify & merge isolated `share` worktrees via `swarm(action: \"merge\", name)`, and close with `[done]`.",
  ].join("\n");
}
