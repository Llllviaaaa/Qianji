/**
 * Post-compaction working-set rehydration: captures recently touched workspace
 * files and the latest plan from compacted events so long-running tasks retain
 * concrete anchors without altering pure-text/non-file compactions.
 */
import { currentBranch, type SessionEvent } from "@qianji/session";

const MAX_REHYDRATED_FILES = 8;
const MAX_REHYDRATED_PLAN_ITEMS = 8;

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
 * Build a concise working-set addendum from compacted branch events up to `throughSeq`.
 * Returns `""` when no `write`/`edit`/`read` file paths and no `update_plan` calls exist.
 */
export function buildCompactionWorkingSetAddendum(events: readonly SessionEvent[], throughSeq: number): string {
  const compactedBranch = currentBranch(events.filter((event) => event.seq <= throughSeq));
  const files = new Map<string, FileAction>();
  let latestPlanItems: string[] | undefined;

  for (let index = compactedBranch.length - 1; index >= 0; index -= 1) {
    const event = compactedBranch[index];
    if (event?.type !== "tool-call") continue;
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

  const lines: string[] = ["[Working-set context]"];
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
