/**
 * Real host process & active focus/meeting sensor for Qianji Bot Mode
 * (`packages/host/src/bot/connectors/process-sensor.ts`).
 */
import { spawn } from "node:child_process";
import type { BotBusyState, BotProcessSensorConfig } from "@qianji/protocol";

export interface ProcessEntry {
  pid: number;
  name: string;
  title: string;
}

export type ProcessProbeFn = () => Promise<ProcessEntry[]>;

export interface ProcessSampleResult {
  busyState: BotBusyState;
  activeWindowTitle?: string;
  runningWatched: string[];
  completedProcesses: string[];
}

const MEETING_PROCESS_RE = /\b(?:zoom|teams|ms-teams|wemeetapp|webex|slack|discord|skype)\b|腾讯会议|飞书会议/i;
const MEETING_TITLE_RE = /(?:meeting|zoom meeting|腾讯会议|飞书会议|视频会议|语音通话|huddle|in call)/i;
const FOCUS_PROCESS_RE = /\b(?:code|cursor|devenv|idea64|webstorm64|pycharm64|rustrover64|powerpnt)\b/i;

function runCapture(cmd: string, args: readonly string[], timeoutMs = 4500): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve("");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 256 * 1024) stdout += chunk.toString("utf8");
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(stdout);
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve("");
    });
  });
}

export async function defaultOsProcessProbe(): Promise<ProcessEntry[]> {
  if (process.platform === "win32") {
    const psCmd =
      "Get-Process | Where-Object { $_.ProcessName -ne '' } | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress";
    const out = await runCapture("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(psCmd, "utf16le").toString("base64"),
    ]);
    if (!out.trim()) return [];
    try {
      const parsed = JSON.parse(out) as unknown;
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return arr
        .map((item) => {
          const rec = item as { Id?: unknown; ProcessName?: unknown; MainWindowTitle?: unknown };
          return {
            pid: Number(rec.Id ?? 0),
            name: String(rec.ProcessName ?? ""),
            title: String(rec.MainWindowTitle ?? ""),
          };
        })
        .filter((e) => e.name !== "");
    } catch {
      return [];
    }
  }

  const out = await runCapture("ps", ["-eo", "pid=,comm="]);
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const sp = line.search(/\s+/);
      if (sp <= 0) return null;
      return { pid: Number(line.slice(0, sp)), name: line.slice(sp).trim(), title: "" };
    })
    .filter((item): item is ProcessEntry => item !== null && Number.isFinite(item.pid));
}

export class ProcessSensor {
  private prevWatchedRunning = new Set<string>();
  private readonly probeFn: ProcessProbeFn;

  constructor(probeFn?: ProcessProbeFn) {
    this.probeFn = probeFn ?? defaultOsProcessProbe;
  }

  async sample(config: BotProcessSensorConfig, nowMs = Date.now()): Promise<ProcessSampleResult> {
    if (!config.enabled) {
      return { busyState: "normal", runningWatched: [], completedProcesses: [] };
    }
    const entries = await this.probeFn().catch(() => []);

    let activeWindowTitle: string | undefined;
    let inMeeting = false;
    let deepFocus = false;

    for (const p of entries) {
      const hasTitle = p.title.trim() !== "";
      if (hasTitle && activeWindowTitle === undefined) activeWindowTitle = p.title.trim();
      if ((MEETING_PROCESS_RE.test(p.name) && hasTitle) || MEETING_TITLE_RE.test(p.title)) {
        inMeeting = true;
        if (hasTitle) activeWindowTitle = p.title.trim();
      }
      if (hasTitle && FOCUS_PROCESS_RE.test(p.name)) {
        deepFocus = true;
      }
    }

    const hour = new Date(nowMs).getHours();
    const isLateNight = config.lateNightCareEnabled && (hour >= 23 || hour < 5);

    const runningWatchedSet = new Set<string>();
    for (const target of config.watchedProcesses) {
      const clean = target.trim();
      if (clean === "") continue;
      const needle = clean.toLowerCase();
      if (entries.some((p) => p.name.toLowerCase().includes(needle) || p.title.toLowerCase().includes(needle))) {
        runningWatchedSet.add(clean);
      }
    }

    const completedProcesses: string[] = [];
    for (const prev of this.prevWatchedRunning) {
      if (!runningWatchedSet.has(prev) && config.watchedProcesses.includes(prev)) {
        completedProcesses.push(prev);
      }
    }
    this.prevWatchedRunning = runningWatchedSet;

    const busyState: BotBusyState = inMeeting
      ? "in-meeting"
      : isLateNight
        ? "late-night"
        : deepFocus
          ? "deep-focus"
          : "normal";

    return {
      busyState,
      ...(activeWindowTitle === undefined ? {} : { activeWindowTitle }),
      runningWatched: [...runningWatchedSet],
      completedProcesses,
    };
  }
}