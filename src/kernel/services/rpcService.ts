/**
 * Frontend Cordis `rpcService` (ADR 0023 Phase 2).
 *
 * Wraps Harness Host JSON-RPC calls (`call`), server notification subscriptions
 * (`onNotification`), reactive `hostStatus` tracking, and reconnect lifecycle hooks.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import { harnessRuntimes, type HostStatus } from "../../lib/harnessRuntime";
import { useAppStore } from "../../store";
import { ServiceEmitter, shallowEqualObject, trackContextEffect } from "./shared";

export type { HostStatus };

declare module "@deepseek-ai/cordis" {
  interface Context {
    rpcService: RpcService;
  }
}

export interface RpcCallOptions {
  timeoutMs?: number;
}

export interface RpcNotificationOptions {
  eagerConnect?: boolean;
}

export interface RpcTransport {
  call<T>(method: string, params?: Record<string, unknown>, options?: RpcCallOptions): Promise<T>;
  onNotification(
    method: string,
    listener: (params: unknown) => void,
    options?: RpcNotificationOptions,
  ): () => void;
  onHostStatus(listener: (status: HostStatus) => void): () => void;
  reconnectNow(): void;
}

export interface RpcServiceSnapshot {
  readonly hostStatus: HostStatus;
  readonly connected: boolean;
  readonly reconnectCount: number;
}

export interface RpcServiceOptions {
  transport?: RpcTransport;
  onRestartHost?: () => Promise<void>;
}

interface RpcInternalState {
  readonly transport: RpcTransport;
  readonly onRestartHost: () => Promise<void>;
  wasDisconnected: boolean;
  snapshot: RpcServiceSnapshot;
  readonly emitter: ServiceEmitter;
  readonly reconnectEmitter: ServiceEmitter;
}

export class RpcService extends Service {
  static provide = "rpcService";
  private readonly internal: RpcInternalState;

  constructor(ctx: Context, options?: RpcServiceOptions) {
    super(ctx, "rpcService");
    const transport = options?.transport ?? harnessRuntimes;
    this.internal = {
      transport,
      onRestartHost: options?.onRestartHost ?? (() => useAppStore.getState().restartHost()),
      wasDisconnected: false,
      snapshot: {
        hostStatus: "connected",
        connected: true,
        reconnectCount: 0,
      },
      emitter: new ServiceEmitter("rpcService"),
      reconnectEmitter: new ServiceEmitter("rpcService:reconnect"),
    };

    const offStatus = transport.onHostStatus((status) => {
      const reconnected = status === "connected" && this.internal.wasDisconnected;
      if (status !== "connected") {
        this.internal.wasDisconnected = true;
      } else {
        this.internal.wasDisconnected = false;
      }
      const next: RpcServiceSnapshot = {
        hostStatus: status,
        connected: status === "connected",
        reconnectCount: reconnected
          ? this.internal.snapshot.reconnectCount + 1
          : this.internal.snapshot.reconnectCount,
      };
      if (!shallowEqualObject(this.internal.snapshot, next)) {
        this.internal.snapshot = next;
        this.internal.emitter.emit();
      }
      if (reconnected) {
        this.internal.reconnectEmitter.emit();
      }
    });

    ctx.effect(() => () => {
      offStatus();
      this.internal.emitter.clear();
      this.internal.reconnectEmitter.clear();
    });
  }

  getSnapshot(): RpcServiceSnapshot {
    return this.internal.snapshot;
  }

  getHostStatus(): HostStatus {
    return this.internal.snapshot.hostStatus;
  }

  subscribe(listener: () => void): () => void {
    const rawUnsub = this.internal.emitter.add(listener);
    return trackContextEffect(this.ctx, rawUnsub);
  }

  async call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: RpcCallOptions,
  ): Promise<T> {
    return this.internal.transport.call<T>(method, params, options);
  }

  onNotification<T = unknown>(
    method: string,
    handler: (params: T) => void,
    options?: RpcNotificationOptions,
  ): () => void {
    const safeHandler = (rawParams: unknown) => {
      try {
        handler(rawParams as T);
      } catch (error) {
        console.error(`[qianji-services:rpcService] notification "${method}" handler failed:`, error);
      }
    };
    const rawDispose = this.internal.transport.onNotification(method, safeHandler, options);
    return trackContextEffect(this.ctx, rawDispose);
  }

  onReconnect(handler: () => void): () => void {
    const rawUnsub = this.internal.reconnectEmitter.add(handler);
    return trackContextEffect(this.ctx, rawUnsub);
  }

  reconnect(): void {
    this.internal.transport.reconnectNow();
  }

  async restartHost(): Promise<void> {
    await this.internal.onRestartHost();
  }
}
