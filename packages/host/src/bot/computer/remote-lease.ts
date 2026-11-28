/**
 * Remote Autonomy Lease Ring-Buffer & Remote File Operations (`packages/host/src/bot/computer/remote-lease.ts`).
 */
import { posix } from "node:path";
import type {
  BotComputerEngineId,
  BotComputerFileEntry,
  BotComputerFilesListResult,
  BotComputerFilesReadResult,
  BotComputerTimelineStep,
  BotRemoteComputerNode,
  BotVirtualServerStatus,
} from "@qianji/protocol";
import type { SshEndpointConfig, SshExecResult, SshRemoteRuntime } from "../ssh-runtime.ts";

export const MAX_LEASE_RING_BUFFER = 64;

export interface QueuedAutonomyEvent {
  seq: number;
  ts: number;
  title: string;
  subtitle?: string;
  toolName?: string;
  terminalSnippet?: string;
}

export function enqueueOfflineLeaseEvent(
  offlineRings: Map<string, QueuedAutonomyEvent[]>,
  node: BotRemoteComputerNode,
  input: { title: string; subtitle?: string; toolName?: string; terminalSnippet?: string },
): QueuedAutonomyEvent {
  node.autonomyLease.lastSeq += 1;
  const ev: QueuedAutonomyEvent = {
    seq: node.autonomyLease.lastSeq,
    ts: Date.now(),
    title: input.title,
    ...(input.subtitle ? { subtitle: input.subtitle } : {}),
    ...(input.toolName ? { toolName: input.toolName } : {}),
    ...(input.terminalSnippet ? { terminalSnippet: input.terminalSnippet } : {}),
  };
  let ring = offlineRings.get(node.id);
  if (!ring) {
    ring = [];
    offlineRings.set(node.id, ring);
  }
  ring.push(ev);
  if (ring.length > MAX_LEASE_RING_BUFFER) {
    ring.splice(0, ring.length - MAX_LEASE_RING_BUFFER);
  }
  node.autonomyLease.queuedOfflineEvents = ring.length;
  node.autonomyLease.updatedAt = ev.ts;
  return ev;
}

export async function syncNodeAutonomyLease(params: {
  offlineRings: Map<string, QueuedAutonomyEvent[]>;
  ssh: SshRemoteRuntime;
  endpoint: SshEndpointConfig;
  password: string | undefined;
  node: BotRemoteComputerNode;
  engine: BotComputerEngineId;
  vs: BotVirtualServerStatus;
}): Promise<{ ok: boolean; message: string; replayedSteps: BotComputerTimelineStep[] }> {
  const { offlineRings, ssh, endpoint, password, node, engine, vs } = params;
  if (node.connected && node.host.trim() !== "") {
    const baseDir = node.workDir?.trim() || "~/.qianji-vm";
    const drainRes = await ssh
      .exec(
        endpoint,
        `if [ -f ${baseDir}/autonomy-lease.jsonl ]; then cat ${baseDir}/autonomy-lease.jsonl; rm -f ${baseDir}/autonomy-lease.jsonl; fi`,
        { cwd: "~", password, timeoutMs: 10_000 },
      )
      .catch(() => null);
    if (drainRes && drainRes.exitCode === 0 && drainRes.stdout.trim() !== "") {
      for (const line of drainRes.stdout.trim().split(/\r?\n/)) {
        try {
          const parsed = JSON.parse(line) as { title?: string; subtitle?: string; snippet?: string };
          if (parsed.title) {
            enqueueOfflineLeaseEvent(offlineRings, node, {
              title: parsed.title,
              subtitle: parsed.subtitle,
              terminalSnippet: parsed.snippet,
            });
          }
        } catch {
          // Ignore malformed spool line
        }
      }
    }
  }

  const ring = offlineRings.get(node.id) ?? [];
  const drained = ring.splice(0);
  offlineRings.set(node.id, []);
  const replayedSteps: BotComputerTimelineStep[] = drained.map((ev) => ({
    id: `lease-${node.id}-${ev.seq}`,
    seq: ev.seq,
    ts: ev.ts,
    engine,
    tab: "terminal",
    title: ev.title,
    ...(ev.subtitle ? { subtitle: ev.subtitle } : {}),
    ...(ev.toolName ? { toolName: ev.toolName } : {}),
    ...(ev.terminalSnippet ? { terminalSnippet: ev.terminalSnippet } : {}),
    status: "completed",
  }));

  node.autonomyLease.active = true;
  node.autonomyLease.queuedOfflineEvents = 0;
  node.autonomyLease.updatedAt = Date.now();
  const highest = replayedSteps[replayedSteps.length - 1];
  if (highest && highest.seq > node.autonomyLease.lastSeq) {
    node.autonomyLease.lastSeq = highest.seq;
  } else if (replayedSteps.length === 0) {
    node.autonomyLease.lastSeq += 1;
  }
  if (node.kind === "ssh-vm") {
    vs.remote.offlineSyncedAt = node.autonomyLease.updatedAt;
  }
  return {
    ok: true,
    message: `已完成自治租约同步（回放 ${replayedSteps.length} 条离线事件 · seq=${node.autonomyLease.lastSeq}）`,
    replayedSteps,
  };
}

export async function listRemoteNodeFiles(
  engine: BotComputerEngineId,
  node: BotRemoteComputerNode | undefined,
  rawPath: string | undefined,
  execFn: (command: string) => Promise<SshExecResult>,
): Promise<BotComputerFilesListResult> {
  const defaultRoot = `${node?.workDir?.trim() || "~/.qianji-vm"}/workspace`;
  const target = rawPath?.trim() ? rawPath.trim() : defaultRoot;
  if (!node || node.host.trim() === "") {
    return { engine, cwd: target, entries: [] };
  }
  const script = [
    `DIR=${JSON.stringify(target)}; eval DIR=$DIR`,
    `mkdir -p "$DIR" 2>/dev/null || true`,
    `cd "$DIR" || exit 2`,
    `pwd`,
    `for f in * .[!.]*; do [ -e "$f" ] || continue; if [ -d "$f" ]; then printf 'D\\t0\\t%s\\n' "$f"; else sz=$(wc -c < "$f" 2>/dev/null || echo 0); printf 'F\\t%s\\t%s\\n' "$sz" "$f"; fi; done`,
  ].join("; ");
  const res = await execFn(script);
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || `Cannot list remote directory: ${target}`);
  }
  const lines = res.stdout.replace(/\r/g, "").split("\n").filter(Boolean);
  const resolvedCwd = lines[0]?.trim() || target;
  const entries: BotComputerFileEntry[] = lines.slice(1).flatMap((ln) => {
    const [kind, szRaw, name] = ln.split("\t");
    if (!name || name === "." || name === "..") return [];
    return [{
      name,
      path: posix.join(resolvedCwd, name),
      isDir: kind === "D",
      sizeBytes: Math.max(0, Number.parseInt(szRaw ?? "0", 10) || 0),
      updatedAt: Date.now(),
    }];
  });
  entries.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
  return { engine, cwd: resolvedCwd, entries };
}

export async function readRemoteNodeFile(
  node: BotRemoteComputerNode | undefined,
  rawPath: string,
  maxBytes: number | undefined,
  execFn: (command: string) => Promise<SshExecResult>,
): Promise<BotComputerFilesReadResult> {
  if (!node || node.host.trim() === "") {
    throw new Error("Remote node is not configured");
  }
  const cap = Math.min(2 * 1024 * 1024, Math.max(256, maxBytes ?? 256 * 1024));
  const script = `FILE=${JSON.stringify(rawPath)}; eval FILE=$FILE; [ -f "$FILE" ] || exit 2; head -c ${cap} "$FILE" | (base64 -w 0 2>/dev/null || base64 | tr -d '\\r\\n')`;
  const res = await execFn(script);
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || `Remote file not found: ${rawPath}`);
  }
  const buf = Buffer.from(res.stdout.trim(), "base64");
  const isBinary = buf.includes(0) || /\.(?:png|jpe?g|gif|webp)$/i.test(rawPath);
  if (isBinary) {
    return { path: rawPath, dataBase64: buf.toString("base64"), sizeBytes: buf.byteLength, isBinary: true };
  }
  return { path: rawPath, content: buf.toString("utf8"), mimeType: "text/plain", sizeBytes: buf.byteLength, isBinary: false };
}
