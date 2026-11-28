# Frontend Microkernel (`ctx.slots`), Services, Primitives & `@qianji/client` SDK

Qianji's React 19 renderer runs on a typed frontend microkernel (**ADR 0023**): every core UI region is implemented by Vite-bundled built-in plugins (`src/builtin-plugins/*`) bound to the same public contracts available to dynamic user/workspace plugins:

- **`@qianji/client-slots`** — Typed slot tree (`SlotMap`, `ChildrenDecl`, `SlotScope`, `SlotKind`, `wrap`, `SlotFactoryMap`, `<SessionArea>`, `useResource`).
- **`@qianji/client-store`** — Managed per-slot / per-factory-occurrence Store seats (`StoreDecl`, `createReactiveStore`, `useStoreValue`).
- **`@qianji/client-primitives`** — 17 frozen, `--qj-*` token-driven UI primitives + 5 replaceable `SlotFactoryMap` primitive factories.
- **`@qianji/client`** — Reactive hooks for the Frontend Cordis Service Mesh, Safe Mode / Slot Override hooks, and all backward-compatible SDK hooks & controlled host actions.
- **Full Backward Compatibility** — All **22 `ctx.contributions` APIs**, existing `@qianji/client` exports, and `ctx.betterSidebar` remain 100% supported (mirrored internally onto `ctx.slots`) with zero breaking changes for existing plugins.

---

## 1. Typed `ctx.slots` Microkernel API (`@qianji/client-slots` & `@qianji/client-store`)

Client plugins inject `["slots", "styles"]` (plus any frontend Cordis services they need) and run inside isolated child Fibers guarded by `<SlotKernelErrorBoundary>` / `<SlotEntryHost>`. Uncaught synchronous throws or Hook violations isolate cleanly to that slot entry, report `clientError` (`phase: "load" | "render"`) to Host (`qianji_inspect(topic: "plugins")`), and trigger automatic **abdication fallback** on replaceable core slots.

### 1.1 `SlotMap` Declaration Merging & the 46 Canonical Core Slots

Any built-in or external plugin can declare new typed slots via module augmentation on `@qianji/client-slots`:

```tsx
import type { SlotSpec } from "@qianji/client-slots";

declare module "@qianji/client-slots" {
  interface SlotMap {
    "myPlugin.composerFooter": SlotSpec<
      { readonly cwd?: string; readonly sessionId: string | null },
      "list",
      "session-maybe"
    >;
  }
}
```

Qianji ships **46 canonical core slots** (`CoreSlotMap` & `CORE_SLOT_SPECS` in `src/kernel/slots/coreSlotMap.ts`). Query the live hierarchical tree and legacy mappings anytime via `qianji_inspect(topic: "slot_tree")`:

| Area (Count) | Slot Keys (`kind` / `scope`) |
| :--- | :--- |
| **Shell / Root (10)** | `root` (`single`/`root`), `shell.menubar` (`single`/`root`), `shell.sidebar` (`single`/`root`), `shell.topbar` (`single`/`root`), `shell.stage` (`chain`/`session-maybe`), `shell.workbench.right` (`single`/`session-maybe`), `shell.workbench.bottom` (`single`/`session-maybe`), `shell.statusbar` (`list`/`session-maybe`), `shell.overlays` (`list`/`root`), `shell.modals` (`list`/`root`) |
| **Sidebar (6)** | `sidebar.header` (`single`/`root`), `sidebar.nav` (`list`/`root`), `sidebar.threads` (`single`/`root`), `sidebar.sessionRow` (`chain`/`root`), `sidebar.sections` (`list`/`root`), `sidebar.footer` (`single`/`root`) |
| **Home (3)** | `home.hero` (`single`/`root`), `home.quickActions` (`list`/`root`), `home.sections` (`list`/`root`) |
| **Conversation (11)** | `conversation.header` (`list`/`session`), `conversation.transcript` (`single`/`session`), `conversation.turn` (`chain`/`session`), `conversation.message` (`chain`/`session`), `conversation.message.actions` (`list`/`session`), `conversation.thinking` (`chain`/`session`), `conversation.toolCall` (`keyed`/`session`), `conversation.markdown.codeBlock` (`keyed`/`session`), `conversation.turnFooter` (`list`/`session`), `conversation.composerDock` (`single`/`session-maybe`), `conversation.approvalDialog` (`chain`/`session`) |
| **Composer (6)** | `composer.main` (`chain`/`session-maybe`), `composer.banners` (`list`/`session-maybe`), `composer.attachments` (`single`/`session-maybe`), `composer.input` (`single`/`session-maybe`), `composer.toolbar` (`list`/`session-maybe`), `composer.status` (`list`/`session-maybe`) |
| **Workbench (6)** | `workbench.topbarControls` (`list`/`session-maybe`), `workbench.tilingGrid` (`single`/`session-maybe`), `workbench.panes` (`keyed`/`session-maybe`), `workbench.fileViewer` (`keyed`/`session-maybe`), `workbench.inspector.sections` (`list`/`session-maybe`), `workbench.bottom.tabs` (`keyed`/`session-maybe`) |
| **Settings & Hub (4)** | `settings.shell` (`single`/`root`), `settings.pages` (`keyed`/`root`), `settings.sections` (`list`/`root`), `hub.pages` (`keyed`/`root`) |

In addition to the 46 canonical core slots, `bot-mode` exposes the keyed slot **`bot.connector.sections`** (`keyed`/`root`, props `{ connectorId, pluginId?, connected }`) so Connector plugins with a `client.tsx` bundle can render custom interactive cards inside their Connector's detail page in Bot Settings.

### 1.2 Four `SlotKind` Dispatch Semantics & Onion `wrap`

- **`single`**: Exclusive slot. Elects one winner by `slotOverrides > workspace > user > builtin > priority > registrationOrder`.
- **`list`**: Renders all matching entries sorted by ascending `order` (default `100`).
- **`keyed`**: Routes by `key` (exact string, `readonly string[]`, prefix wildcard such as `"sqlite_*"`, or custom `matchKey(routeKey)` predicate). Supports `renderSlot(key, props, { key: routeKey, mode: "single" | "all" })`.
- **`chain`**: Evaluates `select(ownerProps)` in priority order; the first entry returning a non-`null`, non-`undefined`, non-`false` value wins and receives that result via its `selected` prop.
  - **`overlay: true`**: Keeps the shadowed underlying entry mounted with `display: none` instead of unmounting it. Use this on `composer.main` so temporary takeovers preserve user drafts and DOM state cleanly when dismissed.
- **`ctx.slots.wrap(slotKey, wrapper)`**: Wraps rendered output of any slot in an onion decorator component receiving `{ slotKey, props, children }`. Each wrapper runs inside its own `<WrapperErrorBoundary>` so a crashing decorator never tears down the wrapped core UI.

### 1.3 `ChildrenDecl` Ownership & `SlotScope` / `<SessionArea>`

- **`children` (`ChildrenDecl`)**: A slot registration declares any child slots it owns (`{ kind, scope, inject?, description? }`). Its injected `renderSlot` and `renderSlotChain` handles are strictly bound to those declared children:
  - Calling `renderSlot` for an undeclared child throws **`SlotOwnershipError`**.
  - Invoking a captured handle after the owning Fiber disposes throws **`StaleAuthorizationError`**.
- **Three `SlotScope` Levels**:
  - `"root"` (`GlobalStandardProps`): injects `{ ctx?, scope, renderSlot, renderSlotChain, renderFactory, t?, store }`.
  - `"session-maybe"` (`SessionMaybeStandardProps`): adds `sessionId: string | null`.
  - `"session"` (`SessionStandardProps`): guarantees a concrete `sessionId: string` (renders `fallback` / `null` if no session is bound).
- **`<SessionArea sessionId={id} disposeStoresOnUnmount?>`** (also exported as **`<SessionProvider>`**): Binds a specific `sessionId` to all descendant `"session"` and `"session-maybe"` slots (allowing main conversation, `side-chat`, and split panes to share identical conversation & composer slot trees). Read the ambient scope with `useSlotScope()`.

### 1.4 `SlotFactoryMap`, `@qianji/client-store`, `LocaleNamespaceMap` & `ResourceProtocolMap`

- **Reusable Component Factories (`SlotFactoryMap`)**: Declare reusable replaceable widgets in `SlotFactoryMap`, register via `ctx.slots.registerFactory(factoryKey, { component, priority?, scope?, store? })`, and render per occurrence via `renderFactory(factoryKey, props, { occurrenceKey?, sessionId?, compact?, fallback? })` or `<SlotFactoryHost>`. Each occurrence has isolated ErrorBoundary & store seat lifecycle.
- **Managed Store Seats (`@qianji/client-store`)**: Attach `store: StoreDecl<S, TProps>` (`(ctx) => store` or `{ create(ctx), dispose?(store, ctx) }`, with `ctx.onDispose(cleanup)`) to any `ctx.slots.register(...)` or `ctx.slots.registerFactory(...)` call.
  - Seats are lazily created per `(entryId, scopeKey)` for slots or `(factoryKey, occurrenceKey, scopeKey)` for factory occurrences, passed via the `store` prop, and disposed automatically when the entry, scope (`disposeScopeStores`), or retained occurrence unmounts.
  - Lightweight reactivity without importing Zustand: `createReactiveStore<T>(initialValue)` (`get()`, `set()`, `subscribe()`) and `useStoreValue(store)` (plus low-level accessors `storeOf`, `peekStoreOf`, `factoryStoreOf`, `retainFactoryOccurrence`).
- **Optional i18n & Resource Protocol Hooks**: Augment `LocaleNamespaceMap` (pass `locale: "<ns>"` in `register()` to receive a typed `t(key, params?)` prop backed by `localeService`) and `ResourceProtocolMap` (subscribe reactively with `useResource<P>(address)` backed by `resourcesService`).

### 1.5 Typed Slot Override, Child Slot, Managed Store & Wrapper Example

```tsx
import type { Context } from "@deepseek-ai/cordis";
import { sendChatPrompt, useComposerState } from "@qianji/client";
import { Badge, Button } from "@qianji/client-primitives";
import type { SlotComponentProps, SlotPropsOf, SlotSpec } from "@qianji/client-slots";
import { createReactiveStore, useStoreValue, type ReactiveStore } from "@qianji/client-store";

declare module "@qianji/client-slots" {
  interface SlotMap {
    "demo.composerFooter": SlotSpec<{ readonly sessionId: string | null }, "list", "session-maybe">;
  }
}

type DraftStore = ReactiveStore<string>;
type Props = SlotComponentProps<SlotPropsOf<"composer.main">, "session-maybe", DraftStore, { variant: string }>;

function CustomComposer({ sessionId, sessionKey, store, selected, renderSlot }: Props) {
  const value = useStoreValue(store);
  const underlying = useComposerState(sessionKey);
  return (
    <div className="custom-composer" data-variant={selected?.variant}>
      <Badge variant="brand">overlay: true</Badge>
      <textarea value={value} onChange={(e) => store.set(e.target.value)} />
      <div>
        <span>保留底层草稿：{underlying?.draft.length ?? 0} 字</span>
        {renderSlot("demo.composerFooter", { sessionId })}
        <Button size="sm" variant="primary" onClick={() => void sendChatPrompt(value)}>发送</Button>
      </div>
    </div>
  );
}

export const name = "demo-core-override";
export const inject = ["slots"];

export function apply(ctx: Context): void {
  // 1. Non-destructive overlay takeover on composer.main with a managed store & child slot
  ctx.slots.register<"composer.main", DraftStore, { variant: string }>("composer.main", {
    id: "demo-composer-overlay",
    priority: 20,
    overlay: true,
    select: (props) => (props.pendingApproval ? false : { variant: props.variant ?? "follow-up" }),
    store: () => createReactiveStore(""),
    children: { "demo.composerFooter": { kind: "list", scope: "session-maybe" } },
    component: CustomComposer,
  });

  // 2. Non-invasive onion wrapper around conversation.message
  ctx.slots.wrap("conversation.message", {
    id: "demo-message-frame",
    component: ({ children }) => <div className="demo-msg-wrap">{children}</div>,
  });
}
```

---

## 2. Public UI Primitives (`@qianji/client-primitives`)

`@qianji/client-primitives` exposes **17 frozen, `--qj-*` token-driven primitives** shared by both built-in core plugins and external plugins (query live metadata with `qianji_inspect(topic: "primitives")`):

| Category | Exports |
| :--- | :--- |
| **Actions** | `Button` (`primary` \| `secondary` \| `ghost` \| `danger`; `sm` \| `md` \| `lg` \| `icon`), `IconButton` (requires `aria-label`) |
| **Inputs** | `Input`, `Select` (`options[]`, `onValueChange`), `Switch` (`role="switch"`, `checked`, `onCheckedChange`) |
| **Layout & Display** | `Card` (`default` \| `subtle` \| `elevated` \| `interactive`), `ScrollArea`, `Badge` (`neutral` \| `brand` \| `success` \| `warning` \| `danger`), `Markdown` (streaming + workspace file link handler) |
| **Navigation** | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` |
| **Overlays** | `Dialog`, `DialogSection`, `Popover`, `Tooltip` |

Five core primitives are also registered in `SlotFactoryMap` (`tier: "builtin"`, `priority: 0`) so plugins can replace or render them via `renderFactory(...)`:
- `"primitive.markdown"`, `"primitive.dialog"`, `"primitive.popover"`, `"primitive.card"`, `"primitive.scrollArea"`.

> Heavy third-party engines (`CodeMirror 6`, `xterm.js`, `Mermaid`) are intentionally excluded from `CLIENT_SHARED_EXTERNALS` so Host upgrades remain decoupled.

---

## 3. Frontend Cordis Service Mesh & Reactive Hooks (`@qianji/client`)

Qianji mounts **11 frontend domain Cordis services** (`src/kernel/services/index.ts`, comprising the 10 ADR 0023 services plus `menuService`) alongside kernel services **`slots`** and **`styles`** (13 total; inspect live with `qianji_inspect(topic: "frontend_services")`).

Consume services in `apply(ctx)` via `export const inject = [...]`, or inside React components via `@qianji/client` hooks (never import internal Zustand stores):

| Service Name | Responsibility & Key Methods | `@qianji/client` Reactive Hook(s) |
| :--- | :--- | :--- |
| `sessionService` | Multi-session catalog, ref-counted `retain(sessionId, opts?)` -> `SessionHandle`, full `messages[]`, streaming/compacting, branch/rewind, model/effort/permission/agent mode (`newSession`, `switchSession`, `renameSession`, `archiveSession`, `deleteSession`, `refreshSessions`) | `useSessionState()`, `useSessionHandle(sessionId, opts?)`, `useActiveSession()` |
| `workspaceService` | Active workspace `cwd`, directory listing, Git status/diff/restore, trust status, file read & external open (`selectWorkspace`, `pickFolder`, `refreshGit`, `restoreGitFiles`, `listDir`, `readFile`, `openExternal`, `openInFileManager`) | `useWorkspaceState()`, `useActiveWorkspace()` |
| `composerService` | Per-session draft bucket, prefill, attachments, queued messages (`setDraft`, `prefill`, `consumePrefill`, `addAttachments`, `removeAttachment`, `clearAttachments`, `moveQueuedMessage`, `removeQueuedMessage`, `steerQueuedMessage`) | `useComposerState(sessionKey?)` |
| `workbenchService` | Right/bottom workbench visibility, split tiling tree, file editor, review, preview, summary, terminal (`openPane`, `closePane`, `togglePane`, `activateExtensionPane`, `swapOrDockPanes`, `setSplitNodeRatio`, `setTwoPaneDirection`, `toggleMaximizePane`, `toggleInspector`, `toggleBottom`, `openFile`, `openReview`, `openPreview`, `openSummary`, `bumpTerminalCreateNonce`, `toggleFileDrawer`) | `useWorkbenchState()` |
| `navigationService` | Main stage routes, back/forward history, Settings modal/page, sidebar width/collapse, toasts, notification center, extension approval queue (`navigate`, `goBack`, `goForward`, `openSettings`, `closeSettings`, `openPluginPage`, `setHubView`, `setDraftMode`, `showToast`, `dismissToast`, `markNotificationRead`, `markAllNotificationsRead`, `dismissNotification`, `answerExtension`) | `useNavigationState()` |
| `themeService` | Appearance theme catalog, light/dark scheme, accent color, UI scale, transcript density (`registerTheme`, `setTheme`, `setTranscriptDensity`, `cycleTranscriptDensity`, `setUiScale`) | `useThemeState()`, `useAppearanceTheme()` |
| `shortcutService` | Global keyboard shortcut registration & dispatch; reserves Safe Mode chord (`register`, `attach`, `match`, `dispatch`, `getSnapshot`, `subscribe`) | `useShortcutsState()` |
| `menuService` | Unified registry for window menubar, thread, sidebar, and file context menus (`register`, `hasItems`, `getItems`, `executeItem`, `getSnapshot`, `subscribe`) | `useMenusState()` |
| `rpcService` | Harness Host JSON-RPC calls, server notifications, connection status & reconnect (`call`, `onNotification`, `getHostStatus`, `subscribe`, `onReconnect`, `reconnect`, `restartHost`, `getSnapshot`) | `useRpcState()`, `useHostRpcQuery()` |
| `localeService` | Optional i18n locale dictionaries & typed `t()` binding (`registerNamespace`, `getLocale`, `setLocale`, `translate`, `bind`, `getSnapshot`, `subscribe`) | `useLocaleState()` |
| `resourcesService` | Custom URI scheme handlers & reactive resource subscriptions (`registerProtocol`, `hasProtocol`, `read`, `subscribe`, `subscribeProtocols`, `subscribeResource`, `getSnapshot`) | `useResourcesState()`, `useResource(address)` |
| `slots` *(kernel)* | Typed slot registry (`defineSlot`, `register`, `registerFactory`, `wrap`, `onAbdicate`, `inspectSlot`, `inspectAllSlots`, `overrides`, `abdication`, `stores`) | `useSlotOverrides()`, `useSlotScope()` |
| `styles` *(kernel)* | Scoped & global plugin stylesheet injection (`inject`, `injectGlobal`) | *(called via `ctx.styles`)* |

**Shared Context & Governance Hooks on `@qianji/client`**:
- `useClientContext(explicitCtx?)` — Resolve the ambient frontend Cordis `Context`.
- `useFrontendService(name, explicitCtx?)` — Referentially stable lookup of any of the 11 domain services to invoke mutating actions from React handlers.
- `useSafeMode()` — `{ active, enabled, reason, toggledCount }`.
- `useSlotOverrides()` — Live map of user-pinned slot overrides (`Record<string, string>`).

---

## 4. Global Skin Channel (`*.global.css` / `ctx.styles.injectGlobal()`)

Qianji's CSS cascade order in `src/styles/index.css` is:

```css
@layer theme, base, plugin-ui, legacy, skin, components, plugin-skin, utilities;
```

- **Default Scoped Channel (`@layer plugin-ui`)**: `import "./styles.css"` or `ctx.styles.inject(css, key?)` wraps rules in `@layer plugin-ui { @scope ([data-qj-plugin="<id>"]) { ... } }` (`:root` rewritten to `:scope`). Sits below host styles so ordinary widgets never affect host chrome.
- **Opt-In Global Skin Channel (`@layer plugin-skin`)**: `import "./skin.global.css"` (any `*.global.css` file, compiled by `ClientBundleRegistry` to `globalThis.__qianjiInjectPluginGlobalStyle`) or `ctx.styles.injectGlobal(css, key?)` wraps rules in unscoped `@layer plugin-skin { ... }`, preserving `:root` tokens while sanitizing comments, strings, and unmatched braces.
  - Sits **above** host `legacy`, `skin`, and `components`, and **below** Tailwind `utilities`.
  - Shares per-plugin HMR snapshot, stale-sheet pruning, failure rollback, and unload disposal with scoped styles.

---

## 5. Core Scaffold Templates (`core-override` & `global-skin`)

`plugin_manager(action: "scaffold")` supports 5 templates that pass `verify` and `tsc --noEmit` against offline `plugin-types/` out of the box:

- `tool-only`, `ui-slot-widget`, `fullstack-panel` — Standard Host tools, `<PluginSlot>` widgets, and fullstack workbench panels.
- **`core-override`** (`packages/host/src/plugin-templates-core.ts`) — Generates `package.json`, `tsconfig.json`, and `client.tsx` implementing a typed `composer.main` `overlay: true` override with `SlotMap` declaration merging, a nested child `list` slot, `useComposerState` draft preservation, and `@qianji/client-primitives`.
- **`global-skin`** (`packages/host/src/plugin-templates-core.ts`) — Generates `package.json`, `tsconfig.json`, `env.d.ts`, `skin.global.css`, and `client.tsx` combining static `*.global.css` import, `configSchema`-driven `ctx.styles.injectGlobal()`, and `ctx.contributions.registerTheme()`.

---

## 6. Slot Ownership Governance, Abdication Fallback & Safe Mode

Query live rules and active overrides anytime via `qianji_inspect(topic: "slot_owners")`:

1. **Same-ID Core Plugin Replacement (`BuiltinCorePluginCoordinator`)**:
   - The 8 `canDisable: false` built-in core plugins (`core-shell`, `core-sidebar`, `core-home`, `core-conversation`, `core-composer`, `core-workbench`, `core-settings`, `core-hubs`) and 5 `canDisable: true` built-in feature plugins (`code-review`, `web-preview`, `side-chat`, `diagram-viewer`, `intelligent-ui`) run as real `tier: "builtin"` Fibers.
   - Installing an active, non-errored `user` or `workspace` plugin with the **exact same `id`** hot-swaps out the built-in Fiber; disabling, uninstalling, activation failure, or enabling Safe Mode immediately restores the built-in Fiber.
2. **Slot Election Precedence & Governance UI**:
   - Competing candidates on `single`, `chain`, or `keyed` slots resolve strictly by:
     `slotOverrides > workspace > user > builtin > priority > registrationOrder`.
   - Manual user pins persist in `localStorage["qianji:slot-overrides"]`. Users inspect all 46 core slots + custom slots, view abdication diagnostics, pin winners, or restore defaults under **Settings → 核心槽位与接管** (`openSettingsPage("slots")`).
3. **Automatic Abdication Fallback (`AbdicationTracker`)**:
   - If a winning `single` / `keyed` / `chain` / factory entry throws during render or chain `select()`, or hits a circuit-breaker lockout, the kernel marks `(slotKey, entryId)` **abdicated**, immediately falls back to the next candidate (down to the built-in core plugin), and surfaces a non-blocking Toast.
   - Abdication unlocks automatically whenever the plugin produces a new `(etag, configKey, reloadEpoch)` cycle (HMR rebuild, config edit, or explicit reload).
4. **Emergency Safe Mode**:
   - Un-overridable window capture hotkey **`Ctrl+Shift+Alt+R`** (`Cmd+Shift+Alt+R` on macOS), desktop CLI flag **`--safe-mode`** (injects `window.__QIANJI_SAFE_MODE__ = true` via Tauri init script; second launch with `--safe-mode` reloads the main window into Safe Mode), URL query **`?safeMode=1`**, or `sessionStorage["qianji:safe-mode"]`.
   - Immediately pauses all `user` and `workspace` external client plugins while keeping the built-in core layer running and mounting `<SafeModeBanner />` outside `<SlotRoot />`.

---

## 7. Backend `agent-loop` Overridability

On the Host plane (`packages/host/src/agent-plugins.ts`), `corePlugins()` contains only **7 pure in-memory buses** (`Credentials`, `LlmService`, `Sessions`, `Ui`, `Tools`, `Commands`, `SystemPrompt`). The Agent execution engine lives in `builtinPluginDefinitions()` as `id: "agent-loop"` (`provides: ["agents"]`, `canDisable: false`, `canOverride: true`).

A user or trusted workspace plugin can replace Qianji's entire Agent loop by shipping a Host plugin with `"id": "agent-loop"` and `"provides": ["agents"]` (disabling or removing the override immediately restores built-in `AgentLoop`):

```json
{
  "name": "custom-agent-loop",
  "version": "0.1.0",
  "qianji": {
    "id": "agent-loop",
    "name": "Custom Agent Loop",
    "host": "./index.ts",
    "inject": ["llm", "sessions", "tools", "systemPrompt"],
    "provides": ["agents"]
  }
}
```

> Inside the repository itself, `@qianji/agent-loop` remains importable only by `@qianji/host` (`tests/test-package-boundaries.test.ts`); external override plugins implement the `@qianji/agent` contract directly against `ctx.llm`, `ctx.sessions`, `ctx.tools`, and `ctx.systemPrompt`.

---

## 8. Backward-Compatible `ctx.contributions` (All 22 APIs) & Legacy SDK

All 22 `ctx.contributions` methods (inject `["contributions"]`) remain **100% backward-compatible** and auto-dispose on reload or disable. Existing plugins need zero migration; Qianji mirrors every contribution into `ctx.slots` automatically.

### 8.1 Quick `ctx.contributions` Client Entry Example

```tsx
import type { Context } from "@deepseek-ai/cordis";
import { Database } from "lucide-react";
import { useActiveSession, useHostRpcQuery, openWorkbenchTab } from "@qianji/client";

function SqliteWorkbenchPanel() {
  const { cwd } = useActiveSession();
  const { data, loading, error, refetch } = useHostRpcQuery<{ tables: string[] }>(
    "sqlite_explorer.listTables",
    { cwd },
  );
  if (loading) return <div>Loading tables…</div>;
  if (error) return <div>Error: {error}</div>;
  return (
    <div className="sqlite-panel">
      <button type="button" onClick={() => void refetch()}>Refresh</button>
      <ul>{(data?.tables ?? []).map((t) => <li key={t}>{t}</li>)}</ul>
    </div>
  );
}

export const name = "sqlite-explorer-client";
export const inject = ["contributions", "styles"];

export function apply(ctx: Context): void {
  ctx.contributions.registerRightWorkbenchTab({
    id: "sqlite-explorer-tab",
    label: "SQLite",
    icon: <Database size={13} />,
    render: () => <SqliteWorkbenchPanel />,
  });

  ctx.contributions.registerTopbarAction({
    id: "sqlite-explorer-open",
    render: () => (
      <button type="button" onClick={() => openWorkbenchTab("sqlite-explorer-tab")}>
        SQLite
      </button>
    ),
  });
}
```

### 8.2 Complete 22 `ctx.contributions` Reference

| Slot Name | Registration Method | Key Options | `render(ctx)` / Callback Arguments |
| :--- | :--- | :--- | :--- |
| `pages` | `ctx.contributions.registerPage` | `{ id, label, icon?, order?, render }` | `{ cwd, sessionFile }` |
| `leftSidebar` | `ctx.contributions.registerLeftSidebar` | `{ id, order?, render }` | `{ cwd, sessionFile }` |
| `rightWorkbenchTabs` | `ctx.contributions.registerRightWorkbenchTab` | `{ id, label, icon?, order?, render }` | `{ cwd, sessionFile }` |
| `bottomPanelTabs` | `ctx.contributions.registerBottomPanelTab` | `{ id, label, icon?, order?, render }` | `{ cwd, sessionFile }` |
| `topbarActions` | `ctx.contributions.registerTopbarAction` | `{ id, order?, render }` | `{ cwd, sessionFile }` |
| `composerToolbar` | `ctx.contributions.registerComposerToolbar` | `{ id, order?, render }` | `{ cwd, sessionFile, variant }` |
| `composerStatus` | `ctx.contributions.registerComposerStatus` | `{ id, position?: "before-model" \| "after-model", order?, render }` | `{ cwd, sessionFile, variant }` |
| `composerBanners` | `ctx.contributions.registerComposerBanner` | `{ id, order?, render }` | `{ cwd, sessionFile, variant }` |
| `overlays` | `ctx.contributions.registerOverlay` | `{ id, order?, render }` | `{ cwd, sessionFile }` |
| `message.actions` | `ctx.contributions.registerMessageAction` | `{ id, role?: "user" \| "assistant" \| "both", order?, render }` | `{ cwd, sessionFile, message, contentText }` |
| `message.toolRenderer` | `ctx.contributions.registerToolRenderer` | `{ id, toolNames: string[], order?, render }` | `{ cwd, sessionFile, call, state }` |
| `file.viewer` | `ctx.contributions.registerFileViewer` | `{ id, label?, extensions?: string[], mimeTypes?: string[], order?, render }` | `{ cwd, sessionFile, path, content, isBinary, mimeType, dataBase64, size }` |
| `status.bar` | `ctx.contributions.registerStatusBarItem` | `{ id, align?: "left" \| "right", order?, render }` | `{ cwd, sessionFile }` |
| `home.quickActions` | `ctx.contributions.registerHomeQuickAction` | `{ id, label?, icon?, prompt?, order?, onSelect?, render? }` | `{ cwd, sessionFile, prefillComposer, sendPrompt }` |
| `slashInterceptors` | `ctx.contributions.registerSlashInterceptor` | `{ id, order?, onSlashCommand }` | `(name, rawArgs, { cwd, sessionFile }) => boolean \| Promise<boolean>` |
| `rewindHandlers` | `ctx.contributions.registerRewindHandler` | `{ id, order?, onRewindMessage, onOpenTimeline? }` | `(message: UiMessage) => boolean \| Promise<boolean>` |
| `settings.pages` | `ctx.contributions.registerSettingsPage` | `{ id, label, icon?, heading?, subtitle?, order?, wide?, render }` | `{ cwd, sessionFile, page, closeSettings }` |
| `settings.sections` | `ctx.contributions.registerSettingsSection` | `{ id, page, title?, order?, render }` | `{ cwd, sessionFile, page, closeSettings }` |
| `menus` | `ctx.contributions.registerMenuItem` | `{ id, location, label, icon?, shortcut?, order?, danger?, when?, disabled?, onSelect }` | depends on `location` (see below) |
| `keybindings` | `ctx.contributions.registerKeybinding` | `{ id, key, label?, order?, allowInEditable?, run }` | `{ cwd, sessionFile }` |
| `markdown.codeBlock` | `ctx.contributions.registerCodeBlockRenderer` | `{ id, languages: string[], order?, render }` | `{ cwd, sessionFile, language, code }` |
| `themes` | `ctx.contributions.registerTheme` | `{ id, label, mode, scope?, sourcePath?, palette? }` | Registers an `AppearanceThemeDefinition` |

### 8.3 High-Value Contribution Patterns

- **Custom Tool Card (`message.toolRenderer`)**: Render rich UI for your plugin's tools (supports exact names or prefix wildcards like `"sqlite_*"`) without touching host message renderers:
  ```tsx
  import type { Context } from "@deepseek-ai/cordis";

  export function registerSqliteCard(ctx: Context): void {
    ctx.contributions.registerToolRenderer({
      id: "sqlite-query-card",
      toolNames: ["sqlite_query", "sqlite_*"],
      render: ({ call, state }) => (
        <div className="sqlite-card">
          <strong>{call.name} ({state})</strong>
          <pre>{typeof call.result === "string" ? call.result : JSON.stringify(call.args)}</pre>
        </div>
      ),
    });
  }
  ```
- **Custom File Viewer (`file.viewer`)**: Render binary or domain files (`.sqlite`, `.xlsx`, `.mermaid`, `.glb`) inside the Right Workbench editor/preview pane:
  ```tsx
  import type { Context } from "@deepseek-ai/cordis";

  export function registerMermaidViewer(ctx: Context): void {
    ctx.contributions.registerFileViewer({
      id: "mermaid-viewer",
      label: "Mermaid Diagram",
      extensions: [".mmd", ".mermaid"],
      render: ({ path, content, size }) => (
        <div className="mermaid-preview">
          <h4>{path} ({size} bytes)</h4>
          <pre>{content}</pre>
        </div>
      ),
    });
  }
  ```

### 8.4 Settings, Menus, Shortcuts & Markdown Fences

- **Settings pages (`settings.pages`)**: Each page gets an entry under the collapsible **扩展** group in the Settings left sidebar (`plugin:<id>`; becomes searchable automatically at 6+ extension pages). Call `openSettingsPage("<id>")` to open Settings directly on that page (`"general"`, `"appearance"`, `"providers"`, `"plugins"`, `"slots"`, or your plugin page id). Pages use the narrow column (`740px`) by default; set `wide: true` for card grids. Registering a Settings page automatically hides the duplicate inline **配置** button on the plugin's card under **扩展插件** so configuration has a single conflict-free owner (use `configSchema` alone for lightweight inline options, or `registerSettingsPage` for a full custom Settings page).
- **Settings sections (`settings.sections`)**: Each section is a titled card appended to a page. Set `page` to a built-in page (`"general" | "appearance" | "providers" | "plugins"`) or to the `id` of a plugin settings page. Store values with your plugin's `configSchema` and `usePluginConfig`, or through your own Host RPC methods.
- **Menu items (`menus`)**: The `location` field picks the menu and the context type:

  | `location` | Menu | Callback context |
  | :--- | :--- | :--- |
  | `menubar.file` / `menubar.edit` / `menubar.view` / `menubar.help` | Window menubar | `{ cwd, sessionFile }` |
  | `menubar.tools` | Extra **工具** menubar menu, shown only while it has items | `{ cwd, sessionFile }` |
  | `thread.more` | Thread title "…" menu in the top bar | `{ cwd, sessionFile }` |
  | `sidebar.project` | Project "…" menu in the left sidebar | `{ workspace, sessionFiles }` |
  | `sidebar.thread` | Right-click menu on a session row in the left sidebar | `{ cwd, sessionFile, title }` (the row's session, not the active one) |
  | `file.context` | Right-click menu on file paths (transcript links, tool cards, workbench file tree) | `{ cwd, sessionFile, path, absolutePath, line? }` |

  `when` hides an item and `disabled` greys it out. If `when`, `disabled` or `onSelect` throws, the error is reported as the plugin's `clientError`; it never breaks the host menu. `shortcut` is only a hint; pair it with `registerKeybinding`.
- **Keybindings (`keybindings`)**: `key` takes chords such as `"Ctrl+Shift+K"`, `"Alt+F2"` or `"F6"` (`Cmd`/`Meta` count as `Ctrl`). Safe Mode (`Ctrl+Shift+Alt+R`), built-in shortcuts, and keys already handled by the composer, code editor or terminal always win. Bindings also stay quiet in text fields unless `allowInEditable: true`.
- **Markdown fences (`markdown.codeBlock`)**: `languages` claims fence languages (case-insensitive) in chat Markdown. A plugin renderer runs before the built-in Mermaid/PlantUML diagrams, so it can replace them. `qianji-rich` and `intelligent-ui` fences stay with the host.

```tsx
import type { Context } from "@deepseek-ai/cordis";
import { Sparkles } from "lucide-react";
import { openPluginPage, openSettingsPage, openWorkspaceFile } from "@qianji/client";

export function registerChrome(ctx: Context): void {
  ctx.contributions.registerSettingsPage({
    id: "cloud-sync",
    label: "云同步",
    icon: <Sparkles size={15} />,
    subtitle: "跨设备同步会话与偏好",
    render: ({ closeSettings }) => <button type="button" onClick={closeSettings}>完成</button>,
  });
  ctx.contributions.registerSettingsSection({
    id: "cloud-sync-shortcut",
    page: "general",
    title: "云同步",
    render: () => <button type="button" onClick={() => openSettingsPage("cloud-sync")}>打开云同步设置</button>,
  });
  ctx.contributions.registerMenuItem({
    id: "reveal-line",
    location: "file.context",
    label: "在编辑器中跳到该行",
    when: ({ line }) => line !== undefined,
    onSelect: ({ path, line }) => openWorkspaceFile(path, line),
  });
  ctx.contributions.registerMenuItem({
    id: "open-board",
    location: "menubar.tools",
    label: "任务看板",
    shortcut: "Ctrl+Alt+K",
    onSelect: () => { openPluginPage("board"); },
  });
  ctx.contributions.registerKeybinding({
    id: "open-board-key",
    key: "Ctrl+Alt+K",
    run: () => { openPluginPage("board"); },
  });
  ctx.contributions.registerCodeBlockRenderer({
    id: "csv-table",
    languages: ["csv"],
    render: ({ code }) => (
      <table>
        <tbody>
          {code.split("\n").map((row, index) => (
            <tr key={index}>{row.split(",").map((cell, col) => <td key={col}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    ),
  });
}
```

### 8.5 Summary `@qianji/client` Hooks, Controlled Actions & `dsh-better-sidebar`

#### Read-Only Summary Hooks
- `useActiveSession()` → `{ sessionId, sessionFile, cwd, isStreaming, isCompacting, model, stats, messageCount }`
- `useActiveWorkspace()` → `{ cwd, connected, hostConnected }`
- `useAppearanceTheme()` → `{ themeId, resolvedScheme: "light" | "dark", accentColor }`
- `usePluginConfig<T>(pluginId, fallback?)` → Reactive plugin configuration object synced with Settings → Plugins.
- `useHostRpcQuery<T>(method, params?, { enabled?, refreshIntervalMs? })` → `{ data, loading, error, refetch }`.

#### Controlled Host Actions
- `callHostRpc<T>(method, params?)` → Invoke any Host JSON-RPC method (`ctx.rpc.method(...)`).
- `openWorkbenchTab(tabId)` → Open Right Workbench and focus `tabId` (built-in or custom plugin tab ID; also reachable from Host tools via `sidebar_open`).
- `openWorkspaceFile(path, line?)` → Open a file in Right Workbench Code Editor / Custom File Viewer (optionally jumping to 1-based `line`).
- `sendChatPrompt(text, { prefillOnly?, attachments?, behavior? })` → Prefill Composer or send a message in the active session.
- `showToast(message, kind?)` → Non-blocking toast (`"info" | "success" | "warning" | "error"`).
- `openSettingsPage(pageId?)` → Open Settings on a built-in page (`"general"`, `"appearance"`, `"providers"`, `"plugins"`, `"slots"`) or a `registerSettingsPage` id. Returns `false` before the shell has mounted.
- `openPluginPage(pageId)` → Show a `registerPage` page in the main stage (closes Settings if open).
- `getActiveSessionSnapshot()` / `subscribeSessionActivity(listener)` → Synchronous read & activity subscription without touching internal stores.

#### `dsh-better-sidebar` Compatibility
Client-only plugins migrating from DSH can declare `export const inject = ["betterSidebar"]` and call `ctx.betterSidebar.registerTab({ id, title, icon, component })` or `ctx.betterSidebar.registerFileViewer(...)` — Qianji maps them directly into `rightWorkbenchTabs` / `bottomPanelTabs` / `file.viewer`.
