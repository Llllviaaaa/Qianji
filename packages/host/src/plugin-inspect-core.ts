/**
 * ADR 0023 Phase 6 read-only introspection payload builders for `qianji_inspect`:
 * - `slot_tree`: recursive `CORE_SLOT_CATALOG` tree + 22 legacy `CLIENT_SLOT_CATALOG` mappings
 * - `frontend_services`: `FRONTEND_SERVICE_CATALOG` with reactive `@qianji/client` hooks
 * - `slot_owners`: conflict election precedence, abdication fallback, and Safe Mode guidance
 * - `primitives`: frozen `@qianji/client-primitives` UI component & `SlotFactoryMap` manifest
 */
import {
  CLIENT_SLOT_CATALOG,
  CORE_SLOT_CATALOG,
  FRONTEND_SERVICE_CATALOG,
  type CoreSlotMetadata,
} from "@qianji/protocol";

export interface SlotTreeNode {
  readonly id: string;
  readonly kind: CoreSlotMetadata["kind"];
  readonly scope: CoreSlotMetadata["scope"];
  readonly ownerPlugin: string;
  readonly parentSlot: string | null;
  readonly replaceable: boolean;
  readonly supportsOverlay: boolean;
  readonly summary: string;
  readonly note?: string;
  readonly children: readonly SlotTreeNode[];
}

export interface LegacySlotMappingEntry {
  readonly legacySlot: string;
  readonly mirroredSlot: string;
  readonly method: string;
  readonly coreSlots: readonly string[];
}

export interface ClientPrimitiveEntry {
  readonly name: string;
  readonly category: "action" | "input" | "layout" | "overlay" | "display" | "navigation";
  readonly summary: string;
}

export interface CorePrimitiveFactoryEntry {
  readonly key: string;
  readonly component: string;
  readonly scope: "root";
  readonly defaultOwner: string;
  readonly propsType: string;
  readonly replaceable: boolean;
}

const LEGACY_TO_CORE_SLOT_MAP: Readonly<Record<string, readonly string[]>> = {
  pages: ["stage.pluginPage", "shell.sidebar.nav"],
  leftSidebar: ["shell.sidebar.footer"],
  rightWorkbenchTabs: ["workbench.panes"],
  bottomPanelTabs: ["workbench.bottomTabs"],
  topbarActions: ["shell.topbar.actions"],
  composerToolbar: ["composer.toolbar"],
  composerStatus: ["composer.status"],
  composerBanners: ["composer.banners"],
  overlays: ["shell.overlays"],
  "message.actions": ["conversation.message.actions"],
  "message.toolRenderer": ["conversation.message.toolRenderer"],
  "file.viewer": ["workbench.fileViewer"],
  "status.bar": ["shell.statusBar"],
  "home.quickActions": ["stage.home.quickActions"],
  slashInterceptors: ["conversation.composer"],
  rewindHandlers: ["stage.conversation"],
  "settings.pages": ["settings.pages"],
  "settings.sections": ["settings.sections"],
  menus: ["shell.menubar"],
  keybindings: ["root"],
  "markdown.codeBlock": ["conversation.message.codeBlock"],
  themes: ["root"],
};

const FRONTEND_SERVICE_HOOKS: Readonly<Record<string, readonly string[]>> = {
  slots: ["useSlotOverrides()", "useSlotScope()"],
  styles: ["ctx.styles.inject(css, key?)", "ctx.styles.injectGlobal(css, key?)"],
  sessionService: [
    "useSessionState(explicitCtx?)",
    "useSessionHandle(sessionId, options?, explicitCtx?)",
    "useActiveSession()",
    'useFrontendService("sessionService")',
  ],
  workspaceService: [
    "useWorkspaceState(explicitCtx?)",
    "useActiveWorkspace()",
    'useFrontendService("workspaceService")',
  ],
  composerService: [
    "useComposerState(sessionKey?, explicitCtx?)",
    'useFrontendService("composerService")',
  ],
  workbenchService: [
    "useWorkbenchState(explicitCtx?)",
    'useFrontendService("workbenchService")',
  ],
  navigationService: [
    "useNavigationState(explicitCtx?)",
    'useFrontendService("navigationService")',
  ],
  themeService: [
    "useThemeState(explicitCtx?)",
    "useAppearanceTheme()",
    'useFrontendService("themeService")',
  ],
  shortcutService: [
    "useShortcutsState(explicitCtx?)",
    'useFrontendService("shortcutService")',
  ],
  menuService: [
    "useMenusState(explicitCtx?)",
    'useFrontendService("menuService")',
  ],
  rpcService: [
    "useRpcState(explicitCtx?)",
    "useHostRpcQuery(method, params?, options?)",
    'useFrontendService("rpcService")',
  ],
  localeService: [
    "useLocaleState(explicitCtx?)",
    'useFrontendService("localeService")',
  ],
  resourcesService: [
    "useResourcesState(explicitCtx?)",
    "useResource(address)",
    'useFrontendService("resourcesService")',
  ],
};

const FRONTEND_SHARED_HOOKS = [
  "useClientContext(explicitCtx?)",
  "useFrontendService(name, explicitCtx?)",
  "useSessionState(explicitCtx?)",
  "useSessionHandle(sessionId, options?, explicitCtx?)",
  "useWorkspaceState(explicitCtx?)",
  "useComposerState(sessionKey?, explicitCtx?)",
  "useWorkbenchState(explicitCtx?)",
  "useNavigationState(explicitCtx?)",
  "useThemeState(explicitCtx?)",
  "useShortcutsState(explicitCtx?)",
  "useMenusState(explicitCtx?)",
  "useRpcState(explicitCtx?)",
  "useLocaleState(explicitCtx?)",
  "useResourcesState(explicitCtx?)",
  "useSafeMode()",
  "useSlotOverrides()",
] as const;

export const CLIENT_PRIMITIVES_EXPORTS_MANIFEST = [
  "Badge",
  "Button",
  "Card",
  "Dialog",
  "DialogSection",
  "IconButton",
  "Input",
  "Markdown",
  "Popover",
  "ScrollArea",
  "Select",
  "Switch",
  "Tabs",
  "TabsContent",
  "TabsList",
  "TabsTrigger",
  "Tooltip",
] as const;

export const CLIENT_PRIMITIVES_CATALOG: readonly ClientPrimitiveEntry[] = [
  { name: "Badge", category: "display", summary: "Status pill badge (`neutral` | `brand` | `success` | `warning` | `danger`)." },
  { name: "Button", category: "action", summary: "Tokenized button (`primary` | `secondary` | `ghost` | `danger`, sizes `sm` | `md` | `lg` | `icon`)." },
  { name: "Card", category: "layout", summary: "Surface container (`default` | `subtle` | `elevated` | `interactive`) with optional header/footer." },
  { name: "Dialog", category: "overlay", summary: "Accessible modal dialog with Escape dismissal, backdrop click, title, description, and footer." },
  { name: "DialogSection", category: "overlay", summary: "Structured content block inside `<Dialog>`." },
  { name: "IconButton", category: "action", summary: "Compact icon-only button with required `aria-label`, active state, and optional tooltip." },
  { name: "Input", category: "input", summary: "Single-line text input styled with `--qj-*` tokens and ref forwarding." },
  { name: "Markdown", category: "display", summary: "Rich Markdown renderer with streaming support and workspace file-link click handler." },
  { name: "Popover", category: "overlay", summary: "Anchored popover supporting controlled/uncontrolled state, Escape and outside-click dismissal." },
  { name: "ScrollArea", category: "layout", summary: "Overflow-contained scroll container (`vertical` | `horizontal` | `both`) with focusable region." },
  { name: "Select", category: "input", summary: "Typed option selector supporting `options[]` and `onValueChange`." },
  { name: "Switch", category: "input", summary: "Accessible `role=\"switch\"` boolean toggle (`checked`, `onCheckedChange`)." },
  { name: "Tabs", category: "navigation", summary: "Controlled or uncontrolled tabbed container (`value`, `defaultValue`, `onValueChange`)." },
  { name: "TabsContent", category: "navigation", summary: "Panel rendered when matching tab `value` is active." },
  { name: "TabsList", category: "navigation", summary: "Tab trigger strip container." },
  { name: "TabsTrigger", category: "navigation", summary: "Individual selectable tab button bound to `value`." },
  { name: "Tooltip", category: "overlay", summary: "Hover/focus tooltip anchored `top` or `bottom`." },
] as const;

export const CORE_PRIMITIVE_FACTORIES_CATALOG: readonly CorePrimitiveFactoryEntry[] = [
  { key: "primitive.markdown", component: "Markdown", scope: "root", defaultOwner: "core-primitives", propsType: "MarkdownProps", replaceable: true },
  { key: "primitive.dialog", component: "Dialog", scope: "root", defaultOwner: "core-primitives", propsType: "DialogProps", replaceable: true },
  { key: "primitive.popover", component: "Popover", scope: "root", defaultOwner: "core-primitives", propsType: "PopoverProps", replaceable: true },
  { key: "primitive.card", component: "Card", scope: "root", defaultOwner: "core-primitives", propsType: "CardProps", replaceable: true },
  { key: "primitive.scrollArea", component: "ScrollArea", scope: "root", defaultOwner: "core-primitives", propsType: "ScrollAreaProps", replaceable: true },
] as const;

function buildSlotNode(
  entry: CoreSlotMetadata,
  childrenByParent: ReadonlyMap<string, readonly CoreSlotMetadata[]>,
  ancestors: ReadonlySet<string>,
): SlotTreeNode {
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(entry.id);
  const rawChildren = childrenByParent.get(entry.id) ?? [];
  const children = rawChildren
    .filter((child) => !nextAncestors.has(child.id))
    .map((child) => buildSlotNode(child, childrenByParent, nextAncestors));
  return {
    id: entry.id,
    kind: entry.kind,
    scope: entry.scope,
    ownerPlugin: entry.defaultOwner,
    parentSlot: entry.parent,
    replaceable: entry.replaceable,
    supportsOverlay: entry.kind === "chain",
    summary: entry.summary,
    ...(entry.note === undefined ? {} : { note: entry.note }),
    children,
  };
}

export function buildSlotTreeInspection(): Record<string, unknown> {
  const childrenByParent = new Map<string, CoreSlotMetadata[]>();
  const roots: CoreSlotMetadata[] = [];
  for (const slot of CORE_SLOT_CATALOG) {
    if (slot.parent === null) {
      roots.push(slot);
    } else {
      const siblings = childrenByParent.get(slot.parent);
      if (siblings === undefined) {
        childrenByParent.set(slot.parent, [slot]);
      } else {
        siblings.push(slot);
      }
    }
  }

  const tree = roots.map((root) => buildSlotNode(root, childrenByParent, new Set<string>()));
  const legacyMapping: LegacySlotMappingEntry[] = CLIENT_SLOT_CATALOG.map((slot) => ({
    legacySlot: slot.name,
    mirroredSlot: `legacy.${slot.name}`,
    method: slot.method,
    coreSlots: LEGACY_TO_CORE_SLOT_MAP[slot.name] ?? ["root"],
  }));

  return {
    count: CORE_SLOT_CATALOG.length,
    tree,
    overlaySlots: [
      {
        slotKey: "composer.main",
        catalogSlot: "conversation.composer",
        note: "Chain slot supporting `overlay: true` so the underlying default composer remains mounted with `display: none` and retains typed drafts.",
      },
      {
        slotKey: "shell.stage",
        catalogSlot: "shell.stage",
        note: "Main stage router chain slot selecting home, conversation, hub, or plugin page views.",
      },
    ],
    legacySlotsCount: legacyMapping.length,
    legacyMapping,
  };
}

export function buildFrontendServicesInspection(): Record<string, unknown> {
  const services = FRONTEND_SERVICE_CATALOG.map((service) => ({
    ...service,
    category: service.name === "slots" || service.name === "styles" ? "kernel" : "domain",
    reactiveHooks: FRONTEND_SERVICE_HOOKS[service.name] ?? [],
  }));

  return {
    count: services.length,
    domainServiceCount: services.filter((svc) => svc.category === "domain").length,
    services,
    sharedHooks: [...FRONTEND_SHARED_HOOKS],
  };
}

export function buildSlotOwnersInspection(
  activeExternalClientPlugins: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  const defaultCoreOwners: Record<string, string> = {};
  for (const slot of CORE_SLOT_CATALOG) {
    defaultCoreOwners[slot.id] = slot.defaultOwner;
  }

  return {
    precedence: "slotOverrides > workspace > user > builtin > priority > registrationOrder",
    electionRules: [
      { rank: 1, rule: "slotOverrides", detail: 'Manual user override pin persisted in localStorage["qianji:slot-overrides"] (matching entryId or pluginId).' },
      { rank: 2, rule: "tier: workspace", detail: "Trusted workspace plugin (tier weight 3)." },
      { rank: 3, rule: "tier: user", detail: "User-installed plugin under <dataDir>/plugins (tier weight 2)." },
      { rank: 4, rule: "tier: builtin", detail: "Vite-bundled core/official fallback plugin (tier weight 1)." },
      { rank: 5, rule: "priority", detail: "Higher numeric `priority` wins within the same tier." },
      { rank: 6, rule: "registrationOrder", detail: "Earlier registration sequence (`registeredSeq`) breaks remaining ties." },
    ],
    sameIdReplacement: {
      summary: "Installing an active, non-errored user or workspace plugin with the same `id` as a built-in core plugin hot-swaps out the built-in Fiber; disabling, uninstalling, activation errors, or Safe Mode immediately restores the built-in Fiber.",
      storageKey: "qianji:slot-overrides",
      settingsPage: "slots",
    },
    abdicationFallback: {
      summary: "When a winning single/keyed/chain/factory slot entry throws during render or chain select(), or hits a circuit-breaker lockout, AbdicationTracker marks `(slotKey, entryId)` abdicated and immediately falls back to the next eligible candidate (down to the built-in core plugin), showing a non-blocking toast with Reload / Disable actions.",
      unlockCycleKey: "(etag, configKey, reloadEpoch)",
      recoveryTriggers: [
        "HMR bundle update (new clientEtag)",
        "Plugin config mutation (new configKey)",
        "Explicit plugin reload (incremented reloadEpoch)",
      ],
    },
    safeMode: {
      hotkey: "Ctrl+Shift+Alt+R",
      macHotkey: "Cmd+Shift+Alt+R",
      cliFlag: "--safe-mode",
      queryParam: "?safeMode=1",
      windowFlag: "window.__QIANJI_SAFE_MODE__",
      storageKey: "qianji:safe-mode",
      summary: "Un-overridable window capture-phase emergency channel that pauses all user and workspace external client plugins while keeping the built-in core layer active and rendering SafeModeBanner outside <SlotRoot />.",
    },
    defaultCoreOwners,
    activeExternalClientPlugins,
  };
}

export function buildPrimitivesInspection(): Record<string, unknown> {
  return {
    module: "@qianji/client-primitives",
    exportCount: CLIENT_PRIMITIVES_EXPORTS_MANIFEST.length,
    exports: [...CLIENT_PRIMITIVES_EXPORTS_MANIFEST],
    components: CLIENT_PRIMITIVES_CATALOG,
    slotFactoryCount: CORE_PRIMITIVE_FACTORIES_CATALOG.length,
    slotFactories: CORE_PRIMITIVE_FACTORIES_CATALOG,
    note: "Heavy third-party engines (CodeMirror 6, xterm.js, Mermaid) are intentionally excluded from shared singletons to keep host upgrades decoupled.",
  };
}

/** Compact overview of ADR 0023 topics for `topic: "all"` so output stays well under tool-output caps. */
export function buildCoreTopicsSummary(
  activeExternalClientPlugins: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    slotTree: {
      count: CORE_SLOT_CATALOG.length,
      legacySlotsCount: CLIENT_SLOT_CATALOG.length,
      overlaySlots: ["composer.main", "shell.stage"],
      detailTopic: "slot_tree",
    },
    frontendServices: {
      count: FRONTEND_SERVICE_CATALOG.length,
      services: FRONTEND_SERVICE_CATALOG.map((svc) => svc.name),
      detailTopic: "frontend_services",
    },
    slotOwners: {
      precedence: "slotOverrides > workspace > user > builtin > priority > registrationOrder",
      safeModeHotkey: "Ctrl+Shift+Alt+R",
      safeModeFlag: "--safe-mode",
      activeExternalClientPluginCount: activeExternalClientPlugins.length,
      detailTopic: "slot_owners",
    },
    primitives: {
      module: "@qianji/client-primitives",
      exports: [...CLIENT_PRIMITIVES_EXPORTS_MANIFEST],
      slotFactories: CORE_PRIMITIVE_FACTORIES_CATALOG.map((factory) => factory.key),
      detailTopic: "primitives",
    },
  };
}
