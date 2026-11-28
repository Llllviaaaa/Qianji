/**
 * Outcome-thread synthesis (`run.plan`), board-derived member states
 * (`completedAt`, `waitingOn`), live `currentStep` formatting, and
 * `Screenshot:` reel extraction (`@qianji/swarm`).
 */
import { relative, resolve } from "node:path";
import type {
  SwarmBoardMessage,
  SwarmMemberInfo,
  SwarmPlanOverview,
  SwarmPlanThread,
  SwarmRunInfo,
  SwarmScreenshotItem,
} from "@qianji/protocol";
import { stripCodeForMentions } from "./board.ts";

export const MAX_PLAN_THREADS = 6;
export const MAX_STEP_CHARS = 72;
const MAX_BRIEF_TASK_CHARS = 80;
const SCREENSHOT_LINE_RE = /^Screenshot:\s*(.+?)\s*\|\s*(.+)$/gim;
const BOLD_HEADING_RE = /\*\*([^*\n]{2,200})\*\*/;
const QUESTION_MARK_RE = /[?？]/;

export interface SwarmPlanThreadInput {
  id?: string;
  title: string;
  goal?: string;
  members: string[];
}

export interface SwarmPlanUpdateInput {
  swarmId: string;
  goalTitle?: string;
  goalLine?: string;
  memberTasks?: Record<string, string>;
  threads?: SwarmPlanThreadInput[];
}

export function truncateStepText(raw: string, maxChars = MAX_STEP_CHARS): string {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

export function summarizeMemberBrief(brief: string, role: string): string {
  const withoutFences = brief.replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)/g, " ");
  for (const rawLine of withoutFences.split(/\r?\n/)) {
    const line = rawLine
      .trim()
      .replace(/^@[a-zA-Z0-9_-]+\s+/, "")
      .replace(/^#+\s*/, "")
      .replace(/^[-*•]\s*/, "")
      .trim();
    if (line !== "") return truncateStepText(line, MAX_BRIEF_TASK_CHARS);
  }
  return `${role} task`;
}

export function clonePlanOverview(plan: SwarmPlanOverview | undefined): SwarmPlanOverview | undefined {
  if (plan === undefined) return undefined;
  return {
    goalTitle: plan.goalTitle,
    goalLine: plan.goalLine,
    tasks: { ...plan.tasks },
    threads: plan.threads.map((t) => ({
      id: t.id,
      title: t.title,
      goal: t.goal,
      members: [...t.members],
    })),
  };
}

export function sanitizePlanOverview(raw: unknown): SwarmPlanOverview | undefined {
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const rec = raw as Record<string, unknown>;
  const goalTitle = typeof rec.goalTitle === "string" ? rec.goalTitle.trim() : "";
  const goalLine = typeof rec.goalLine === "string" ? rec.goalLine.trim() : "";
  const tasks: Record<string, string> = {};
  if (rec.tasks !== undefined && rec.tasks !== null && typeof rec.tasks === "object" && !Array.isArray(rec.tasks)) {
    for (const [k, v] of Object.entries(rec.tasks as Record<string, unknown>)) {
      const key = k.trim().toLowerCase();
      if (key !== "" && typeof v === "string" && v.trim() !== "") {
        tasks[key] = v.trim();
      }
    }
  }
  const threads: SwarmPlanThread[] = [];
  if (Array.isArray(rec.threads)) {
    for (let i = 0; i < rec.threads.length; i += 1) {
      const item = rec.threads[i];
      if (item === undefined || item === null || typeof item !== "object" || Array.isArray(item)) continue;
      const t = item as Record<string, unknown>;
      const title = typeof t.title === "string" ? t.title.trim() : "";
      if (title === "") continue;
      const id = typeof t.id === "string" && t.id.trim() !== "" ? t.id.trim() : `thread-${i + 1}`;
      const goal = typeof t.goal === "string" ? t.goal.trim() : "";
      const members = Array.isArray(t.members)
        ? [...new Set(t.members.filter((m): m is string => typeof m === "string").map((m) => m.trim().toLowerCase()).filter((m) => m !== ""))]
        : [];
      threads.push({ id, title, goal, members });
    }
  }
  if (goalTitle === "" && goalLine === "" && Object.keys(tasks).length === 0 && threads.length === 0) {
    return undefined;
  }
  return { goalTitle, goalLine, tasks, threads: capPlanThreads(threads) };
}

function capPlanThreads(threads: SwarmPlanThread[]): SwarmPlanThread[] {
  if (threads.length <= MAX_PLAN_THREADS) return threads;
  const kept = threads.slice(0, MAX_PLAN_THREADS).map((t) => ({ ...t, members: [...t.members] }));
  const last = kept[MAX_PLAN_THREADS - 1];
  if (last !== undefined) {
    const seen = new Set(last.members);
    for (const extra of threads.slice(MAX_PLAN_THREADS)) {
      for (const m of extra.members) {
        if (!seen.has(m)) {
          seen.add(m);
          last.members.push(m);
        }
      }
    }
  }
  return kept;
}

export function applySwarmPlanUpdate(run: SwarmRunInfo, input: SwarmPlanUpdateInput): SwarmPlanOverview {
  const prev = run.plan;
  const goalTitle = input.goalTitle?.trim() || prev?.goalTitle || run.title;
  const goalLine = input.goalLine?.trim() || prev?.goalLine || run.goal;
  const tasks: Record<string, string> = { ...(prev?.tasks ?? {}) };
  if (input.memberTasks !== undefined) {
    for (const [rawName, rawLabel] of Object.entries(input.memberTasks)) {
      const key = rawName.trim().toLowerCase().replace(/^@/, "");
      const val = typeof rawLabel === "string" ? rawLabel.trim() : "";
      if (key !== "" && val !== "") tasks[key] = truncateStepText(val, MAX_BRIEF_TASK_CHARS);
    }
  }

  let threads: SwarmPlanThread[];
  if (input.threads !== undefined) {
    const usedIds = new Set<string>();
    const normalized: SwarmPlanThread[] = [];
    for (let i = 0; i < input.threads.length; i += 1) {
      const item = input.threads[i];
      if (item === undefined) continue;
      const title = typeof item.title === "string" ? item.title.trim() : "";
      if (title === "") continue;
      const rawId = typeof item.id === "string" && item.id.trim() !== "" ? item.id.trim() : `thread-${i + 1}`;
      const id = usedIds.has(rawId) ? `${rawId}-${i + 1}` : rawId;
      usedIds.add(id);
      const goal = typeof item.goal === "string" ? item.goal.trim() : "";
      const members = Array.isArray(item.members)
        ? [
            ...new Set(
              item.members
                .filter((m): m is string => typeof m === "string")
                .map((m) => m.trim().toLowerCase().replace(/^@/, ""))
                .filter((m) => m !== "" && m !== "coordinator"),
            ),
          ]
        : [];
      normalized.push({ id, title, goal, members });
    }
    threads = capPlanThreads(normalized);
  } else {
    threads = (prev?.threads ?? []).map((t) => ({ ...t, members: [...t.members] }));
  }

  const next: SwarmPlanOverview = { goalTitle, goalLine, tasks, threads };
  run.plan = next;
  return clonePlanOverview(next) ?? next;
}

export function isEligibleOutcomeWorker(member: SwarmMemberInfo): boolean {
  if (member.role === "coordinator" || member.role === "monitor") return false;
  return !member.killed || member.completedAt !== undefined;
}

export function synthesizeSwarmPlan(run: SwarmRunInfo, members: Iterable<SwarmMemberInfo>): SwarmPlanOverview {
  const memberList = [...members];
  const eligible = memberList.filter(isEligibleOutcomeWorker);
  const explicit = run.plan;
  const goalTitle = explicit?.goalTitle?.trim() || run.title;
  const goalLine = explicit?.goalLine?.trim() || run.goal;

  const tasks: Record<string, string> = { ...(explicit?.tasks ?? {}) };
  for (const worker of eligible) {
    const existing = tasks[worker.name];
    if (existing === undefined || existing.trim() === "") {
      tasks[worker.name] = summarizeMemberBrief(worker.brief, worker.role);
    }
  }

  const threads: SwarmPlanThread[] = (explicit?.threads ?? []).map((t) => ({
    id: t.id,
    title: t.title,
    goal: t.goal,
    members: [...t.members],
  }));

  const assigned = new Set<string>();
  for (const thread of threads) {
    for (const m of thread.members) assigned.add(m);
  }
  const ungrouped = eligible.filter((m) => !assigned.has(m.name)).map((m) => m.name);

  if (threads.length === 0) {
    threads.push({
      id: "main-outcome",
      title: goalTitle,
      goal: goalLine,
      members: ungrouped,
    });
  } else if (ungrouped.length > 0) {
    if (threads.length < MAX_PLAN_THREADS) {
      const fallbackId = threads.some((t) => t.id === "shared-outcome")
        ? `shared-outcome-${threads.length + 1}`
        : "shared-outcome";
      threads.push({
        id: fallbackId,
        title: "补充协作任务",
        goal: goalLine,
        members: ungrouped,
      });
    } else {
      const last = threads[MAX_PLAN_THREADS - 1];
      if (last !== undefined) {
        for (const name of ungrouped) {
          if (!last.members.includes(name)) last.members.push(name);
        }
      }
    }
  }

  return { goalTitle, goalLine, tasks, threads };
}

export function extractBoardScreenshots(messages: readonly SwarmBoardMessage[]): SwarmScreenshotItem[] {
  const items: SwarmScreenshotItem[] = [];
  for (const msg of messages) {
    const normalized = msg.text.replace(/\r\n/g, "\n");
    SCREENSHOT_LINE_RE.lastIndex = 0;
    for (const match of normalized.matchAll(SCREENSHOT_LINE_RE)) {
      const path = match[1]?.trim() ?? "";
      const caption = match[2]?.trim() ?? "";
      if (path !== "" && caption !== "") {
        items.push({
          seq: msg.seq,
          sender: msg.sender,
          path,
          caption,
          createdAt: msg.createdAt,
        });
      }
    }
  }
  return items;
}

export function applyBoardMessageMemberState(
  members: ReadonlyMap<string, { info: SwarmMemberInfo }>,
  message: SwarmBoardMessage,
): string[] {
  const mutated = new Set<string>();

  for (const [name, entry] of members) {
    if (entry.info.waitingOn === message.sender) {
      delete entry.info.waitingOn;
      mutated.add(name);
    }
  }

  const senderEntry = members.get(message.sender);
  if (senderEntry !== undefined && !senderEntry.info.killed) {
    if (message.isDone) {
      senderEntry.info.completedAt = message.createdAt;
      delete senderEntry.info.waitingOn;
      mutated.add(senderEntry.info.name);
    } else if (!message.mentionAll && message.mentions.length > 0) {
      const stripped = stripCodeForMentions(message.text);
      if (QUESTION_MARK_RE.test(stripped)) {
        const peerName = resolveAskedPeerName(members, message.mentions, message.sender);
        if (peerName !== undefined) {
          senderEntry.info.waitingOn = peerName;
          mutated.add(senderEntry.info.name);
        }
      }
    }
  }

  return [...mutated];
}

function resolveAskedPeerName(
  members: ReadonlyMap<string, { info: SwarmMemberInfo }>,
  mentions: readonly string[],
  sender: string,
): string | undefined {
  for (const token of mentions) {
    if (token === sender) continue;
    if (members.has(token)) return token;
    for (const m of members.values()) {
      if (!m.info.killed && m.info.groupPrefix === token) return m.info.name;
    }
  }
  return mentions.find((token) => token !== sender);
}

function shortenPathForStep(rawPath: string, baseCwd?: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "") return "";
  if (baseCwd !== undefined && baseCwd.trim() !== "") {
    try {
      const absBase = resolve(baseCwd);
      const absTarget = resolve(absBase, trimmed);
      const rel = relative(absBase, absTarget).replace(/\\/g, "/");
      if (rel !== "" && !rel.startsWith("../") && rel !== "..") {
        return rel;
      }
    } catch {
      // Fall back to normalized raw path.
    }
  }
  return trimmed.replace(/\\/g, "/");
}

export function formatToolCallStep(
  toolName: string,
  args: Record<string, unknown>,
  baseCwd?: string,
): string {
  const lower = toolName.toLowerCase();
  if (lower === "swarm") {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    const target = typeof args.name === "string" && args.name.trim() !== "" ? ` @${args.name.trim()}` : "";
    return truncateStepText(action !== "" ? `swarm ${action}${target}` : "swarm");
  }
  if (lower === "post_message") {
    const ch = typeof args.channel === "string" && args.channel.trim() !== "" ? args.channel.trim().replace(/^#/, "") : "main";
    return truncateStepText(`post_message #${ch}`);
  }
  if (lower === "read_board" || lower === "swarm_wait") {
    return toolName;
  }

  for (const pathKey of ["path", "file", "filePath", "target", "Path"]) {
    const val = args[pathKey];
    if (typeof val === "string" && val.trim() !== "") {
      return truncateStepText(`${toolName} ${shortenPathForStep(val, baseCwd)}`);
    }
  }
  for (const cmdKey of ["command", "cmd", "CommandLine"]) {
    const val = args[cmdKey];
    if (typeof val === "string" && val.trim() !== "") {
      const firstLine = val.trim().split(/\r?\n/)[0] ?? "";
      return truncateStepText(`${toolName} ${firstLine}`);
    }
  }
  for (const queryKey of ["pattern", "query", "glob", "url", "action", "name"]) {
    const val = args[queryKey];
    if (typeof val === "string" && val.trim() !== "") {
      return truncateStepText(`${toolName} ${val.trim()}`);
    }
  }
  return truncateStepText(toolName);
}

export function extractBoldHeadingStep(thinkingText: string): string | undefined {
  const match = BOLD_HEADING_RE.exec(thinkingText);
  const heading = match?.[1]?.trim();
  return heading !== undefined && heading !== "" ? truncateStepText(heading) : undefined;
}
