/**
 * Real filesystem scanner for `<dataDir>/bot-workspace` & `<dataDir>/memory.md`.
 * Surfaces genuine documents, media files, and learned preferences in Bot Mode.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import type { BrowserSession } from "@qianji/browser";
import type { BotDocumentItem, BotMediaItem, BotServerMode } from "@qianji/protocol";
import type { PluginManager } from "../plugin-manager.ts";
import type { ComputerHelperInvoke } from "./computer/win-pip-engine.ts";
import type { ProcessProbeFn } from "./connectors/process-sensor.ts";
import {
  DEFAULT_SOUL_MARKDOWN,
  formatShortDate,
  MAX_SOUL_BYTES,
  normalizeAvatarPreset,
  type PersistedBotState,
} from "./defaults.ts";

export interface BotStoreConfig {
  dataDir: string;
  workspaceDir?: string;
  storageDir?: string;
  defaultModel?: () => { provider: string; model: string } | undefined;
  distroName?: string;
  wslSupported?: boolean;
  computerHelperPath?: string;
  computerHelperInvoker?: ComputerHelperInvoke;
  browserFactory?: (opts: { workspace: string; profileDir: string }) => BrowserSession;
  displayName?: string;
  avatarPreset?: string;
  serverMode?: BotServerMode;
  localCpuCores?: number;
  localMemoryGb?: number;
  localDiskGb?: number;
  autoSleepIdle?: boolean;
  remoteHost?: string;
  remotePort?: number;
  remoteUser?: string;
  remoteWorkDir?: string;
  processProbe?: ProcessProbeFn;
  pluginManager?: () => PluginManager | undefined;
}

export function writeFileAtomic(file: string, content: string, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, content, mode === undefined ? "utf8" : { encoding: "utf8", mode });
  renameSync(temp, file);
}

export function applyBotConfigOverlay(target: PersistedBotState, config: BotStoreConfig): void {
  if (config.displayName && config.displayName.trim() !== "") {
    target.profile.displayName = config.displayName.trim();
  }
  if (config.avatarPreset) {
    target.profile.avatarPreset = normalizeAvatarPreset(config.avatarPreset);
  }
  if (config.serverMode === "local" || config.serverMode === "remote") {
    target.virtualServer.mode = config.serverMode;
  }
  if (typeof config.localCpuCores === "number") target.virtualServer.local.cpuCores = config.localCpuCores;
  if (typeof config.localMemoryGb === "number") target.virtualServer.local.memoryLimitGb = config.localMemoryGb;
  if (typeof config.localDiskGb === "number") target.virtualServer.local.diskLimitGb = config.localDiskGb;
  if (typeof config.autoSleepIdle === "boolean") target.virtualServer.local.autoSleepIdle = config.autoSleepIdle;
  if (typeof config.remoteHost === "string" && config.remoteHost !== "") target.virtualServer.remote.host = config.remoteHost;
  if (typeof config.remotePort === "number") target.virtualServer.remote.port = config.remotePort;
  if (typeof config.remoteUser === "string" && config.remoteUser !== "") target.virtualServer.remote.username = config.remoteUser;
  if (typeof config.remoteWorkDir === "string" && config.remoteWorkDir !== "") target.virtualServer.remote.workDir = config.remoteWorkDir;
  if (typeof config.workspaceDir === "string" && config.workspaceDir.trim() !== "") {
    target.customWorkspaceDir = config.workspaceDir.trim();
  }
  if (typeof config.storageDir === "string" && config.storageDir.trim() !== "") {
    target.virtualServer.local.customStorageDir = config.storageDir.trim();
  }
}

export function executeApprovedShellCommand(command: string, cwd: string): Promise<{ code: number | null }> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const child = spawn(
      isWin ? "powershell.exe" : "sh",
      isWin ? ["-NoProfile", "-Command", command] : ["-c", command],
      { cwd, stdio: "ignore", windowsHide: true },
    );
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null });
    }, 15_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null });
    });
  });
}

const DOC_EXTS = new Set([".md", ".txt", ".json", ".csv", ".html", ".yaml", ".yml", ".log"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".mkv"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".ogg", ".flac"]);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function scanBotWorkspaceArtifacts(rootDir: string): {
  documents: BotDocumentItem[];
  media: BotMediaItem[];
} {
  const documents: BotDocumentItem[] = [];
  const media: BotMediaItem[] = [];
  if (!existsSync(rootDir)) return { documents, media };

  const walk = (dir: string, depth: number) => {
    if (depth > 3 || documents.length + media.length >= 80) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules" || entry.name === "tmp" || entry.name === "cache") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      const rel = relative(rootDir, full).replace(/\\/g, "/");
      const updatedLabel = formatShortDate(st.mtimeMs);

      if (DOC_EXTS.has(ext)) {
        let preview = "";
        if (st.size <= 64 * 1024) {
          try {
            preview = readFileSync(full, "utf8").slice(0, 4000);
          } catch {
            preview = "";
          }
        }
        documents.push({
          id: `doc:${rel}`,
          name: rel,
          updatedLabel,
          sizeLabel: formatBytes(st.size),
          content: preview,
          path: full,
          updatedAt: st.mtimeMs,
        });
      } else if (IMAGE_EXTS.has(ext)) {
        media.push({ id: `img:${rel}`, kind: "images", title: rel, updatedLabel, urlOrPath: full });
      } else if (VIDEO_EXTS.has(ext)) {
        media.push({ id: `vid:${rel}`, kind: "videos", title: rel, updatedLabel, urlOrPath: full });
      } else if (AUDIO_EXTS.has(ext)) {
        media.push({ id: `aud:${rel}`, kind: "podcasts", title: rel, updatedLabel, urlOrPath: full });
      }
    }
  };

  walk(rootDir, 0);
  documents.sort((a, b) => b.updatedAt - a.updatedAt);
  return { documents, media };
}

export function extractLearnedPreferencesFromMemory(memoryFile: string): string[] {
  if (!existsSync(memoryFile)) return [];
  try {
    const raw = readFileSync(memoryFile, "utf8");
    const bullets: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ") || trimmed.startsWith("* ") || trimmed.startsWith("• ")) {
        const clean = trimmed.slice(2).trim();
        if (clean.length > 0) bullets.push(clean);
      }
      if (bullets.length >= 8) break;
    }
    return bullets;
  } catch {
    return [];
  }
}

export function readBotSoulFile(soulFile: string): string {
  if (!existsSync(soulFile)) {
    writeFileAtomic(soulFile, DEFAULT_SOUL_MARKDOWN, 0o600);
    return DEFAULT_SOUL_MARKDOWN;
  }
  try {
    return readFileSync(soulFile, "utf8");
  } catch {
    return DEFAULT_SOUL_MARKDOWN;
  }
}

export function readBotMemoryFile(memoryFile: string): string {
  try {
    return existsSync(memoryFile) ? readFileSync(memoryFile, "utf8") : "# MEMORY.md\n";
  } catch {
    return "# MEMORY.md\n";
  }
}

export function writeBotSoulFile(soulFile: string, content: string): { content: string; updatedAt: string } {
  if (Buffer.byteLength(content, "utf8") > MAX_SOUL_BYTES) {
    throw new Error("SOUL.md cannot exceed 128 KB");
  }
  writeFileAtomic(soulFile, content, 0o600);
  return { content, updatedAt: formatShortDate(Date.now()) };
}

export function readFileMtimeShortDate(file: string): string {
  try {
    return formatShortDate(statSync(file).mtimeMs);
  } catch {
    return formatShortDate(Date.now());
  }
}
