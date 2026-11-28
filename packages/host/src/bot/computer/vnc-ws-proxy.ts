/**
 * Built-in RFB VNC WebSocket-to-TCP Proxy (`packages/host/src/bot/computer/vnc-ws-proxy.ts`).
 *
 * Bridges `@novnc/novnc` binary WebSocket frames (`ws://127.0.0.1:<wsPort>/vnc/<token>`)
 * directly to a standard RFB TCP endpoint (`127.0.0.1:5900` in WSL2 or a local SSH tunnel
 * port for `remote-vm`), eliminating any guest dependency on Python `websockify`.
 */
import { randomBytes } from "node:crypto";
import { createConnection, type AddressInfo, type Socket } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";

const MAX_PRECONNECT_BUFFER = 64 * 1024;
const WS_HIGH_WATERMARK = 4 * 1024 * 1024;
const WS_LOW_WATERMARK = 1024 * 1024;

export interface VncWsProxyOptions {
  targetHost?: string;
  targetPort: number;
  token?: string;
}

export interface VncWsProxyHandle {
  readonly wsPort: number;
  readonly tokenPath: string;
  readonly wsUrl: string;
  targetHost: string;
  targetPort: number;
  updateTarget(host: string, port: number): void;
  close(): Promise<void>;
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export function probeTcpPort(host: string, port: number, timeoutMs = 1_500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = createConnection({ host, port });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
  });
}

export async function startVncWsProxy(options: VncWsProxyOptions): Promise<VncWsProxyHandle> {
  let targetHost = options.targetHost ?? "127.0.0.1";
  let targetPort = options.targetPort;
  const sessionToken = options.token ?? randomBytes(16).toString("hex");
  const tokenPath = `/vnc/${sessionToken}`;

  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    handleProtocols: (protocols) => (protocols.has("binary") ? "binary" : false),
  });

  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve());
    wss.once("error", (err) => reject(err));
  });

  const activePairs = new Set<{ ws: WebSocket; tcp: Socket }>();

  wss.on("connection", (ws, req) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      pathname = "/";
    }
    if (pathname !== tokenPath) {
      ws.close(1008, "Invalid VNC session path");
      return;
    }

    const tcp = createConnection({ host: targetHost, port: targetPort });
    tcp.setNoDelay(true);
    const pair = { ws, tcp };
    activePairs.add(pair);

    let tcpConnected = false;
    let preconnectBytes = 0;
    const preconnectQueue: Buffer[] = [];

    const cleanup = () => {
      if (!activePairs.delete(pair)) return;
      preconnectQueue.length = 0;
      if (!tcp.destroyed) tcp.destroy();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.close();
        } catch {
          ws.terminate();
        }
      }
    };

    tcp.once("connect", () => {
      tcpConnected = true;
      while (preconnectQueue.length > 0 && !tcp.destroyed) {
        const next = preconnectQueue.shift();
        if (next) tcp.write(next);
      }
      preconnectBytes = 0;
    });

    tcp.on("data", (chunk: Buffer) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > WS_HIGH_WATERMARK && !tcp.isPaused()) {
        tcp.pause();
      }
      ws.send(chunk, { binary: true }, (err) => {
        if (err) {
          cleanup();
          return;
        }
        if (tcp.isPaused() && ws.bufferedAmount < WS_LOW_WATERMARK) {
          tcp.resume();
        }
      });
    });

    tcp.on("drain", () => {
      if (ws.isPaused) ws.resume();
    });

    ws.on("message", (data: RawData) => {
      const buf = rawDataToBuffer(data);
      if (!tcpConnected) {
        if (preconnectBytes + buf.length <= MAX_PRECONNECT_BUFFER) {
          preconnectQueue.push(buf);
          preconnectBytes += buf.length;
        }
        return;
      }
      if (!tcp.destroyed && !tcp.write(buf) && !ws.isPaused) {
        ws.pause();
      }
    });

    tcp.once("end", cleanup);
    tcp.once("close", cleanup);
    tcp.once("error", cleanup);
    ws.once("close", cleanup);
    ws.once("error", cleanup);
  });

  const addr = wss.address() as AddressInfo | string | null;
  if (addr === null || typeof addr === "string") {
    await new Promise<void>((res) => wss.close(() => res()));
    throw new Error("Failed to bind local VNC WebSocket proxy port");
  }
  const wsPort = addr.port;
  const wsUrl = `ws://127.0.0.1:${wsPort}${tokenPath}`;
  let closed = false;

  return {
    wsPort,
    tokenPath,
    wsUrl,
    get targetHost() {
      return targetHost;
    },
    get targetPort() {
      return targetPort;
    },
    updateTarget(host: string, port: number) {
      targetHost = host;
      targetPort = port;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const pair of activePairs) {
        pair.tcp.destroy();
        try {
          pair.ws.terminate();
        } catch {
          // Ignore already-closed WebSocket
        }
      }
      activePairs.clear();
      await new Promise<void>((res) => wss.close(() => res()));
    },
  };
}
