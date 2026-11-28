/**
 * `remote-vm` (`ssh-vm`) & `remote-pc` (`companion-pc`) Node Manager
 * (`packages/host/src/bot/computer/remote-nodes-engine.ts`).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import type {
  BotComputerEngineId,
  BotComputerFilesListResult,
  BotComputerFilesReadResult,
  BotComputerPointerTelemetry,
  BotComputerRemoteNodeUpsertParams,
  BotComputerStreamFrame,
  BotComputerTimelineStep,
  BotRemoteComputerNode,
  BotVirtualServerStatus,
} from "@qianji/protocol";
import type { SshEndpointConfig, SshExecResult, SshRemoteRuntime } from "../ssh-runtime.ts";
import type { BotSecretVault } from "../store-proactive.ts";
import { MINIMAL_PNG_BASE64 } from "./local-linux-engine.ts";
import {
  enqueueOfflineLeaseEvent,
  listRemoteNodeFiles,
  readRemoteNodeFile,
  syncNodeAutonomyLease,
  type QueuedAutonomyEvent,
} from "./remote-lease.ts";
import { startVncWsProxy, type VncWsProxyHandle } from "./vnc-ws-proxy.ts";

export const DEFAULT_SSH_VM_NODE_ID = "default-ssh-vm";
const LEGACY_SSH_SECRET_ID = "bot/remote-ssh-password";

export function nodeSecretKey(nodeId: string): string {
  return nodeId === DEFAULT_SSH_VM_NODE_ID ? LEGACY_SSH_SECRET_ID : `bot/remote-node-password/${nodeId}`;
}

export function nodeToSshEndpoint(node: BotRemoteComputerNode): SshEndpointConfig {
  return {
    host: node.host,
    port: node.port || 22,
    username: node.username?.trim() || "ubuntu",
    workDir: node.workDir?.trim() || "~/.qianji-vm",
    ...(node.authMethod ? { authMethod: node.authMethod } : {}),
    ...(node.privateKeyPath ? { privateKeyPath: node.privateKeyPath } : {}),
  };
}

function allocateFreeLocalPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo | string | null;
      const port = addr !== null && typeof addr === "object" ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error("Failed to allocate local tunnel port"))));
    });
  });
}

export class RemoteNodesEngine {
  private readonly offlineRings = new Map<string, QueuedAutonomyEvent[]>();
  private readonly vncBridges = new Map<string, { proxy: VncWsProxyHandle; tunnelChild?: ChildProcess }>();

  constructor(
    private readonly deps: {
      ssh: SshRemoteRuntime;
      vault: BotSecretVault;
      getSoul: () => string;
      getMemory: () => string;
    },
  ) {}

  private async closeNodeVncBridge(nodeId: string): Promise<void> {
    const existing = this.vncBridges.get(nodeId);
    if (!existing) return;
    this.vncBridges.delete(nodeId);
    if (existing.tunnelChild) {
      try { existing.tunnelChild.kill(); } catch { /* ignore */ }
    }
    await existing.proxy.close();
  }

  async attachLocalTunnelVncProxy(node: BotRemoteComputerNode, localTunnelPort: number): Promise<string> {
    const existing = this.vncBridges.get(node.id);
    if (existing) {
      existing.proxy.updateTarget("127.0.0.1", localTunnelPort);
      node.vncWsUrl = existing.proxy.wsUrl;
      return existing.proxy.wsUrl;
    }
    const proxy = await startVncWsProxy({ targetHost: "127.0.0.1", targetPort: localTunnelPort });
    this.vncBridges.set(node.id, { proxy });
    node.vncWsUrl = proxy.wsUrl;
    return proxy.wsUrl;
  }

  async syncLegacyRemoteWithNodes(
    vs: BotVirtualServerStatus,
    nodes: BotRemoteComputerNode[],
  ): Promise<BotRemoteComputerNode[]> {
    const next = [...nodes];
    const legacy = vs.remote;
    const hasLegacyHost = legacy.host.trim() !== "";
    const existingIdx = next.findIndex((n) => n.id === DEFAULT_SSH_VM_NODE_ID);
    const hasSecret = await this.deps.vault.has(LEGACY_SSH_SECRET_ID);

    if (existingIdx >= 0) {
      const cur = next[existingIdx];
      if (cur !== undefined) {
        if (hasLegacyHost) {
          cur.host = legacy.host;
          cur.port = legacy.port || 22;
          cur.username = legacy.username || "ubuntu";
          cur.workDir = legacy.workDir || "~/.qianji-vm";
          cur.authMethod = legacy.authMethod ?? "agent-or-key";
          cur.privateKeyPath = legacy.privateKeyPath ?? "";
          cur.hasStoredSecret = hasSecret;
          if (legacy.osSummary) cur.osSummary = legacy.osSummary;
          if (legacy.initialized) cur.connected = true;
        } else if (cur.host.trim() !== "") {
          this.copyNodeToLegacyRemote(cur, vs);
        }
      }
    } else if (hasLegacyHost) {
      next.unshift({
        id: DEFAULT_SSH_VM_NODE_ID,
        alias: legacy.alias || "远端常驻虚拟服务器",
        kind: "ssh-vm",
        host: legacy.host,
        port: legacy.port || 22,
        username: legacy.username || "ubuntu",
        workDir: legacy.workDir || "~/.qianji-vm",
        authMethod: legacy.authMethod ?? "agent-or-key",
        privateKeyPath: legacy.privateKeyPath ?? "",
        hasStoredSecret: hasSecret,
        ...(legacy.osSummary ? { osSummary: legacy.osSummary } : {}),
        connected: legacy.initialized,
        ...(typeof vs.latencyMs === "number" ? { latencyMs: vs.latencyMs } : {}),
        autonomyLease: {
          active: legacy.initialized,
          lastSeq: 0,
          queuedOfflineEvents: 0,
          ...(legacy.offlineSyncedAt ? { updatedAt: legacy.offlineSyncedAt } : {}),
        },
      });
    }

    for (const node of next) {
      const ring = this.offlineRings.get(node.id);
      if (ring !== undefined) node.autonomyLease.queuedOfflineEvents = ring.length;
      const bridge = this.vncBridges.get(node.id);
      if (bridge !== undefined) node.vncWsUrl = bridge.proxy.wsUrl;
      if (node.id !== DEFAULT_SSH_VM_NODE_ID) {
        node.hasStoredSecret = await this.deps.vault.has(nodeSecretKey(node.id));
      }
    }
    return next;
  }

  copyNodeToLegacyRemote(node: BotRemoteComputerNode, vs: BotVirtualServerStatus): void {
    if (node.kind !== "ssh-vm") return;
    vs.remote.alias = node.alias;
    vs.remote.host = node.host;
    vs.remote.port = node.port || 22;
    vs.remote.username = node.username?.trim() || "ubuntu";
    vs.remote.workDir = node.workDir?.trim() || "~/.qianji-vm";
    vs.remote.authMethod = node.authMethod ?? "agent-or-key";
    vs.remote.privateKeyPath = node.privateKeyPath ?? "";
    vs.remote.hasStoredSecret = Boolean(node.hasStoredSecret);
    vs.remote.initialized = node.connected;
    if (node.osSummary) vs.remote.osSummary = node.osSummary;
  }

  resolveNodeForEngine(
    engine: BotComputerEngineId,
    nodes: readonly BotRemoteComputerNode[],
    activeRemoteNodeId?: string,
  ): BotRemoteComputerNode | undefined {
    const wantedKind = engine === "remote-pc" ? "companion-pc" : "ssh-vm";
    if (activeRemoteNodeId) {
      const exact = nodes.find((n) => n.id === activeRemoteNodeId && n.kind === wantedKind);
      if (exact) return exact;
    }
    return nodes.find((n) => n.kind === wantedKind) ?? nodes[0];
  }

  async getNodePassword(node: BotRemoteComputerNode): Promise<string | undefined> {
    const direct = await this.deps.vault.get(nodeSecretKey(node.id));
    return direct !== undefined ? direct : this.deps.vault.get(LEGACY_SSH_SECRET_ID);
  }

  async upsertNode(
    params: BotComputerRemoteNodeUpsertParams,
    nodes: BotRemoteComputerNode[],
    vs: BotVirtualServerStatus,
  ): Promise<BotRemoteComputerNode> {
    const id =
      params.id?.trim() ||
      (params.kind === "ssh-vm" && !nodes.some((n) => n.id === DEFAULT_SSH_VM_NODE_ID)
        ? DEFAULT_SSH_VM_NODE_ID
        : `node-${randomUUID().slice(0, 8)}`);

    if (typeof params.password === "string") {
      await this.deps.vault.set(nodeSecretKey(id), params.password);
    }
    const hasSecret = await this.deps.vault.has(nodeSecretKey(id));
    const existing = nodes.find((n) => n.id === id);
    const updated: BotRemoteComputerNode = {
      id,
      alias: params.alias.trim() || (params.kind === "companion-pc" ? "闲置个人电脑节点" : "远端 Linux 虚拟机"),
      kind: params.kind,
      host: params.host.trim(),
      port: Math.max(1, params.port ?? existing?.port ?? 22),
      username: params.username?.trim() || existing?.username || (params.kind === "companion-pc" ? "user" : "ubuntu"),
      workDir: params.workDir?.trim() || existing?.workDir || "~/.qianji-vm",
      authMethod: params.authMethod ?? existing?.authMethod ?? "agent-or-key",
      privateKeyPath: params.privateKeyPath?.trim() ?? existing?.privateKeyPath ?? "",
      hasStoredSecret: hasSecret,
      ...(existing?.osSummary ? { osSummary: existing.osSummary } : {}),
      connected: existing?.connected ?? false,
      ...(typeof existing?.latencyMs === "number" ? { latencyMs: existing.latencyMs } : {}),
      ...(existing?.vncWsUrl ? { vncWsUrl: existing.vncWsUrl } : {}),
      autonomyLease: existing?.autonomyLease ?? { active: true, lastSeq: 0, queuedOfflineEvents: 0, updatedAt: Date.now() },
    };

    const idx = nodes.findIndex((n) => n.id === id);
    if (idx >= 0) nodes[idx] = updated;
    else nodes.push(updated);
    if (updated.id === DEFAULT_SSH_VM_NODE_ID || (updated.kind === "ssh-vm" && vs.remote.host.trim() === "")) {
      this.copyNodeToLegacyRemote(updated, vs);
    }
    return updated;
  }

  async deleteNode(id: string, nodes: BotRemoteComputerNode[], vs: BotVirtualServerStatus): Promise<void> {
    await this.closeNodeVncBridge(id);
    const idx = nodes.findIndex((n) => n.id === id);
    if (idx >= 0) nodes.splice(idx, 1);
    this.offlineRings.delete(id);
    if (id === DEFAULT_SSH_VM_NODE_ID) {
      vs.remote.host = "";
      vs.remote.initialized = false;
    } else {
      await this.deps.vault.set(nodeSecretKey(id), undefined);
    }
  }

  async connectNode(node: BotRemoteComputerNode, vs: BotVirtualServerStatus): Promise<{ ok: boolean; message: string }> {
    const password = await this.getNodePassword(node);
    const ep = nodeToSshEndpoint(node);
    const initRes = await this.deps.ssh.initEnvironment(ep, this.deps.getSoul(), this.deps.getMemory(), password);
    if (!initRes.ok) {
      node.connected = false;
      node.lastError = initRes.message;
      if (node.id === DEFAULT_SSH_VM_NODE_ID) vs.remote.initialized = false;
      return { ok: false, message: initRes.message };
    }
    node.connected = true;
    node.latencyMs = initRes.latencyMs;
    node.osSummary = initRes.osSummary;
    node.lastError = undefined;
    node.autonomyLease.active = true;
    node.autonomyLease.updatedAt = Date.now();
    if (node.kind === "ssh-vm") {
      this.copyNodeToLegacyRemote(node, vs);
      vs.latencyMs = initRes.latencyMs;
    }
    await this.tryEstablishSshVncTunnel(node, ep, password).catch(() => undefined);
    return { ok: true, message: initRes.message };
  }

  private async tryEstablishSshVncTunnel(
    node: BotRemoteComputerNode,
    ep: SshEndpointConfig,
    password: string | undefined,
  ): Promise<void> {
    const vncProbe = await this.deps.ssh.exec(
      ep,
      "if ss -tln 2>/dev/null | grep -q ':5900 ' || netstat -tln 2>/dev/null | grep -q ':5900 '; then echo VNC=5900; fi",
      { cwd: "~", password, timeoutMs: 5_000 },
    );
    if (!vncProbe.stdout.includes("VNC=5900")) return;
    await this.closeNodeVncBridge(node.id);
    const localPort = await allocateFreeLocalPort();
    const args = [
      "-N", "-L", `127.0.0.1:${localPort}:127.0.0.1:5900`,
      "-p", String(ep.port),
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=15",
      ...(ep.authMethod !== "password" ? ["-o", "BatchMode=yes"] : []),
      ...(ep.privateKeyPath?.trim() ? ["-i", ep.privateKeyPath.trim()] : []),
      `${ep.username}@${ep.host}`,
    ];
    const tunnelChild = spawn("ssh", args, { windowsHide: true, stdio: "ignore" });
    tunnelChild.unref();
    const proxy = await startVncWsProxy({ targetHost: "127.0.0.1", targetPort: localPort });
    this.vncBridges.set(node.id, { proxy, tunnelChild });
    node.vncWsUrl = proxy.wsUrl;
  }

  disconnectNode(node: BotRemoteComputerNode, vs: BotVirtualServerStatus): { ok: boolean; message: string } {
    node.connected = false;
    node.vncWsUrl = undefined;
    void this.closeNodeVncBridge(node.id);
    node.autonomyLease.active = true;
    node.autonomyLease.updatedAt = Date.now();
    if (node.id === DEFAULT_SSH_VM_NODE_ID) {
      vs.remote.initialized = false;
      if (vs.mode === "remote") vs.lifecycle = "sleeping";
    }
    return { ok: true, message: `已断开实时视图连接；节点「${node.alias}」自治租约保持激活，离线产出将写入环形缓冲待重连回放` };
  }

  enqueueOfflineEvent(
    node: BotRemoteComputerNode,
    input: { title: string; subtitle?: string; toolName?: string; terminalSnippet?: string },
  ): QueuedAutonomyEvent {
    return enqueueOfflineLeaseEvent(this.offlineRings, node, input);
  }

  async syncAutonomyLease(
    node: BotRemoteComputerNode,
    engine: BotComputerEngineId,
    vs: BotVirtualServerStatus,
  ): Promise<{ ok: boolean; message: string; replayedSteps: BotComputerTimelineStep[] }> {
    return syncNodeAutonomyLease({
      offlineRings: this.offlineRings,
      ssh: this.deps.ssh,
      endpoint: nodeToSshEndpoint(node),
      password: await this.getNodePassword(node),
      node,
      engine,
      vs,
    });
  }

  async execOnNode(node: BotRemoteComputerNode, command: string, cwd?: string, timeoutMs = 30_000): Promise<SshExecResult> {
    if (!node.connected && node.autonomyLease.active) {
      this.enqueueOfflineEvent(node, {
        title: `离线自治排队命令：${command.slice(0, 48)}`,
        toolName: "bash",
        terminalSnippet: `$ ${command}`,
      });
    }
    const password = await this.getNodePassword(node);
    const res = await this.deps.ssh.exec(nodeToSshEndpoint(node), command, { cwd, password, timeoutMs });
    if (res.exitCode === 0) {
      node.autonomyLease.lastSeq += 1;
      node.autonomyLease.updatedAt = Date.now();
    }
    return res;
  }

  listFiles(engine: BotComputerEngineId, node: BotRemoteComputerNode | undefined, rawPath?: string): Promise<BotComputerFilesListResult> {
    return listRemoteNodeFiles(engine, node, rawPath, (cmd) =>
      node ? this.execOnNode(node, cmd, "~", 15_000) : Promise.resolve({ stdout: "", stderr: "Unconfigured", exitCode: 1, durationMs: 0 }),
    );
  }

  readFile(node: BotRemoteComputerNode | undefined, rawPath: string, maxBytes?: number): Promise<BotComputerFilesReadResult> {
    return readRemoteNodeFile(node, rawPath, maxBytes, (cmd) =>
      node ? this.execOnNode(node, cmd, "~", 20_000) : Promise.resolve({ stdout: "", stderr: "Unconfigured", exitCode: 1, durationMs: 0 }),
    );
  }

  captureFrame(engine: BotComputerEngineId, node: BotRemoteComputerNode | undefined, seq: number, cursor?: BotComputerPointerTelemetry): BotComputerStreamFrame {
    return {
      engine,
      tab: "desktop",
      mimeType: "image/png",
      dataBase64: MINIMAL_PNG_BASE64,
      width: 1280,
      height: 800,
      seq,
      ts: Date.now(),
      title: node ? `${node.alias} (${node.host || "待配置"})` : engine === "remote-pc" ? "远程个人电脑节点" : "远程 Linux 虚拟机",
      ...(cursor ? { cursor } : {}),
    };
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.vncBridges.keys()].map((id) => this.closeNodeVncBridge(id)));
  }
}
