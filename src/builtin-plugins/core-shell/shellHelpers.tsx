import { useId, type ReactNode } from "react";
import { SlotKernelErrorBoundary } from "@qianji/client-slots";
import type { SessionServiceSnapshot, TranscriptDensity, UiMessage } from "@qianji/client";

type SessionItem = SessionServiceSnapshot["sessions"][number];

export interface PanelSizeBounds {
  readonly min: number;
  readonly max: number;
  readonly fallback: number;
  readonly step: number;
}

export const SIDEBAR_WIDTH_KEY = "qianji:sidebar-width";
export const WORKSPACE_PANEL_WIDTH_KEY = "qianji:workspace-panel-width";

export const SIDEBAR_BOUNDS: PanelSizeBounds = {
  min: 200,
  max: 380,
  fallback: 260,
  step: 16,
};

export const WORKSPACE_PANEL_BOUNDS: PanelSizeBounds = {
  min: 300,
  max: 960,
  fallback: 460,
  step: 24,
};

export const TRANSCRIPT_DENSITY_ORDER: readonly TranscriptDensity[] = [
  "summary",
  "normal",
  "verbose",
];

export const TRANSCRIPT_DENSITY_LABELS: Readonly<Record<TranscriptDensity, string>> = {
  summary: "摘要",
  normal: "普通",
  verbose: "详细",
};

export function clampPanelSize(value: number, bounds: PanelSizeBounds, maxOverride?: number): number {
  const upper = maxOverride === undefined ? bounds.max : Math.max(bounds.min, Math.min(bounds.max, maxOverride));
  if (!Number.isFinite(value)) return bounds.fallback;
  return Math.round(Math.min(upper, Math.max(bounds.min, value)));
}

export function readStoredPanelSize(key: string, bounds: PanelSizeBounds): number {
  if (typeof window === "undefined") return bounds.fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return bounds.fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampPanelSize(parsed, bounds) : bounds.fallback;
  } catch {
    return bounds.fallback;
  }
}

export function writeStoredPanelSize(key: string, size: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(Math.round(size)));
  } catch {
    // Ignore storage write errors in restricted webviews.
  }
}

export function resolveWorkspacePanelMaxWidth(viewportWidth: number, scale: number, sidebarWidth: number): number {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const logicalWidth = viewportWidth / safeScale;
  const reserved = sidebarWidth + 360;
  return Math.max(WORKSPACE_PANEL_BOUNDS.min, Math.min(WORKSPACE_PANEL_BOUNDS.max, Math.floor(logicalWidth - reserved)));
}

export function aggregateDiffStats(diff: string | undefined): { additions: number; deletions: number } {
  if (!diff) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function normalizePath(path: string | null | undefined): string {
  if (!path) return "";
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function resolveActiveSessionTitle(options: {
  readonly sessions: readonly SessionItem[];
  readonly sessionFile: string | null;
  readonly sessionId: string | null;
  readonly sessionName: string | null;
  readonly messages: readonly UiMessage[];
}): string {
  const explicitName = options.sessionName?.trim();
  if (explicitName) return explicitName;
  const targetFile = normalizePath(options.sessionFile);
  const found = options.sessions.find(
    (item) =>
      (targetFile !== "" && normalizePath(item.file) === targetFile) ||
      (options.sessionId !== null && item.sessionId === options.sessionId),
  );
  const foundName = found?.name?.trim() || found?.firstMessage?.trim();
  if (foundName) return foundName.slice(0, 80);
  const firstUser = options.messages.find((msg) => msg.role === "user")?.content?.trim();
  if (firstUser) return firstUser.slice(0, 80);
  return "新对话";
}

export function DockLeftIcon({ open = false, size = 15 }: { readonly open?: boolean; readonly size?: number }) {
  const clipId = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <defs>
        <clipPath id={clipId}>
          <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2.5" />
        </clipPath>
      </defs>
      <rect
        x="1.75"
        y="2.25"
        width="4.5"
        height="11.5"
        fill="currentColor"
        fillOpacity={open ? 0.78 : 0.14}
        clipPath={`url(#${clipId})`}
      />
      <path d="M6.25 2.5V13.5" stroke="currentColor" strokeWidth="1.25" />
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function LegacyContributionBody<C>({
  renderFn,
  context,
}: {
  readonly renderFn: (ctx: C) => ReactNode;
  readonly context: C;
}): ReactNode {
  return renderFn(context);
}

/** Fault-isolated renderer for legacy `ctx.contributions` items inside built-in core plugins. */
export function LegacyContributionHost<C>({
  id,
  pluginId,
  slotKey,
  renderFn,
  context,
  compact = false,
}: {
  readonly id: string;
  readonly pluginId?: string;
  readonly slotKey: string;
  readonly renderFn: (ctx: C) => ReactNode;
  readonly context: C;
  readonly compact?: boolean;
}): ReactNode {
  const resolvedPluginId = pluginId ?? "builtin";
  return (
    <div
      data-qj-plugin={resolvedPluginId}
      data-qj-slot={slotKey}
      data-qj-legacy-slot={slotKey}
      data-qj-entry={id}
      style={{ display: "contents" }}
    >
      <SlotKernelErrorBoundary
        pluginId={resolvedPluginId}
        entryId={`legacy:${slotKey}:${id}`}
        slotKey={slotKey}
        compact={compact}
      >
        <LegacyContributionBody renderFn={renderFn} context={context} />
      </SlotKernelErrorBoundary>
    </div>
  );
}
