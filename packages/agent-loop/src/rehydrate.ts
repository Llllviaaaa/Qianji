/**
 * Post-compaction working-set rehydration: captures recently touched workspace
 * files and the latest plan from compacted events (carrying forward prior
 * compaction addenda across 2nd+ compactions) so long-running tasks retain
 * concrete anchors without altering pure-text/non-file compactions.
 */
import { currentBranch, type SessionEvent } from "@qianji/session";

const MAX_REHYDRATED_FILES = 8;
const MAX_REHYDRATED_PLAN_ITEMS = 8;
const WORKING_SET_HEADER = "[Working-set context]";

type FileAction = "modified" | "read";

function extractFilePath(args: Record<string, unknown>): string | undefined {
  const raw = typeof args.path === "string"
    ? args.path
    : typeof args.file_path === "string"
      ? args.file_path
      : undefined;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function formatPlanItem(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed === "" ? undefined : `- ${trimmed}`;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const item = raw as Record<string, unknown>;
  const textCandidate = [item.text, item.step, item.title, item.label, item.description]
    .find((value): value is string => typeof value === "string" && value.trim() !== "");
  if (textCandidate === undefined) return undefined;
  const status = typeof item.status === "string" && item.status.trim() !== "" ? `[${item.status.trim()}] ` : "";
  const id = typeof item.id === "string" && item.id.trim() !== "" ? `(${item.id.trim()}) ` : "";
  return `- ${status}${id}${textCandidate.trim()}`;
}

function extractPlanItems(args: Record<string, unknown>): string[] | undefined {
  const rawList = Array.isArray(args.plan)
    ? args.plan
    : Array.isArray(args.items)
      ? args.items
      : Array.isArray(args.steps)
        ? args.steps
        : undefined;
  if (rawList === undefined) return undefined;
  const formatted: string[] = [];
  for (const item of rawList) {
    const line = formatPlanItem(item);
    if (line !== undefined) formatted.push(line);
  }
  return formatted;
}

/**
 * Extract carried-forward file entries and plan lines from an earlier compaction's
 * `[Working-set context]` addendum so 2nd+ compactions preserve prior working-set files.
 */
function parseWorkingSetFromSummary(summary: string): { files: Array<[string, FileAction]>; planItems: string[] } {
  const markerIndex = summary.lastIndexOf(WORKING_SET_HEADER);
  if (markerIndex === -1) return { files: [], planItems: [] };
  const section = summary.slice(markerIndex + WORKING_SET_HEADER.length);
  const files: Array<[string, FileAction]> = [];
  const planItems: string[] = [];
  let mode: "files" | "plan" | undefined;
  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (/^Recent files(?: touched)?:$/.test(line)) {
      mode = "files";
      continue;
    }
    if (line === "Latest plan:") {
      mode = "plan";
      continue;
    }
    if (mode === "files") {
      const match = /^-\s+(.+?)\s+\((modified|read)\)$/.exec(line);
      if (match !== null && match[1] !== undefined && (match[2] === "modified" || match[2] === "read")) {
        files.push([match[1], match[2]]);
      } else if (!line.startsWith("- ")) {
        mode = undefined;
      }
    } else if (mode === "plan") {
      if (line.startsWith("- … (")) continue;
      if (line.startsWith("- ")) planItems.push(line);
      else mode = undefined;
    }
  }
  return { files, planItems };
}

/**
 * Build a concise working-set addendum from compacted branch events up to `throughSeq`.
 * Returns `""` when no `write`/`edit`/`read` file paths, prior working-set summaries,
 * or `update_plan` calls exist.
 */
export function buildCompactionWorkingSetAddendum(events: readonly SessionEvent[], throughSeq: number): string {
  const compactedBranch = currentBranch(events.filter((event) => event.seq <= throughSeq));
  const files = new Map<string, FileAction>();
  let latestPlanItems: string[] | undefined;

  for (let index = compactedBranch.length - 1; index >= 0; index -= 1) {
    const event = compactedBranch[index];
    if (event === undefined) continue;

    if (event.type === "compaction") {
      const carried = parseWorkingSetFromSummary(event.data.summary);
      for (const [filePath, action] of carried.files) {
        if (files.size >= MAX_REHYDRATED_FILES) break;
        if (!files.has(filePath)) files.set(filePath, action);
      }
      if (latestPlanItems === undefined && carried.planItems.length > 0) {
        latestPlanItems = carried.planItems;
      }
      if (files.size >= MAX_REHYDRATED_FILES && latestPlanItems !== undefined) break;
      continue;
    }

    if (event.type !== "tool-call") continue;
    const { name, args } = event.data;
    if (typeof args !== "object" || args === null) continue;

    if (name === "write" || name === "edit" || name === "read") {
      if (files.size < MAX_REHYDRATED_FILES) {
        const filePath = extractFilePath(args);
        if (filePath !== undefined && !files.has(filePath)) {
          files.set(filePath, name === "read" ? "read" : "modified");
        }
      }
    } else if (name === "update_plan" && latestPlanItems === undefined) {
      latestPlanItems = extractPlanItems(args);
    }

    if (files.size >= MAX_REHYDRATED_FILES && latestPlanItems !== undefined) break;
  }

  const planLines = latestPlanItems ?? [];
  if (files.size === 0 && planLines.length === 0) return "";

  const lines: string[] = [WORKING_SET_HEADER];
  if (files.size > 0) {
    lines.push("Recent files:");
    for (const [filePath, action] of files) {
      lines.push(`- ${filePath} (${action})`);
    }
  }
  if (planLines.length > 0) {
    lines.push("Latest plan:");
    for (const item of planLines.slice(0, MAX_REHYDRATED_PLAN_ITEMS)) {
      lines.push(item);
    }
    if (planLines.length > MAX_REHYDRATED_PLAN_ITEMS) {
      lines.push(`- … (${planLines.length - MAX_REHYDRATED_PLAN_ITEMS} more items)`);
    }
  }
  return lines.join("\n");
}
