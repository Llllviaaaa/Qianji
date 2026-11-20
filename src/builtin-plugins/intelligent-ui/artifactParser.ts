/**
 * Self-contained Intelligent UI artifact extraction, zero-eval formula evaluator,
 * and CSP-sandboxed HTML builder for the built-in `intelligent-ui` plugin (ADR 0023).
 */
import type { UiMessage, UiToolCall } from "@qianji/client";

export type IntelligentUiEngine = "declarative" | "html";
export type IntelligentUiStateValue = number | string | boolean;
export type IntelligentUiStateMap = Record<string, IntelligentUiStateValue>;

export interface IntelligentUiControlItem {
  readonly key: string;
  readonly label: string;
  readonly kind: "slider" | "number" | "text" | "select" | "toggle";
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: string;
  readonly placeholder?: string;
  readonly options?: readonly { readonly label: string; readonly value: string | number }[];
}

export interface IntelligentUiStatItem {
  readonly label: string;
  readonly formula?: string;
  readonly value?: string | number;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly decimals?: number;
  readonly caption?: string;
}

export type IntelligentUiBlock =
  | { readonly type: "controls"; readonly title?: string; readonly items: readonly IntelligentUiControlItem[] }
  | { readonly type: "stats"; readonly title?: string; readonly items: readonly IntelligentUiStatItem[] }
  | { readonly type: "callout"; readonly tone?: string; readonly title?: string; readonly body: string }
  | {
      readonly type: "table";
      readonly title?: string;
      readonly columns: readonly { readonly key: string; readonly label: string }[];
      readonly rows: readonly Record<string, unknown>[];
    }
  | {
      readonly type: "form";
      readonly title?: string;
      readonly submitLabel?: string;
      readonly promptTemplate?: string;
      readonly fields?: readonly IntelligentUiControlItem[];
    };

export interface IntelligentUiDeclarativeSpec {
  readonly state?: IntelligentUiStateMap;
  readonly blocks: readonly IntelligentUiBlock[];
}

export interface IntelligentUiArtifact {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly subtitle?: string;
  readonly engine: IntelligentUiEngine;
  readonly spec?: IntelligentUiDeclarativeSpec;
  readonly html?: string;
  readonly updatedAt: string;
}

export interface IntelligentUiVersionGroup {
  readonly id: string;
  readonly versions: IntelligentUiArtifact[];
  latest: IntelligentUiArtifact;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeWidgetId(raw: unknown, fallback = "widget"): string {
  if (typeof raw !== "string") return fallback;
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || fallback).slice(0, 80);
}

function coerceState(raw: unknown): IntelligentUiStateMap {
  if (!isRecord(raw)) return {};
  const out: IntelligentUiStateMap = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "string" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

function parseSpec(raw: unknown): IntelligentUiDeclarativeSpec | undefined {
  let candidate: unknown = raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(candidate) || !Array.isArray(candidate.blocks) || candidate.blocks.length === 0) {
    return undefined;
  }
  const blocks = candidate.blocks.filter(
    (item): item is IntelligentUiBlock => isRecord(item) && typeof item.type === "string" && item.type.trim() !== "",
  );
  if (blocks.length === 0) return undefined;
  return { state: coerceState(candidate.state), blocks };
}

function normalizeToolName(name: string): string {
  const cleaned = name.trim().toLowerCase();
  const sep = cleaned.lastIndexOf("__");
  return sep >= 0 ? cleaned.slice(sep + 2) : cleaned;
}

function artifactFromToolCall(
  call: UiToolCall,
  toolName: "render_ui" | "update_ui",
  previous: IntelligentUiArtifact | undefined,
  timestamp: number,
): IntelligentUiArtifact | null {
  if (call.isError === true) return null;
  const source = isRecord(call.details) && typeof call.details.id === "string" ? call.details : call.args;
  const rawId = typeof source.id === "string" && source.id.trim() !== "" ? source.id : previous?.id;
  if (rawId === undefined) return null;
  const id = normalizeWidgetId(rawId);
  const title = typeof source.title === "string" && source.title.trim() !== "" ? source.title.trim() : previous?.title;
  if (title === undefined) return null;
  const subtitle = typeof source.subtitle === "string" && source.subtitle.trim() !== "" ? source.subtitle.trim() : previous?.subtitle;
  const hasHtml = typeof source.html === "string" && source.html.trim() !== "";
  const parsedSpec = parseSpec(source.spec);
  const engine: IntelligentUiEngine =
    source.engine === "html" || (hasHtml && parsedSpec === undefined && source.engine !== "declarative")
      ? "html"
      : source.engine === "declarative" || parsedSpec !== undefined
        ? "declarative"
        : (previous?.engine ?? "declarative");
  const version = (previous?.version ?? 0) + 1;
  const updatedAt = new Date(call.finishedAt ?? call.startedAt ?? timestamp).toISOString();

  if (engine === "html") {
    const html = hasHtml ? String(source.html).trim() : previous?.html;
    if (html === undefined || html === "") return null;
    return { id, version, title, ...(subtitle === undefined ? {} : { subtitle }), engine: "html", html, updatedAt };
  }

  let spec = parsedSpec ?? previous?.spec;
  if (spec === undefined) return null;
  if (toolName === "update_ui" && isRecord(source.state)) {
    spec = { ...spec, state: { ...(spec.state ?? {}), ...coerceState(source.state) } };
  }
  return { id, version, title, ...(subtitle === undefined ? {} : { subtitle }), engine: "declarative", spec, updatedAt };
}

function extractFenceArtifacts(markdown: string, messageId: string, timestamp: number): IntelligentUiArtifact[] {
  if (!markdown.includes("intelligent-ui")) return [];
  const results: IntelligentUiArtifact[] = [];
  const re = /```intelligent-ui[ \t]*\r?\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  let idx = 0;
  while ((match = re.exec(markdown)) !== null) {
    idx += 1;
    const raw = (match[1] ?? "").trim();
    if (raw === "") continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) continue;
      const id = normalizeWidgetId(parsed.id, `fence-${messageId}-${idx}`);
      const title = typeof parsed.title === "string" && parsed.title.trim() !== "" ? parsed.title.trim() : "交互式组件";
      const subtitle = typeof parsed.subtitle === "string" && parsed.subtitle.trim() !== "" ? parsed.subtitle.trim() : undefined;
      const updatedAt = new Date(timestamp).toISOString();
      if (parsed.engine === "html" || (typeof parsed.html === "string" && parsed.html.trim() !== "")) {
        results.push({
          id,
          version: 1,
          title,
          ...(subtitle === undefined ? {} : { subtitle }),
          engine: "html",
          html: String(parsed.html).trim(),
          updatedAt,
        });
      } else {
        const spec = parseSpec(parsed.spec ?? parsed);
        if (spec !== undefined) {
          results.push({
            id,
            version: 1,
            title,
            ...(subtitle === undefined ? {} : { subtitle }),
            engine: "declarative",
            spec,
            updatedAt,
          });
        }
      }
    } catch {
      // Ignore malformed fence JSON.
    }
  }
  return results;
}

export function deriveSessionWidgets(messages: readonly UiMessage[]): readonly IntelligentUiVersionGroup[] {
  const groupsById = new Map<string, IntelligentUiVersionGroup>();
  const orderedIds: string[] = [];

  const pushArtifact = (artifact: IntelligentUiArtifact) => {
    const existing = groupsById.get(artifact.id);
    if (existing === undefined) {
      groupsById.set(artifact.id, { id: artifact.id, versions: [artifact], latest: artifact });
      orderedIds.push(artifact.id);
      return;
    }
    const versioned: IntelligentUiArtifact = { ...artifact, version: existing.versions.length + 1 };
    existing.versions.push(versioned);
    existing.latest = versioned;
  };

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const seenInTurn = new Set<string>();
    for (const call of msg.toolCalls ?? []) {
      const tool = normalizeToolName(call.name);
      if (tool !== "render_ui" && tool !== "update_ui") continue;
      const rawId = isRecord(call.args) && typeof call.args.id === "string" ? normalizeWidgetId(call.args.id) : undefined;
      const prev = rawId !== undefined ? groupsById.get(rawId)?.latest : undefined;
      const artifact = artifactFromToolCall(call, tool, prev, msg.timestamp);
      if (artifact === null) continue;
      seenInTurn.add(artifact.id);
      pushArtifact(artifact);
    }
    if (msg.content !== "") {
      for (const fenced of extractFenceArtifacts(msg.content, msg.id, msg.timestamp)) {
        if (!seenInTurn.has(fenced.id)) pushArtifact(fenced);
      }
    }
  }

  return orderedIds
    .map((id) => groupsById.get(id))
    .filter((group): group is IntelligentUiVersionGroup => group !== undefined);
}

export function buildInitialState(spec?: IntelligentUiDeclarativeSpec): IntelligentUiStateMap {
  if (spec === undefined) return {};
  const merged: IntelligentUiStateMap = { ...(spec.state ?? {}) };
  for (const block of spec.blocks) {
    const items = block.type === "controls" ? block.items : block.type === "form" ? (block.fields ?? []) : [];
    for (const item of items) {
      if (item.key in merged) continue;
      if (item.kind === "toggle") merged[item.key] = false;
      else if (item.kind === "select") merged[item.key] = item.options?.[0]?.value ?? "";
      else if (item.kind === "slider" || item.kind === "number") merged[item.key] = item.min ?? 0;
      else merged[item.key] = "";
    }
  }
  return merged;
}

/** Zero-eval simple arithmetic/variable interpolation for declarative stats and prompt templates. */
export function interpolateWidgetText(template: string, state: IntelligentUiStateMap): string {
  return template.replace(/\{(=?)([^{}]+)\}/g, (full, _eq: string, keyRaw: string) => {
    const key = keyRaw.trim();
    if (key in state) return String(state[key]);
    return full;
  });
}

export function serializeWidgetArtifact(artifact: IntelligentUiArtifact): string {
  if (artifact.engine === "html") return artifact.html ?? "";
  return JSON.stringify(
    {
      id: artifact.id,
      title: artifact.title,
      ...(artifact.subtitle === undefined ? {} : { subtitle: artifact.subtitle }),
      engine: "declarative",
      spec: artifact.spec,
    },
    null,
    2,
  );
}

export function buildSandboxedWidgetHtml(artifact: IntelligentUiArtifact, isDark: boolean): string {
  const escapedTitle = artifact.title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const bg = isDark ? "#141619" : "#ffffff";
  const fg = isDark ? "#e6e8ec" : "#181a1e";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; connect-src 'none';" />
<title>${escapedTitle}</title>
<style>html,body{margin:0;padding:12px;background:${bg};color:${fg};font:13px/1.5 system-ui,sans-serif;}</style>
</head>
<body><div id="pi-widget-root">${artifact.html ?? ""}</div></body>
</html>`;
}
