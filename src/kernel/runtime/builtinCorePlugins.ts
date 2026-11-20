/**
 * Built-in Core Client Plugin Coordinator (`src/kernel/runtime/builtinCorePlugins.ts`, ADR 0023 §1 & §5).
 *
 * Manages Vite-bundled `tier: "builtin"` client plugins on the frontend Cordis
 * root `Context`:
 * - `canDisable: false` core plugins (`core-shell`, `core-sidebar`, `core-home`,
 *   `core-conversation`, `core-composer`, `core-workbench`, `core-settings`,
 *   `core-hubs`) stay mounted unless a non-errored `user`/`workspace` plugin with
 *   the exact same `id` is active and Safe Mode is OFF; disabling, uninstalling,
 *   activation failure, or enabling Safe Mode immediately restores the builtin Fiber.
 * - `canDisable: true` feature plugins (`code-review`, `web-preview`, `side-chat`,
 *   `diagram-viewer`, `intelligent-ui`) mount when active (or offline default
 *   enabled), unmount when disabled/errored on Host or replaced by an active
 *   `user`/`workspace` override, and restore in Safe Mode when enabled.
 */
import type { Plugin } from "@deepseek-ai/cordis";
import type { PluginChangedNotification, PluginInfo, PluginTier } from "@qianji/protocol";
import type {
  ClientContextLike,
  ClientFiberLike,
} from "../../lib/clientPluginRuntime";
import { resolveContextPluginId, tagFiberPluginId } from "./fiberIdentity";
import {
  getClientActivationError,
  getClientPluginRuntimeMeta,
  subscribeClientPluginErrors,
} from "../../lib/clientPluginState";
import { safeModeController, type SafeModeController } from "./safeMode";
import { setPluginTier } from "./slotOverrides";

export interface BuiltinCorePluginDescriptor {
  readonly id: string;
  readonly plugin: Plugin;
  /** When `true`, Host may disable this builtin feature plugin (default `false`). */
  readonly canDisable?: boolean;
  /** Default mounted state when offline / before Host reports plugin list (default `true`). */
  readonly defaultEnabled?: boolean;
  /** Default config merged beneath any Host-persisted builtin plugin config. */
  readonly defaultConfig?: Record<string, unknown>;
}

export type BuiltinPluginStateStatus = "mounted" | "overridden" | "disabled" | "error";

export interface BuiltinCorePluginState {
  readonly id: string;
  readonly canDisable: boolean;
  readonly status: BuiltinPluginStateStatus;
  readonly overrideTier?: PluginTier;
  readonly error?: string;
}

export interface BuiltinCorePluginCoordinatorSnapshot {
  readonly safeMode: boolean;
  readonly plugins: readonly BuiltinCorePluginState[];
}

export interface BuiltinCorePluginTransport {
  list(workspace?: string): Promise<PluginInfo[]>;
  onChanged?(listener: (payload?: PluginChangedNotification) => void): () => void;
  onTrustChanged?(listener: () => void): () => void;
  onHostReconnect?(listener: () => void): () => void;
}

export interface BuiltinCorePluginCoordinatorOptions {
  readonly transport?: BuiltinCorePluginTransport;
  readonly safeMode?: SafeModeController;
  readonly descriptors?: readonly BuiltinCorePluginDescriptor[];
  /** Optional activation error lookup (defaults to `clientPluginState.getClientActivationError`). */
  readonly hasExternalActivationError?: (pluginId: string) => boolean;
  /** Optional subscription for external activation error updates (defaults to `subscribeClientPluginErrors`). */
  readonly subscribeExternalErrors?: (listener: () => void) => () => void;
}

interface MountedBuiltinRecord {
  readonly descriptor: BuiltinCorePluginDescriptor;
  readonly configKey: string;
  readonly fiber: ClientFiberLike;
}

interface DesiredBuiltinDecision {
  readonly shouldMount: boolean;
  readonly status: BuiltinPluginStateStatus;
  readonly config: Record<string, unknown>;
  readonly overrideTier?: PluginTier;
}

function defaultHasExternalActivationError(pluginId: string): boolean {
  const actErr = getClientActivationError(pluginId);
  if (actErr === undefined) return false;
  const liveMeta = getClientPluginRuntimeMeta(pluginId);
  // When `clientPluginRuntime` transactionally rolled back to a still-live prior
  // ETag, that external override remains healthy; fall back to builtin whenever
  // no healthy external Fiber is mounted (cold-boot failure or rollback failure).
  if (liveMeta !== undefined && liveMeta.etag !== actErr.failedEtag) {
    return false;
  }
  return true;
}

function decideBuiltinState(
  desc: BuiltinCorePluginDescriptor,
  hostEntry: PluginInfo | undefined,
  safeModeActive: boolean,
  hasActivationError: boolean,
): DesiredBuiltinDecision {
  const canDisable = desc.canDisable === true;
  const baseConfig = desc.defaultConfig ?? {};
  const builtinConfig =
    hostEntry !== undefined && hostEntry.tier === "builtin" && hostEntry.config !== undefined
      ? { ...baseConfig, ...hostEntry.config }
      : { ...baseConfig };

  const isExternal = hostEntry !== undefined && hostEntry.tier !== "builtin";
  const externalHealthyClient =
    isExternal &&
    hostEntry.hasClient &&
    hostEntry.status === "active" &&
    hostEntry.enabled !== false &&
    (hostEntry.error === undefined || hostEntry.error === "") &&
    hostEntry.clientError === undefined &&
    !hasActivationError;

  if (!canDisable) {
    if (!safeModeActive && externalHealthyClient) {
      return {
        shouldMount: false,
        status: "overridden",
        config: builtinConfig,
        overrideTier: hostEntry.tier,
      };
    }
    return {
      shouldMount: true,
      status: "mounted",
      config: builtinConfig,
    };
  }

  // Feature plugin (`canDisable: true`)
  if (hostEntry === undefined) {
    const enabledOffline = desc.defaultEnabled !== false;
    return {
      shouldMount: enabledOffline,
      status: enabledOffline ? "mounted" : "disabled",
      config: builtinConfig,
    };
  }

  if (hostEntry.tier === "builtin") {
    const hostDisabledOrFailed =
      hostEntry.enabled === false ||
      hostEntry.status === "disabled" ||
      hostEntry.status === "errored" ||
      (hostEntry.error !== undefined && hostEntry.error !== "");
    return {
      shouldMount: !hostDisabledOrFailed,
      status: hostDisabledOrFailed ? "disabled" : "mounted",
      config: builtinConfig,
    };
  }

  // `canDisable: true` with a user/workspace override entry in Host list
  if (hostEntry.enabled === false || hostEntry.status === "disabled") {
    return {
      shouldMount: false,
      status: "disabled",
      config: builtinConfig,
    };
  }

  if (safeModeActive) {
    return {
      shouldMount: true,
      status: "mounted",
      config: builtinConfig,
    };
  }

  if (externalHealthyClient) {
    return {
      shouldMount: false,
      status: "overridden",
      config: builtinConfig,
      overrideTier: hostEntry.tier,
    };
  }

  return {
    shouldMount: true,
    status: "mounted",
    config: builtinConfig,
  };
}

/**
 * Coordinates Vite-bundled `tier: "builtin"` client plugin Fibers against
 * Host plugin state, external same-ID overrides, activation errors, and Safe Mode.
 */
export class BuiltinCorePluginCoordinator {
  private readonly root: ClientContextLike<Plugin>;
  private readonly transport: BuiltinCorePluginTransport | undefined;
  private readonly safeMode: SafeModeController;
  private readonly hasExternalActivationError: (pluginId: string) => boolean;
  private readonly descriptors = new Map<string, BuiltinCorePluginDescriptor>();
  private readonly mounted = new Map<string, MountedBuiltinRecord>();
  private readonly statusById = new Map<string, BuiltinCorePluginState>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribers: Array<() => void> = [];
  private lastPluginsById = new Map<string, PluginInfo>();
  private snapshot: BuiltinCorePluginCoordinatorSnapshot;
  private workspace: string | undefined;
  private mountingBuiltinId: string | undefined;
  private disposed = false;
  private syncChain: Promise<void> = Promise.resolve();

  constructor(
    root: ClientContextLike<Plugin>,
    options: BuiltinCorePluginCoordinatorOptions = {},
  ) {
    this.root = root;
    this.transport = options.transport;
    this.safeMode = options.safeMode ?? safeModeController;
    this.hasExternalActivationError =
      options.hasExternalActivationError ?? defaultHasExternalActivationError;

    this.snapshot = {
      safeMode: this.safeMode.isEnabled(),
      plugins: [],
    };

    if (typeof root.on === "function") {
      this.unsubscribers.push(
        root.on("internal/plugin", (fiber: unknown) => {
          if (typeof fiber !== "object" || fiber === null) return;
          if (this.mountingBuiltinId !== undefined) {
            tagFiberPluginId(fiber, this.mountingBuiltinId);
            return;
          }
          const parentCtx = (fiber as { parent?: unknown }).parent;
          const inherited = resolveContextPluginId(parentCtx);
          if (inherited !== undefined && this.descriptors.has(inherited)) {
            tagFiberPluginId(fiber, inherited);
          }
        }),
      );
    }

    this.unsubscribers.push(
      this.safeMode.subscribe(() => {
        void this.sync({ fetchList: false });
      }),
    );

    const subscribeErrors = options.subscribeExternalErrors ?? subscribeClientPluginErrors;
    this.unsubscribers.push(
      subscribeErrors(() => {
        void this.sync({ fetchList: false });
      }),
    );

    if (this.transport?.onChanged !== undefined) {
      this.unsubscribers.push(
        this.transport.onChanged(() => {
          void this.sync({ fetchList: true });
        }),
      );
    }
    if (this.transport?.onTrustChanged !== undefined) {
      this.unsubscribers.push(
        this.transport.onTrustChanged(() => {
          void this.sync({ fetchList: true });
        }),
      );
    }
    if (this.transport?.onHostReconnect !== undefined) {
      this.unsubscribers.push(
        this.transport.onHostReconnect(() => {
          void this.sync({ fetchList: true });
        }),
      );
    }

    if (options.descriptors !== undefined && options.descriptors.length > 0) {
      for (const desc of options.descriptors) {
        this.descriptors.set(desc.id, desc);
      }
      void this.sync({ fetchList: this.transport !== undefined });
    }
  }

  /** Unregister builtin plugin descriptors by ID and dispose any mounted Fibers. */
  unregister(ids: readonly string[]): void {
    let changed = false;
    for (const id of ids) {
      if (this.descriptors.delete(id)) changed = true;
    }
    if (changed) {
      void this.sync({ fetchList: false });
    }
  }

  /** Register one or more builtin plugin descriptors and immediately reconcile. */
  register(descriptors: readonly BuiltinCorePluginDescriptor[]): () => void {
    const registeredIds: string[] = [];
    for (const desc of descriptors) {
      this.descriptors.set(desc.id, desc);
      registeredIds.push(desc.id);
    }
    void this.sync({ fetchList: this.transport !== undefined });

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.unregister(registeredIds);
    };
  }

  setWorkspace(workspace: string | undefined): void {
    const normalized = workspace?.trim() || undefined;
    if (this.workspace === normalized) return;
    this.workspace = normalized;
    void this.sync({ fetchList: this.transport !== undefined });
  }

  isMounted(pluginId: string): boolean {
    return this.mounted.has(pluginId);
  }

  getMountedIds(): string[] {
    return [...this.mounted.keys()];
  }

  getSnapshot = (): BuiltinCorePluginCoordinatorSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  sync(options: { readonly fetchList?: boolean } = {}): Promise<void> {
    const shouldFetch = options.fetchList !== false;
    this.syncChain = this.syncChain.then(
      () => this.reconcileOnce(shouldFetch),
      () => this.reconcileOnce(shouldFetch),
    );
    return this.syncChain;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
    const active = [...this.mounted.values()].reverse();
    this.mounted.clear();
    this.statusById.clear();
    this.descriptors.clear();
    for (const item of active) {
      await item.fiber.dispose().catch(() => undefined);
    }
    this.publishSnapshot();
    this.listeners.clear();
  }

  private async reconcileOnce(shouldFetch: boolean): Promise<void> {
    if (this.disposed) return;
    if (shouldFetch && this.transport !== undefined) {
      try {
        const list = await this.transport.list(this.workspace);
        if (this.disposed) return;
        const nextMap = new Map<string, PluginInfo>();
        for (const entry of list) {
          nextMap.set(entry.id, entry);
        }
        this.lastPluginsById = nextMap;
      } catch {
        // Offline or Host unavailable: preserve last known state (or offline defaults).
      }
    }
    if (this.disposed) return;

    // Unmount fibers whose descriptors were unregistered
    for (const [id, active] of [...this.mounted.entries()]) {
      if (!this.descriptors.has(id)) {
        this.mounted.delete(id);
        this.statusById.delete(id);
        await active.fiber.dispose().catch(() => undefined);
      }
    }

    const safeModeActive = this.safeMode.isEnabled();

    for (const desc of this.descriptors.values()) {
      if (this.disposed) return;
      const hostEntry = this.lastPluginsById.get(desc.id);
      const hasActivationError = this.hasExternalActivationError(desc.id);
      const decision = decideBuiltinState(desc, hostEntry, safeModeActive, hasActivationError);
      const current = this.mounted.get(desc.id);

      if (!decision.shouldMount) {
        if (decision.overrideTier !== undefined) {
          setPluginTier(desc.id, decision.overrideTier);
        }
        if (current !== undefined) {
          this.mounted.delete(desc.id);
          await current.fiber.dispose().catch(() => undefined);
        }
        this.statusById.set(desc.id, {
          id: desc.id,
          canDisable: desc.canDisable === true,
          status: decision.status,
          ...(decision.overrideTier === undefined ? {} : { overrideTier: decision.overrideTier }),
        });
        continue;
      }

      const configKey = JSON.stringify(decision.config);
      if (
        current !== undefined &&
        current.descriptor.plugin === desc.plugin &&
        current.configKey === configKey
      ) {
        setPluginTier(desc.id, "builtin");
        this.statusById.set(desc.id, {
          id: desc.id,
          canDisable: desc.canDisable === true,
          status: "mounted",
        });
        continue;
      }

      if (current !== undefined) {
        this.mounted.delete(desc.id);
        await current.fiber.dispose().catch(() => undefined);
      }

      setPluginTier(desc.id, "builtin");
      let nextFiber: ClientFiberLike | undefined;
      try {
        this.mountingBuiltinId = desc.id;
        try {
          nextFiber = this.root.plugin(desc.plugin, decision.config);
          if (typeof nextFiber === "object" && nextFiber !== null) {
            tagFiberPluginId(nextFiber, desc.id);
          }
        } finally {
          this.mountingBuiltinId = undefined;
        }
        if (typeof nextFiber.then === "function" && nextFiber.state !== 0) {
          await (nextFiber as PromiseLike<unknown>);
        }
        this.mounted.set(desc.id, {
          descriptor: desc,
          configKey,
          fiber: nextFiber,
        });
        this.statusById.set(desc.id, {
          id: desc.id,
          canDisable: desc.canDisable === true,
          status: "mounted",
        });
      } catch (error) {
        await nextFiber?.dispose().catch(() => undefined);
        const msg = error instanceof Error ? error.message : String(error);
        this.statusById.set(desc.id, {
          id: desc.id,
          canDisable: desc.canDisable === true,
          status: "error",
          error: msg,
        });
        console.error(`[qianji-builtin-plugins] failed to mount builtin "${desc.id}":`, error);
      }
    }

    this.publishSnapshot();
  }

  private publishSnapshot(): void {
    const plugins = [...this.descriptors.keys()]
      .sort()
      .map((id) => this.statusById.get(id))
      .filter((entry): entry is BuiltinCorePluginState => entry !== undefined);
    this.snapshot = {
      safeMode: this.safeMode.isEnabled(),
      plugins,
    };
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

export function createBuiltinCorePluginCoordinator(
  root: ClientContextLike<Plugin>,
  options?: BuiltinCorePluginCoordinatorOptions,
): BuiltinCorePluginCoordinator {
  return new BuiltinCorePluginCoordinator(root, options);
}
