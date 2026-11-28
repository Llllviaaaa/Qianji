/**
 * Agent ⇄ Bot plugin target declarations, per-mode scope resolution, and
 * ambient AsyncLocalStorage plugin-ID propagation for `Tools` & `Connectors`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL } from "node:url";
import type {
  PluginConnectorManifest,
  PluginInfo,
  PluginModeScopes,
  PluginTargetMode,
  PluginTier,
} from "@qianji/protocol";
import { pathComparisonKey, scanPluginsDirectory } from "./plugin-manifest.ts";
import {
  isWorkspaceTrusted,
  resolveWorkspacePluginsDir,
  updatePluginsStore,
  workspacePluginKey,
} from "./plugin-store.ts";
import { extractStackFrameComparisonKeys } from "./plugin-util.ts";

const activePluginStorage = new AsyncLocalStorage<string>();

export function getCurrentMountingPluginId(): string | undefined {
  return activePluginStorage.getStore();
}

export function runWithPluginId<T>(pluginId: string, fn: () => T): T {
  return activePluginStorage.run(pluginId, fn);
}

/** Built-in & bundled plugins exclusively targeting the Agent coding workbench. */
export const AGENT_ONLY_BUILTIN_IDS = new Set<string>([
  "agent-loop",
  "permissions",
  "checkpoints",
  "plan",
  "subagents",
  "plugin-dev-tools",
  "hooks",
  "workbench",
  "code-review",
  "goal-tracker",
  "message-actions",
  "observability",
  "permission",
  "question",
  "quick-prompts",
  "session-usage",
  "side-chat",
  "smart-rewind",
]);

/** Built-in plugins exclusively targeting Bot companion mode. */
export const BOT_ONLY_BUILTIN_IDS = new Set<string>(["bot-mode"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseManifestTargets(raw: unknown): PluginTargetMode[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PluginTargetMode[] = [];
  if (raw.includes("agent")) out.push("agent");
  if (raw.includes("bot")) out.push("bot");
  return out.length > 0 ? out : undefined;
}

export function parseManifestConnectors(
  raw: unknown,
  fallbackPublisher: string,
): PluginConnectorManifest[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PluginConnectorManifest[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!id || !name) continue;
    const tagline = typeof item.tagline === "string" && item.tagline.trim() !== ""
      ? item.tagline.trim()
      : `${name} 插件连接器`;
    const category =
      item.category === "office" || item.category === "dev" || item.category === "automation"
        ? item.category
        : "automation";
    const starterPrompts = Array.isArray(item.starterPrompts)
      ? item.starterPrompts.filter((s): s is string => typeof s === "string" && s.trim() !== "")
      : undefined;
    const capabilities = Array.isArray(item.capabilities)
      ? item.capabilities.flatMap((cap) => {
          if (!isRecord(cap) || typeof cap.id !== "string" || typeof cap.label !== "string") return [];
          const kind: "read" | "write" = cap.kind === "write" ? "write" : "read";
          const defaultPerm: "allow" | "ask" | "deny" | undefined =
            cap.defaultPerm === "allow" || cap.defaultPerm === "ask" || cap.defaultPerm === "deny"
              ? cap.defaultPerm
              : undefined;
          return [{ id: cap.id, label: cap.label, kind, ...(defaultPerm ? { defaultPerm } : {}) }];
        })
      : undefined;
    const authMode =
      item.authMode === "plugin" ||
      item.authMode === "browser" ||
      item.authMode === "mcp-oauth" ||
      item.authMode === "mcp-direct"
        ? item.authMode
        : undefined;
    out.push({
      id,
      name,
      tagline,
      ...(typeof item.description === "string" ? { description: item.description } : {}),
      category,
      publisher: typeof item.publisher === "string" && item.publisher.trim() !== "" ? item.publisher.trim() : fallbackPublisher,
      ...(typeof item.authLabel === "string" ? { authLabel: item.authLabel } : {}),
      ...(authMode ? { authMode } : {}),
      ...(typeof item.browserAuthUrl === "string" && item.browserAuthUrl.trim() !== ""
        ? { browserAuthUrl: item.browserAuthUrl.trim() }
        : {}),
      ...(typeof item.mcpUrl === "string" && item.mcpUrl.trim() !== ""
        ? { mcpUrl: item.mcpUrl.trim() }
        : {}),
      ...(typeof item.trustedReadOnly === "boolean" ? { trustedReadOnly: item.trustedReadOnly } : {}),
      ...(typeof item.icon === "string" && item.icon.trim() !== "" ? { icon: item.icon.trim() } : {}),
      ...(typeof item.iconBg === "string" && item.iconBg.trim() !== "" ? { iconBg: item.iconBg.trim() } : {}),
      ...(typeof item.featured === "boolean" ? { featured: item.featured } : {}),
      ...(starterPrompts && starterPrompts.length > 0 ? { starterPrompts } : {}),
      ...(capabilities && capabilities.length > 0 ? { capabilities } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

export function sanitizeStoredScopes(raw: unknown): Partial<PluginModeScopes> | undefined {
  if (!isRecord(raw)) return undefined;
  const agent = typeof raw.agent === "boolean" ? raw.agent : undefined;
  const bot = typeof raw.bot === "boolean" ? raw.bot : undefined;
  if (agent === undefined && bot === undefined) return undefined;
  return {
    ...(agent === undefined ? {} : { agent }),
    ...(bot === undefined ? {} : { bot }),
  };
}

export function resolveTargetsAndScopes(input: {
  id: string;
  tier: PluginTier;
  enabled: boolean;
  canDisable: boolean;
  manifestTargets?: readonly PluginTargetMode[];
  hasConnectors?: boolean;
  storedScopes?: Partial<PluginModeScopes>;
}): { targets: PluginTargetMode[]; scopes: PluginModeScopes } {
  let targets: PluginTargetMode[];
  if (input.manifestTargets && input.manifestTargets.length > 0) {
    targets = [...input.manifestTargets];
  } else if (input.tier === "builtin") {
    if (AGENT_ONLY_BUILTIN_IDS.has(input.id)) targets = ["agent"];
    else if (BOT_ONLY_BUILTIN_IDS.has(input.id)) targets = ["bot"];
    else targets = ["agent", "bot"];
  } else {
    targets = ["agent", "bot"];
  }

  let defaultScopes: PluginModeScopes;
  if (!input.canDisable) {
    defaultScopes = { agent: targets.includes("agent"), bot: targets.includes("bot") };
  } else if (input.tier === "builtin" || (input.manifestTargets && input.manifestTargets.length > 0)) {
    defaultScopes = { agent: targets.includes("agent"), bot: targets.includes("bot") };
  } else if (input.hasConnectors) {
    // Connector plugins default to active in Bot immediately; Agent remains opt-in.
    defaultScopes = { agent: false, bot: targets.includes("bot") };
  } else {
    // Legacy external plugins without `targets` default to Agent-only until the user opts Bot in.
    defaultScopes = { agent: targets.includes("agent"), bot: false };
  }

  if (!input.enabled) {
    return { targets, scopes: { agent: false, bot: false } };
  }

  if (!input.canDisable) {
    return { targets, scopes: defaultScopes };
  }

  const scopes: PluginModeScopes = {
    agent: targets.includes("agent") ? (input.storedScopes?.agent ?? defaultScopes.agent) : false,
    bot: targets.includes("bot") ? (input.storedScopes?.bot ?? defaultScopes.bot) : false,
  };
  return { targets, scopes };
}

export function buildUntrustedWorkspaceOverlay(
  base: readonly PluginInfo[],
  workspacePath: string,
  dataDir: string,
  builtinIds: ReadonlySet<string>,
): PluginInfo[] {
  if (isWorkspaceTrusted(dataDir, workspacePath)) {
    return [...base];
  }
  const pluginsDir = resolveWorkspacePluginsDir(workspacePath);
  const scanned = scanPluginsDirectory(pluginsDir, "workspace", workspacePath);
  if (scanned.manifests.length === 0) return [...base];
  const extras: PluginInfo[] = scanned.manifests
    .filter(
      (manifest) =>
        !base.some(
          (existing) =>
            existing.id === manifest.id
            && (existing.tier === "workspace"
              || (existing.dir !== undefined && pathComparisonKey(existing.dir) === pathComparisonKey(manifest.dir))),
        ),
    )
    .map((manifest) => {
      const { targets } = resolveTargetsAndScopes({
        id: manifest.id,
        tier: "workspace",
        enabled: false,
        canDisable: true,
        manifestTargets: manifest.targets,
        hasConnectors: Boolean(manifest.connectors?.length),
      });
      return {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        ...(manifest.description === undefined ? {} : { description: manifest.description }),
        tier: "workspace",
        status: "untrusted",
        enabled: false,
        overridesBuiltin: builtinIds.has(manifest.id),
        removable: false,
        hasHost: manifest.hostEntry !== undefined,
        hasClient: manifest.clientEntry !== undefined,
        ...(manifest.skillsDir === undefined ? {} : { hasSkills: true }),
        dir: manifest.dir,
        workspace: workspacePath,
        watch: false,
        ...(manifest.configSchema === undefined ? {} : { configSchema: manifest.configSchema }),
        ...(manifest.inject !== undefined && manifest.inject.length > 0 ? { inject: [...manifest.inject] } : {}),
        ...(manifest.provides !== undefined && manifest.provides.length > 0 ? { provides: [...manifest.provides] } : {}),
        targets,
        scopes: { agent: false, bot: false },
        ...(manifest.connectors ? { connectors: manifest.connectors } : {}),
      };
    });
  return [...extras, ...base];
}

export function writePluginScopePatch(input: {
  dataDir: string;
  id: string;
  workspace?: string;
  canDisable: boolean;
  nextScopes: PluginModeScopes;
}): void {
  const nextEnabled = input.canDisable ? (input.nextScopes.agent || input.nextScopes.bot) : true;
  if (input.workspace !== undefined) {
    const key = workspacePluginKey(input.workspace, input.id);
    updatePluginsStore(input.dataDir, (store) => {
      const prev = store.workspacePlugins[key];
      store.workspacePlugins[key] = { ...prev, enabled: nextEnabled, scopes: input.nextScopes };
    });
    return;
  }
  updatePluginsStore(input.dataDir, (store) => {
    const prev = store.plugins[input.id];
    store.plugins[input.id] = { ...prev, enabled: nextEnabled, scopes: input.nextScopes };
  });
}

export function matchPluginIdFromErrorStack(
  reason: unknown,
  candidates: ReadonlyArray<{ id: string; enabled: boolean; dir?: string; builtinPlugin?: unknown }>,
): string | undefined {
  const stackText = reason instanceof Error
    ? `${reason.name}: ${reason.message}\n${reason.stack ?? ""}`
    : String(reason);
  const haystack = process.platform === "win32" ? stackText.toLowerCase() : stackText;
  let frameKeys: string[] | undefined;
  let bestMatch: { id: string; len: number } | undefined;

  for (const candidate of candidates) {
    if (!candidate.enabled || candidate.dir === undefined || candidate.builtinPlugin !== undefined) continue;
    const fsDir = candidate.dir.replace(/[\\/]+$/, "");
    if (fsDir === "") continue;
    const slashDir = fsDir.replace(/\\/g, "/");
    const rawFileUrl = pathToFileURL(fsDir).href.replace(/\/+$/, "");
    const boundaryNeedles = [
      `${slashDir}/`,
      `${rawFileUrl}/`,
      ...(process.platform === "win32" ? [`${fsDir}\\`] : []),
    ].map((item) => (process.platform === "win32" ? item.toLowerCase() : item));
    let matched = false;
    for (const needle of boundaryNeedles) {
      if (needle.length > 1 && haystack.includes(needle)) {
        matched = true;
        if (bestMatch === undefined || fsDir.length > bestMatch.len) {
          bestMatch = { id: candidate.id, len: fsDir.length };
        }
      }
    }
    if (!matched) {
      frameKeys ??= extractStackFrameComparisonKeys(stackText);
      if (frameKeys.length > 0) {
        const dirKey = pathComparisonKey(fsDir);
        if (dirKey !== "" && frameKeys.some((fk) => fk === dirKey || fk.startsWith(`${dirKey}/`))) {
          if (bestMatch === undefined || dirKey.length > bestMatch.len) {
            bestMatch = { id: candidate.id, len: dirKey.length };
          }
        }
      }
    }
  }
  return bestMatch?.id;
}
