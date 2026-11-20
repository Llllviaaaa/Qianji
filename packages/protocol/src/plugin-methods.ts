// Dynamic plugins and workspace trust (ADR 0016).

/** Which tier a plugin comes from. `workspace` overrides `user`, which overrides `builtin`. */
export type PluginTier = "builtin" | "user" | "workspace";

/** Runtime lifecycle state of a plugin. `pending` means enabled, waiting on required `inject` services. */
export type PluginStatus = "active" | "pending" | "disabled" | "errored" | "untrusted";

/** Browser shared module specifiers externalized by the client bundler and provided by the renderer runtime. */
export const CLIENT_SHARED_EXTERNALS = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
  "cordis",
  "@deepseek-ai/cordis",
  "@deepseek-ai/schemastery",
  "schemastery",
  "@qianji/client",
  "@qianji/client-slots",
  "@qianji/client-store",
  "@qianji/client-primitives",
  "@qianji/protocol",
  "@pid/client",
  "@pid/protocol",
  "dsh-better-sidebar",
  "dsh-better-sidebar/client",
  "lucide-react",
] as const;

export interface PluginClientError {
  phase: "load" | "render";
  message: string;
  stack?: string;
  etag?: string;
}

/** How an external plugin was installed. */
export type PluginInstallChannel = "local" | "archive" | "git" | "npm";

export interface PluginInstallOrigin {
  channel: PluginInstallChannel;
  /** Original path, package specifier, or repository URL. */
  spec: string;
  installedAt: string;
  updatedAt?: string;
}

export interface PluginInfo {
  /** Stable identifier (for example `plan`, `mcp`, or `@scope/my-plugin`). */
  id: string;
  /** Human-readable title. */
  name: string;
  version: string;
  description?: string;
  tier: PluginTier;
  status: PluginStatus;
  enabled: boolean;
  /** False when a built-in host transport gateway plugin cannot be disabled while the RPC host is running. */
  canDisable?: boolean;
  /** True when a user or workspace plugin replaces a built-in plugin with the same `id`. */
  overridesBuiltin: boolean;
  /** True when this plugin entry can be removed (for example an external plugin or user override). */
  removable: boolean;
  /** True when the plugin declares a host entry. */
  hasHost: boolean;
  /** True when the plugin declares a client UI bundle. */
  hasClient: boolean;
  /** True when a disk-backed plugin provides a companion `skills/` directory. */
  hasSkills?: boolean;
  /** Relative URL path on the Host WebServer (`/plugins/<encodedId>/client.js`) when `hasClient` is true. */
  clientPath?: string;
  /** Content revision hash of the client bundle, when `hasClient` is true; changes trigger UI HMR. */
  clientEtag?: string;
  /** Absolute directory path for disk-backed (`builtin`, `user`, and `workspace`) plugins. */
  dir?: string;
  /** Workspace root when `tier === "workspace"`. */
  workspace?: string;
  /** File-watch hot reload enabled (external plugins only). */
  watch: boolean;
  /** Installation provenance for `user` plugins installed through the manager. */
  origin?: PluginInstallOrigin;
  /** Current plugin configuration object. */
  config?: Record<string, unknown>;
  /** Optional JSON Schema describing `config` for settings UI rendering. */
  configSchema?: Record<string, unknown>;
  /** Declared Cordis service dependencies (`inject`). */
  inject?: string[];
  /** Declared Cordis service capabilities provided (`provides`). */
  provides?: string[];
  /** Required service names still missing when `status === "pending"`. */
  missingInject?: string[];
  /** Last load or HMR error message when `status === "errored"` or a reload rolled back. */
  error?: string;
  /** Latest client-side load or render error reported by the renderer, if any. */
  clientError?: PluginClientError;
}

export interface PluginListParams {
  /** Optional active workspace path so `<workspace>/.pid/plugins` entries are included. */
  workspace?: string;
}

export interface PluginListResult {
  plugins: PluginInfo[];
}

export interface PluginToggleParams {
  id: string;
  workspace?: string;
  watch?: boolean;
}

export interface PluginConfigureParams {
  id: string;
  config: Record<string, unknown>;
  watch?: boolean;
  workspace?: string;
}

export interface PluginReloadParams {
  /** Reload one plugin by `id`, or rescan and reload all plugins when omitted. */
  id?: string;
  workspace?: string;
}

export interface PluginInstallParams {
  channel: PluginInstallChannel;
  /** Local folder/archive path, Git URL (`github:owner/repo` / `https://...`), or npm package spec (`pkg@version`). */
  spec: string;
  /** For `local` channel: link the directory in place (default `true`, enables `watch`) instead of copying it into `<dataDir>/plugins`. */
  link?: boolean;
  /** Enable file watching after install (defaults to `true` for linked `local` plugins, `false` otherwise). */
  watch?: boolean;
}

export interface PluginUpdateParams {
  /** Update one installed `user` plugin by `id`, or all updatable `git`/`npm` plugins when omitted. */
  id?: string;
}

export interface PluginRemoveParams {
  id: string;
  workspace?: string;
}

export interface PluginMutationResult {
  plugin?: PluginInfo;
  plugins: PluginInfo[];
}

export interface PluginClientBundleParams {
  id: string;
  workspace?: string;
  ifNoneMatch?: string;
}

export interface PluginClientBundleResult {
  notModified: boolean;
  etag: string;
  code?: string;
}

export interface PluginReportClientErrorParams {
  id: string;
  phase: "load" | "render";
  message: string;
  stack?: string;
  etag?: string;
  workspace?: string;
}

export interface PluginClearClientErrorParams {
  id: string;
  workspace?: string;
}

/** Notification `plugin/changed`. */
export interface PluginChangedNotification {
  reason: "installed" | "updated" | "removed" | "toggled" | "configured" | "reloaded" | "hmr" | "trust" | "clientError";
  changedIds: string[];
  plugins: PluginInfo[];
}

export interface WorkspaceTrustEntry {
  path: string;
  trustedAt: string;
}

export interface WorkspaceTrustStatusParams {
  workspace?: string;
}

export interface WorkspaceTrustListResult {
  trusted: WorkspaceTrustEntry[];
  /** Present when `workspace` was passed: trust state and whether `.pid/plugins` or `.pid/harness.json` exists. */
  current?: {
    workspace: string;
    trusted: boolean;
    hasProjectPlugins: boolean;
    hasProjectConfig: boolean;
    pluginIds: string[];
  };
}

export interface WorkspaceTrustSetParams {
  workspace: string;
  trusted: boolean;
}

/** Notification `workspace/trustChanged`. */
export interface WorkspaceTrustChangedNotification {
  workspace: string;
  trusted: boolean;
  trustedList: WorkspaceTrustEntry[];
}
