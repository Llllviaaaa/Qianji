/**
 * Pure in-memory `ctx.connectors` Cordis service (`HostConnectorsService`)
 * allowing Host plugins to register dynamic Connectors with custom `connect`,
 * `disconnect`, `status`, and Heartbeat `patrol` lifecycle hooks.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import type { PluginConnectorManifest } from "@qianji/protocol";
import { getCurrentMountingPluginId } from "./plugin-scopes.ts";

export interface HostConnectorPatrolDelta {
  title: string;
  summary: string;
  seedPrompt?: string;
}

export interface HostConnectorRegistration {
  id: string;
  pluginId?: string;
  name?: string;
  tagline?: string;
  description?: string;
  category?: "office" | "dev" | "automation";
  publisher?: string;
  authLabel?: string;
  authMode?: "plugin" | "browser" | "mcp-oauth" | "mcp-direct";
  browserAuthUrl?: string;
  mcpUrl?: string;
  trustedReadOnly?: boolean;
  icon?: string;
  iconBg?: string;
  featured?: boolean;
  starterPrompts?: string[];
  connect?: (ctx: { config: Record<string, unknown>; forceInteractive?: boolean }) => Promise<{
    connected?: boolean;
    accountLabel?: string;
    requireConfigModal?: boolean;
    message?: string;
  }>;
  disconnect?: () => Promise<void> | void;
  status?: () =>
    | Promise<{ connected: boolean; accountLabel?: string; error?: string }>
    | { connected: boolean; accountLabel?: string; error?: string };
  patrol?: () => Promise<HostConnectorPatrolDelta[]>;
}

export interface StoredHostConnector extends HostConnectorRegistration {
  readonly pluginId: string;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    connectors: HostConnectorsService;
  }
}

function bindEffect(ctx: Context | undefined, dispose: () => void, label: string): () => void {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    dispose();
  };
  if (ctx?.fiber?.uid != null && ctx.fiber.state !== 5) {
    try {
      return ctx.effect(() => once, label) as unknown as () => void;
    } catch {
      return once;
    }
  }
  return once;
}

export class HostConnectorsService extends Service {
  private readonly entries = new Map<string, StoredHostConnector>();
  private readonly listeners = new Set<() => void>();

  constructor(ctx: Context) {
    super(ctx, "connectors");
  }

  register(registration: HostConnectorRegistration): () => void {
    const id = registration.id.trim();
    if (!id) throw new Error("Connector id must be non-empty");
    const pluginId = registration.pluginId?.trim() || getCurrentMountingPluginId() || "external";
    const stored: StoredHostConnector = { ...registration, id, pluginId };
    this.entries.set(id, stored);
    this.notify();
    return bindEffect(
      this.ctx,
      () => {
        if (this.entries.get(id) === stored) {
          this.entries.delete(id);
          this.notify();
        }
      },
      `connectors.register:${id}`,
    );
  }

  get(connectorId: string): StoredHostConnector | undefined {
    return this.entries.get(connectorId);
  }

  list(): StoredHostConnector[] {
    return [...this.entries.values()];
  }

  listByPlugin(pluginId: string): StoredHostConnector[] {
    return [...this.entries.values()].filter((c) => c.pluginId === pluginId);
  }

  toManifest(entry: StoredHostConnector, fallbackPublisher: string): PluginConnectorManifest {
    return {
      id: entry.id,
      name: entry.name?.trim() || entry.id,
      tagline: entry.tagline?.trim() || `${entry.name?.trim() || entry.id} 插件连接器`,
      ...(entry.description ? { description: entry.description } : {}),
      category: entry.category ?? "automation",
      publisher: entry.publisher?.trim() || fallbackPublisher,
      ...(entry.authLabel ? { authLabel: entry.authLabel } : {}),
      ...(entry.authMode ? { authMode: entry.authMode } : {}),
      ...(entry.browserAuthUrl ? { browserAuthUrl: entry.browserAuthUrl } : {}),
      ...(entry.mcpUrl ? { mcpUrl: entry.mcpUrl } : {}),
      ...(entry.trustedReadOnly !== undefined ? { trustedReadOnly: entry.trustedReadOnly } : {}),
      ...(entry.icon ? { icon: entry.icon } : {}),
      ...(entry.iconBg ? { iconBg: entry.iconBg } : {}),
      ...(entry.featured !== undefined ? { featured: entry.featured } : {}),
      ...(entry.starterPrompts ? { starterPrompts: entry.starterPrompts } : {}),
    };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // Ignore listener errors.
      }
    }
  }
}
