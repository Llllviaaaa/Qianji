/**
 * Action Timeline Recorder, Pointer Telemetry & 1-Click Seamless Takeover State Machine
 * (`packages/host/src/bot/computer/timeline-and-takeover.ts`).
 */
import { randomUUID } from "node:crypto";
import type {
  BotComputerEngineId,
  BotComputerEventNotification,
  BotComputerPointerAction,
  BotComputerPointerTelemetry,
  BotComputerStreamFrame,
  BotComputerTakeoverActionParams,
  BotComputerTakeoverState,
  BotComputerTimelineStatus,
  BotComputerTimelineStep,
  BotComputerViewTab,
  BotDesktopNotificationPayload,
  BotRemoteComputerNode,
} from "@qianji/protocol";
import type { ToolCall, ToolOutput } from "@qianji/tools";
import type { PersistedBotState } from "../defaults.ts";

const MAX_TIMELINE_STEPS = 80;

export interface PersistedComputerStudioState {
  activeEngine: BotComputerEngineId;
  activeTab: BotComputerViewTab;
  autoFollow: boolean;
  remoteNodes: BotRemoteComputerNode[];
  activeRemoteNodeId?: string;
  takeover: BotComputerTakeoverState;
  timeline: BotComputerTimelineStep[];
  nextSeq: number;
}

export function buildDefaultComputerStudioState(mode: "local" | "remote" = "local"): PersistedComputerStudioState {
  return {
    activeEngine: mode === "remote" ? "remote-vm" : "local-linux",
    activeTab: "browser",
    autoFollow: true,
    remoteNodes: [],
    takeover: { status: "idle" },
    timeline: [],
    nextSeq: 1,
  };
}

export function ensureComputerStudioState(st: PersistedBotState): PersistedComputerStudioState {
  if (!st.computerStudio) {
    st.computerStudio = buildDefaultComputerStudioState(st.virtualServer.mode);
  }
  const cs = st.computerStudio;
  if (!Array.isArray(cs.remoteNodes)) cs.remoteNodes = [];
  if (!Array.isArray(cs.timeline)) cs.timeline = [];
  if (!cs.takeover) cs.takeover = { status: "idle" };
  if (typeof cs.autoFollow !== "boolean") cs.autoFollow = true;
  if (typeof cs.nextSeq !== "number" || cs.nextSeq < 1) cs.nextSeq = cs.timeline.length + 1;
  return cs;
}

function inferToolTab(toolName: string): BotComputerViewTab | undefined {
  if (toolName.startsWith("browser_")) return "browser";
  if (toolName === "bash" || toolName === "powershell") return "terminal";
  if (
    toolName === "read" ||
    toolName === "write" ||
    toolName === "edit" ||
    toolName === "ls" ||
    toolName === "find" ||
    toolName === "grep"
  ) {
    return "files";
  }
  return undefined;
}

function summarizeToolCall(call: ToolCall): {
  title: string;
  subtitle?: string;
  urlOrApp?: string;
  pointerAction?: BotComputerPointerAction;
  x?: number;
  y?: number;
} {
  const args = call.args;
  switch (call.name) {
    case "browser_navigate": {
      const url = String(args.url ?? "");
      return { title: "打开网页", subtitle: url, urlOrApp: url, pointerAction: "move", x: 640, y: 360 };
    }
    case "browser_click": {
      const x = typeof args.x === "number" ? args.x : 640;
      const y = typeof args.y === "number" ? args.y : 420;
      const label = args.ref ? `元素 ${String(args.ref)}` : `(${Math.round(x)}, ${Math.round(y)})`;
      return { title: `点击 ${label}`, subtitle: label, pointerAction: "click", x, y };
    }
    case "browser_type": {
      const text = String(args.text ?? "");
      return { title: "输入文本", subtitle: text.slice(0, 48), pointerAction: "type" };
    }
    case "browser_press": {
      const key = String(args.key ?? "Enter");
      return { title: `按下按键 ${key}`, subtitle: key, pointerAction: "type" };
    }
    case "browser_scroll": {
      const dy = Number(args.deltaY ?? 0);
      return { title: dy >= 0 ? "向下滚动页面" : "向上滚动页面", subtitle: `ΔY=${dy}`, pointerAction: "scroll" };
    }
    case "browser_screenshot":
    case "browser_inspect":
      return { title: call.name === "browser_screenshot" ? "捕获浏览器画面" : "解析页面结构" };
    case "bash":
    case "powershell": {
      const cmd = String(args.command ?? "").trim();
      return { title: `执行命令`, subtitle: cmd.slice(0, 72) };
    }
    default: {
      const p = typeof args.path === "string" ? args.path : "";
      return { title: `文件操作 (${call.name})`, ...(p ? { subtitle: p, urlOrApp: p } : {}) };
    }
  }
}

export class TimelineAndTakeoverTracker {
  private lastPointer: BotComputerPointerTelemetry = {
    x: 640,
    y: 400,
    viewportWidth: 1280,
    viewportHeight: 800,
    action: "move",
    ts: Date.now(),
  };

  constructor(
    private readonly deps: {
      emitEvent: (ev: BotComputerEventNotification) => void;
      emitDesktopNotification: (notif: BotDesktopNotificationPayload) => void;
      onFrameCaptured: (frame: BotComputerStreamFrame) => void;
    },
  ) {}

  get currentPointer(): BotComputerPointerTelemetry {
    return this.lastPointer;
  }

  updatePointer(patch: Partial<BotComputerPointerTelemetry> & { action: BotComputerPointerAction }, engine: BotComputerEngineId, tab: BotComputerViewTab): BotComputerPointerTelemetry {
    this.lastPointer = {
      x: typeof patch.x === "number" ? Math.round(patch.x) : this.lastPointer.x,
      y: typeof patch.y === "number" ? Math.round(patch.y) : this.lastPointer.y,
      viewportWidth: patch.viewportWidth ?? 1280,
      viewportHeight: patch.viewportHeight ?? 800,
      action: patch.action,
      ...(patch.label ? { label: patch.label } : {}),
      ts: Date.now(),
    };
    this.deps.emitEvent({
      kind: "pointer",
      engine,
      tab,
      pointer: this.lastPointer,
    });
    return this.lastPointer;
  }

  appendStep(
    st: PersistedBotState,
    input: {
      engine?: BotComputerEngineId;
      tab: BotComputerViewTab;
      title: string;
      subtitle?: string;
      toolName?: string;
      urlOrApp?: string;
      thumbnailBase64?: string;
      terminalSnippet?: string;
      cursor?: BotComputerPointerTelemetry;
      status?: BotComputerTimelineStatus;
    },
  ): BotComputerTimelineStep {
    const cs = ensureComputerStudioState(st);
    const engine = input.engine ?? cs.activeEngine;
    const seq = cs.nextSeq++;
    const step: BotComputerTimelineStep = {
      id: `step-${seq}-${randomUUID().slice(0, 6)}`,
      seq,
      ts: Date.now(),
      engine,
      tab: input.tab,
      title: input.title,
      ...(input.subtitle ? { subtitle: input.subtitle } : {}),
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.urlOrApp ? { urlOrApp: input.urlOrApp } : {}),
      ...(input.thumbnailBase64 ? { thumbnailBase64: input.thumbnailBase64 } : {}),
      ...(input.terminalSnippet ? { terminalSnippet: input.terminalSnippet.slice(0, 600) } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      status: input.status ?? "completed",
    };

    cs.timeline.push(step);
    if (cs.timeline.length > MAX_TIMELINE_STEPS) {
      cs.timeline.splice(0, cs.timeline.length - MAX_TIMELINE_STEPS);
    }
    if (cs.autoFollow) {
      cs.activeTab = step.tab;
    }
    this.deps.emitEvent({ kind: "timeline", step });
    return step;
  }

  appendReplayedSteps(st: PersistedBotState, steps: readonly BotComputerTimelineStep[]): void {
    const cs = ensureComputerStudioState(st);
    for (const s of steps) {
      const assignedSeq = Math.max(cs.nextSeq, s.seq);
      cs.nextSeq = assignedSeq + 1;
      const normalized: BotComputerTimelineStep = { ...s, seq: assignedSeq };
      cs.timeline.push(normalized);
      this.deps.emitEvent({ kind: "timeline", step: normalized });
    }
    if (cs.timeline.length > MAX_TIMELINE_STEPS) {
      cs.timeline.splice(0, cs.timeline.length - MAX_TIMELINE_STEPS);
    }
  }

  recordToolCall(st: PersistedBotState, call: ToolCall, out: ToolOutput): BotComputerTimelineStep | undefined {
    const tab = inferToolTab(call.name);
    if (tab === undefined) return undefined;
    const cs = ensureComputerStudioState(st);
    const engine = cs.activeEngine;
    const summary = summarizeToolCall(call);

    let cursor: BotComputerPointerTelemetry | undefined;
    if (summary.pointerAction !== undefined) {
      cursor = this.updatePointer(
        {
          action: summary.pointerAction,
          ...(typeof summary.x === "number" ? { x: summary.x } : {}),
          ...(typeof summary.y === "number" ? { y: summary.y } : {}),
          ...(summary.subtitle ? { label: summary.subtitle } : {}),
        },
        engine,
        tab,
      );
    }

    const imageBlock = out.content.find(
      (b): b is { type: "image"; data: string; mimeType: string } => b.type === "image" && typeof b.data === "string",
    );
    const textJoined = out.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("\n")
      .trim();

    const details = (out.details ?? {}) as { url?: string; title?: string };
    if (imageBlock && (tab === "browser" || tab === "desktop")) {
      const frame: BotComputerStreamFrame = {
        engine,
        tab,
        mimeType: "image/png",
        dataBase64: imageBlock.data,
        width: 1280,
        height: 800,
        seq: cs.nextSeq,
        ts: Date.now(),
        ...(details.url ?? summary.urlOrApp ? { url: details.url ?? summary.urlOrApp } : {}),
        ...(details.title ?? summary.title ? { title: details.title ?? summary.title } : {}),
        ...(cursor ? { cursor } : {}),
      };
      this.deps.onFrameCaptured(frame);
    }

    return this.appendStep(st, {
      engine,
      tab,
      title: summary.title,
      subtitle: summary.subtitle,
      toolName: call.name,
      urlOrApp: details.url ?? summary.urlOrApp,
      ...(imageBlock ? { thumbnailBase64: imageBlock.data } : {}),
      ...(tab === "terminal" || tab === "files" ? { terminalSnippet: textJoined } : {}),
      ...(cursor ? { cursor } : {}),
      status: out.isError === true ? "error" : "completed",
    });
  }

  transitionTakeover(st: PersistedBotState, params: BotComputerTakeoverActionParams): BotComputerTakeoverState {
    const cs = ensureComputerStudioState(st);
    const now = Date.now();

    if (params.action === "request") {
      const targetEngine = params.engine ?? cs.activeEngine;
      const targetTab: BotComputerViewTab =
        params.tab ??
        (params.targetUrlOrApp && /^https?:\/\//i.test(params.targetUrlOrApp)
          ? "browser"
          : cs.activeTab === "terminal" || cs.activeTab === "files"
            ? "desktop"
            : cs.activeTab);
      const reason = params.reason?.trim() || "需要你完成登录、二次验证或安全确认后继续";

      cs.activeEngine = targetEngine;
      if (cs.autoFollow) cs.activeTab = targetTab;
      cs.takeover = {
        status: "requested",
        reason,
        ...(params.targetUrlOrApp ? { targetUrlOrApp: params.targetUrlOrApp } : {}),
        engine: targetEngine,
        tab: targetTab,
        requestedAt: now,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      };
      st.virtualServer.takeoverRequired = true;
      st.virtualServer.liveViewTaskTitle = reason;
      if (params.targetUrlOrApp) st.virtualServer.liveViewUrl = params.targetUrlOrApp;

      this.appendStep(st, {
        engine: targetEngine,
        tab: targetTab,
        title: "请求人工接管",
        subtitle: reason,
        urlOrApp: params.targetUrlOrApp,
        status: "takeover",
      });
      this.deps.emitEvent({ kind: "takeover", takeover: cs.takeover });
      this.deps.emitDesktopNotification({
        id: `takeover-${randomUUID().slice(0, 8)}`,
        title: "千机请求你接管虚拟电脑",
        body: params.targetUrlOrApp ? `${reason} (${params.targetUrlOrApp})` : reason,
        urgency: "urgent",
        createdAt: now,
      });
      return cs.takeover;
    }

    if (params.action === "start") {
      const prev = cs.takeover;
      const targetEngine = params.engine ?? prev.engine ?? cs.activeEngine;
      const targetTab = params.tab ?? prev.tab ?? cs.activeTab;
      cs.activeEngine = targetEngine;
      cs.activeTab = targetTab;
      cs.takeover = {
        status: "active",
        ...(params.reason ?? prev.reason ? { reason: params.reason ?? prev.reason } : {}),
        ...(params.targetUrlOrApp ?? prev.targetUrlOrApp ? { targetUrlOrApp: params.targetUrlOrApp ?? prev.targetUrlOrApp } : {}),
        engine: targetEngine,
        tab: targetTab,
        requestedAt: prev.requestedAt ?? now,
        ...(params.sessionId ?? prev.sessionId ? { sessionId: params.sessionId ?? prev.sessionId } : {}),
      };
      st.virtualServer.takeoverRequired = true;
      this.deps.emitEvent({ kind: "takeover", takeover: cs.takeover });
      return cs.takeover;
    }

    const prevEngine = cs.takeover.engine ?? cs.activeEngine;
    const prevTab = cs.takeover.tab ?? cs.activeTab;
    cs.takeover = { status: "idle" };
    st.virtualServer.takeoverRequired = false;
    this.appendStep(st, {
      engine: prevEngine,
      tab: prevTab,
      title: "人工接管已完成，交还千机继续执行",
      status: "completed",
    });
    this.deps.emitEvent({ kind: "takeover", takeover: cs.takeover });
    return cs.takeover;
  }
}
