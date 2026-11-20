/**
 * Pure derivation helpers for `CoreInspectorSections` (`core-workbench`, ADR 0023).
 */
import type { UiMessage, UiToolCall } from "@qianji/client";

export const EMPTY_MESSAGES: readonly UiMessage[] = [];

export interface DerivedOutputItem {
  readonly id: string;
  readonly path: string;
  readonly fileName: string;
}

export interface DerivedPlanItem {
  readonly id: string;
  readonly text: string;
  readonly status: "pending" | "in_progress" | "completed";
}

export function splitWorkspaceDisplay(cwd: string): { name: string; parent: string } {
  const cleaned = cwd.replace(/[\\/]+$/, "");
  if (cleaned === "") return { name: "未选择工作区", parent: "" };
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  const name = parts.pop() ?? cleaned;
  const sep = cleaned.includes("\\") ? "\\" : "/";
  return { name, parent: parts.length > 0 ? parts.join(sep) : "" };
}

function extractToolFilePath(call: UiToolCall): string | undefined {
  for (const key of ["path", "file", "filename", "filePath", "target"]) {
    const val = call.args[key];
    if (typeof val === "string" && val.trim() !== "") return val.trim();
  }
  const patch = typeof call.args.patch === "string" ? call.args.patch : "";
  const match = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/m.exec(patch);
  return match?.[1]?.trim();
}

export function deriveOutputs(messages: readonly UiMessage[], limit = 20): DerivedOutputItem[] {
  const byPath = new Map<string, DerivedOutputItem>();
  for (const msg of messages) {
    for (const call of msg.toolCalls ?? []) {
      const name = call.name.toLowerCase();
      const isWrite =
        name === "write" ||
        name.includes("write_file") ||
        name === "edit" ||
        name === "apply_patch" ||
        name.includes("edit_file");
      if (!isWrite || call.isError === true) continue;
      const path = extractToolFilePath(call);
      if (path === undefined) continue;
      const key = path.replace(/\\/g, "/").toLowerCase();
      byPath.set(key, {
        id: call.id,
        path,
        fileName: path.split(/[\\/]/).pop() ?? path,
      });
    }
  }
  return [...byPath.values()].slice(-limit).reverse();
}

export function derivePlanSteps(messages: readonly UiMessage[]): DerivedPlanItem[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg === undefined) continue;
    const calls = msg.toolCalls ?? [];
    for (let j = calls.length - 1; j >= 0; j -= 1) {
      const call = calls[j];
      if (call === undefined) continue;
      const lower = call.name.toLowerCase();
      if (lower !== "update_plan" && lower !== "plan_update" && lower !== "todo_write") continue;
      const rawSteps = Array.isArray(call.args.plan)
        ? call.args.plan
        : Array.isArray(call.args.todos)
          ? call.args.todos
          : [];
      const parsed: DerivedPlanItem[] = [];
      rawSteps.forEach((raw, idx) => {
        if (typeof raw !== "object" || raw === null) return;
        const rec = raw as Record<string, unknown>;
        const text = typeof rec.step === "string" ? rec.step : typeof rec.content === "string" ? rec.content : "";
        if (text.trim() === "") return;
        const status =
          rec.status === "completed" || rec.status === "in_progress" ? rec.status : "pending";
        parsed.push({ id: `${call.id}:${idx}`, text: text.trim(), status });
      });
      if (parsed.length > 0) return parsed;
    }
  }
  return [];
}
