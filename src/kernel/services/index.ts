/**
 * Frontend Cordis Service Mesh barrel (`src/kernel/services/index.ts`, ADR 0023 Phase 2).
 *
 * Mounts Qianji's frontend domain services onto a Cordis root `Context` without
 * exposing internal Zustand store implementations to plugins.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ClientContributionRegistry } from "../../lib/clientContributions";
import { ComposerService } from "./composerService";
import { LocaleService, ResourcesService, type LocaleCode } from "./localeAndResources";
import { MenuService } from "./menuService";
import { NavigationService, type NavigationServiceOptions } from "./navigationService";
import { RpcService, type RpcTransport } from "./rpcService";
import { SessionService } from "./sessionService";
import { ShortcutService } from "./shortcutService";
import { ThemeService } from "./themeService";
import { WorkbenchService } from "./workbenchService";
import { WorkspaceService } from "./workspaceService";

export { SessionService } from "./sessionService";
export type {
  RetainSessionOptions,
  SessionHandle,
  SessionHandleSnapshot,
  SessionServiceSnapshot,
} from "./sessionService";

export { WorkspaceService } from "./workspaceService";
export type {
  WorkspaceServiceSnapshot,
  WorkspaceTrustStatus,
} from "./workspaceService";

export { ComposerService, DRAFT_COMPOSER_KEY } from "./composerService";
export type {
  ComposerServiceOptions,
  ComposerSessionBucket,
  ComposerSnapshot,
} from "./composerService";

export { WorkbenchService } from "./workbenchService";
export type {
  OpenFileOptions,
  OpenWorkbenchFile,
  PaneDropZone,
  WorkbenchServiceSnapshot,
  WorkbenchSplitDirection,
  WorkbenchTileNode,
} from "./workbenchService";

export { NavigationService } from "./navigationService";
export type {
  NavigationHubView,
  NavigationRoute,
  NavigationServiceOptions,
  NavigationSnapshot,
  SettingsPageId,
} from "./navigationService";

export { ThemeService } from "./themeService";
export type {
  AppearanceCatalog,
  AppearanceThemeDefinition,
  AppearanceThemeInput,
  ThemePalette,
  ThemeServiceOptions,
  ThemeServiceSnapshot,
  TranscriptDensity,
} from "./themeService";

export {
  isReservedShortcutChord,
  RESERVED_SAFE_MODE_CHORD,
  ShortcutService,
} from "./shortcutService";
export type {
  ShortcutContext,
  ShortcutEntry,
  ShortcutRegistration,
  ShortcutServiceOptions,
  ShortcutServiceSnapshot,
} from "./shortcutService";

export { MENU_LOCATIONS, MenuService } from "./menuService";
export type {
  ClientMenuContextMap,
  ClientMenuItemContribution,
  ClientMenuItemFor,
  ClientMenuLocation,
  MenuServiceOptions,
  MenuServiceSnapshot,
  ResolvedMenuItem,
} from "./menuService";

export { RpcService } from "./rpcService";
export type {
  HostStatus,
  RpcCallOptions,
  RpcNotificationOptions,
  RpcServiceOptions,
  RpcServiceSnapshot,
  RpcTransport,
} from "./rpcService";

export {
  LocaleService,
  normalizeResourceScheme,
  parseResourceUri,
  ResourcesService,
} from "./localeAndResources";
export type {
  LocaleBundle,
  LocaleCode,
  LocaleDictionary,
  LocaleServiceOptions,
  LocaleServiceSnapshot,
  ParsedResourceUri,
  ResourceProtocolHandler,
  ResourcesServiceSnapshot,
  TranslateFn,
  TranslateParams,
} from "./localeAndResources";

export {
  createSessionScopeAdapter,
  installSessionScopeAdapter,
} from "./sessionScopeAdapter";

export const FRONTEND_SERVICE_NAMES = [
  "sessionService",
  "workspaceService",
  "composerService",
  "workbenchService",
  "navigationService",
  "themeService",
  "shortcutService",
  "menuService",
  "rpcService",
  "localeService",
  "resourcesService",
] as const;

export type FrontendServiceName = (typeof FRONTEND_SERVICE_NAMES)[number];

export interface RegisterFrontendServicesOptions {
  /** Shared contribution registry for Composer/Theme/Menu services (defaults to `clientContributions`). */
  contributionRegistry?: ClientContributionRegistry;
  /** Event target for `ShortcutService` (defaults to `window` when available; pass `null` to skip auto-attach). */
  shortcutTarget?: EventTarget | null;
  /** Custom JSON-RPC transport for `RpcService` (defaults to `harnessRuntimes`). */
  rpcTransport?: RpcTransport;
  /** Custom host restart handler for `RpcService`. */
  onRestartHost?: () => Promise<void>;
  /** Custom session switch callback for `NavigationService`. */
  onSwitchSession?: NavigationServiceOptions["onSwitchSession"];
  /** Initial locale override for `LocaleService`. */
  initialLocale?: LocaleCode;
  /** Fallback locale for `LocaleService`. */
  fallbackLocale?: LocaleCode;
}

/**
 * Mount all frontend Cordis services onto `root` and resolve once every
 * service fiber is active and queryable on `root`.
 */
export function registerFrontendServices(
  root: Context,
  options: RegisterFrontendServicesOptions = {},
): Promise<void> {
  const fibers = [
    root.plugin(SessionService),
    root.plugin(WorkspaceService),
    root.plugin(ComposerService, { registry: options.contributionRegistry }),
    root.plugin(WorkbenchService),
    root.plugin(NavigationService, { onSwitchSession: options.onSwitchSession }),
    root.plugin(ThemeService, { registry: options.contributionRegistry }),
    root.plugin(ShortcutService, { target: options.shortcutTarget }),
    root.plugin(MenuService, { registry: options.contributionRegistry }),
    root.plugin(RpcService, {
      transport: options.rpcTransport,
      onRestartHost: options.onRestartHost,
    }),
    root.plugin(LocaleService, {
      initialLocale: options.initialLocale,
      fallbackLocale: options.fallbackLocale,
    }),
    root.plugin(ResourcesService),
  ];
  return Promise.all(fibers).then(() => undefined);
}
