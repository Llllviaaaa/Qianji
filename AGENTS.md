# Qianji (千机) — Repository Engineering & Agent Guidelines

This document defines the architectural invariants, extension workflows, frontend UI/CSS rules, and verification gates for contributors and coding agents working inside this repository.

---

## 1. Three-Plane Architecture & Module Boundaries ([ADR 0005](docs/adr/0005-repository-layout.md))

Qianji runs across three strictly separated planes that do **not** share memory or module graphs:

1. **Desktop Shell (`src-tauri/`)**: Tauri 2 Rust process managing native windows, WebView guards ([`webview_guard.rs`](src-tauri/src/webview_guard.rs)), OS keychain secrets, and `settings.json` persistence ([`config.rs`](src-tauri/src/config.rs)).
2. **Harness Host (`packages/*`)**: Bun-compiled sidecar (`qianji-harness`) running Cordis services (`@qianji/tools`, `@qianji/commands`, `@qianji/permissions`, `@qianji/prompt-context`, `@qianji/system-prompt`, `@qianji/session`, `@qianji/agent`, `@qianji/host`).
3. **React 19 Renderer (`src/`)**: Vite webview UI communicating with Harness Host over JSON-RPC / WebSocket.

**Hard Import Invariants**:
- Code under `src/` may **only** import `@qianji/protocol` from `@qianji/*` and must **never** import `packages/*` by path (enforced by [`eslint.config.js`](eslint.config.js)).
- Package layering inside `packages/*` (enforced by [`tests/test-package-boundaries.test.ts`](tests/test-package-boundaries.test.ts)):
  - Contract packages (`agent`, `commands`, `kernel`, `llm`, `protocol`, `rpc`, `session`, `system-prompt`, `tools`, `ui`) import only other contract packages.
  - Implementation/feature packages import contracts only; a dependency on another implementation must be added to `IMPLEMENTATION_EDGES` in that test with its reason.
  - Only `@qianji/host` imports `@qianji/agent-loop`; `@qianji/testkit` is for `test/` only.
  - Every `@qianji/*` imported from a package's `src/` is listed in its `dependencies`, relative imports in `src/` never leave the package, nothing under `packages/` imports `src/` or `src-tauri/` by path, and the package graph has no cycles.

---

## 2. Prefer Plugins First, Frontend Microkernel & Agent Closed-Loop Workflow ([ADR 0016](docs/adr/0016-dynamic-plugins-and-hmr.md), [ADR 0023](docs/adr/0023-frontend-microkernel-and-core-pluginization.md))

Before editing core workbench components, check whether the capability belongs in a hot-pluggable plugin or a one-off `render_ui` widget:

- **Ephemeral turn visualization / interactive form**: Use `render_ui`.
- **Persistent UI, core slot override, global skin, or Host capability** (workbench tab, file viewer, message action/card, status bar item, settings page/section, menu item, keybinding, Markdown fence renderer, slash command, custom tool, replacing core UI regions via `ctx.slots`, or overriding backend `agent-loop`): Build a Qianji plugin following [`skills/qianji-plugin-development/SKILL.md`](skills/qianji-plugin-development/SKILL.md).
- **5-Step Agent Plugin Loop**:
  1. Read [`skills/qianji-plugin-development/SKILL.md`](skills/qianji-plugin-development/SKILL.md) (plus targeted files in [`skills/qianji-plugin-development/references/`](skills/qianji-plugin-development/references/client-slots-and-sdk.md)).
  2. Call `qianji_inspect` (`readOnly: true`) to query live `services`, `client_slots`, `slot_tree`, `frontend_services`, `slot_owners`, `primitives`, `theme_tokens`, `shared_modules`, `rpc_methods`, or `plugins`.
  3. Activate `plugin_dev` (`activate_tools` -> `plugin_manager`) and `scaffold` from `tool-only`, `ui-slot-widget`, `fullstack-panel`, `core-override`, or `global-skin`.
  4. Run `plugin_manager(action: "verify")` (validates manifest, Host imports, and `ClientBundleRegistry.compile` with zero config side effects) and `tsc --noEmit` against generated `plugin-types/`.
  5. Run `plugin_manager(action: "install_local")` (`link: true, watch: true`) and inspect `qianji_inspect(topic: "plugins")` to confirm `clientError` and `error` are empty.

**Plugin Trust Model ([ADR 0017](docs/adr/0017-plugin-trust-model.md))**: An enabled plugin is fully trusted. It runs in the Host process and event loop (or in the main WebView), with no sandbox and no capability allowlist. The manifest has **no** `permissions` field; do not add one or describe one as a protection. Fiber isolation contains thrown errors only, not synchronous hangs.

**Frontend Microkernel, Parity & Core Overridability ([ADR 0023](docs/adr/0023-frontend-microkernel-and-core-pluginization.md))**:
- **Microkernel & Built-in Core Plugin Parity**: `src/kernel/` provides the typed slot engine ([`coreSlotMap.ts`](src/kernel/slots/coreSlotMap.ts), 46 canonical core slots), managed store seats ([`src/kernel/store/index.ts`](src/kernel/store/index.ts)), 11 frontend domain Cordis services ([`src/kernel/services/index.ts`](src/kernel/services/index.ts)), frozen public UI primitives ([`src/kernel/primitives/index.ts`](src/kernel/primitives/index.ts)), and [`BuiltinCorePluginCoordinator`](src/kernel/runtime/builtinCorePlugins.ts). Built-in core and feature plugins under `src/builtin-plugins/*` are mechanically held to external-plugin parity by [`eslint.config.js`](eslint.config.js): they may only import shared contracts (`@qianji/client-slots`, `@qianji/client-store`, `@qianji/client-primitives`, `@qianji/client`, `@qianji/protocol`, `react`, `lucide-react`, `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`), never `src/store/*`, `src/stores/*`, `src/lib/*`, `src/kernel/services/*`, or sibling plugins via `../`.
- **Strict Internal vs. External Decoupling**:
  - **Host-internal UI (`src/components/ui/`)**: Internal primitives (`Button`, `Dialog`, `Tabs`, `Select`, `Switch`, `Input`, `Badge`, `Tooltip`) for host screens only. Feel free to refactor props internally.
  - **Shared Client Contracts (`@qianji/client`, `@qianji/client-slots`, `@qianji/client-store`, `@qianji/client-primitives`)**: Frontend-local aliases resolving inside `src/` (preserving ADR 0005's rule that `@qianji/protocol` is the only package imported from `packages/*`), exposing SemVer-stable public contracts via [`src/sdk/index.ts`](src/sdk/index.ts), [`src/kernel/slots/index.ts`](src/kernel/slots/index.ts), [`src/kernel/store/index.ts`](src/kernel/store/index.ts), and [`src/kernel/primitives/index.ts`](src/kernel/primitives/index.ts). Never expose raw internal Zustand slices to new plugins; when changing public client contracts, update [`scripts/generate-plugin-types.mjs`](scripts/generate-plugin-types.mjs) / [`scripts/plugin-types-client-kernel.mjs`](scripts/plugin-types-client-kernel.mjs) and run `node scripts/generate-plugin-types.mjs`.
- **Safe Mode, Abdication & Backend `agent-loop` Override**:
  - **Abdication Fallback ([`abdication.ts`](src/kernel/slots/abdication.ts))**: Throwing `single` / `keyed` / `chain` / factory slot entries automatically `abdicate` and fall back to the next eligible candidate (down to the built-in core plugin), unlocking on `(etag, configKey, reloadEpoch)` updates.
  - **Safe Mode ([`safeMode.ts`](src/kernel/runtime/safeMode.ts), [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs))**: Un-overridable window capture hotkey `Ctrl+Shift+Alt+R` (`Cmd+Shift+Alt+R` on macOS), desktop CLI `--safe-mode`, or `?safeMode=1` immediately pauses all `user`/`workspace` external client plugins and mounts only the built-in core layer alongside an un-overridable `<SafeModeBanner />`.
  - **Backend `agent-loop` Overridability ([`agent-plugins.ts`](packages/host/src/agent-plugins.ts))**: `corePlugins()` retains only 7 pure in-memory buses; `agent-loop` lives in `builtinPluginDefinitions()` (`canDisable: false, canOverride: true`, providing `"agents"`), so external plugins with `id: "agent-loop"` can replace the Agent execution loop while preserving the `@qianji/host`-only import boundary on `@qianji/agent-loop`.

---

## 3. Frontend UI, CSS Cascade & React Rules

1. **CSS `@layer` Order, Global Skin Channel & Legacy Watermark ([`src/styles/index.css`](src/styles/index.css))**:
   - Authoritative cascade order: `@layer theme, base, plugin-ui, legacy, skin, components, plugin-skin, utilities;`.
   - Default plugin styles via `ctx.styles.inject()` or `import "./style.css"` stay wrapped in `@layer plugin-ui { @scope ([data-qj-plugin="<id>"]) { ... } }` below host `legacy`, `skin`, and `components`, preventing accidental host pollution.
   - Opt-in global skin styles via `ctx.styles.injectGlobal()` or `import "./skin.global.css"` ([`pluginStyles.ts`](src/kernel/runtime/pluginStyles.ts), [`client-bundles.ts`](packages/host/src/client-bundles.ts)) compile into unscoped `@layer plugin-skin { ... }` (above `legacy`/`skin`/`components`, below Tailwind `utilities`) and automatically clean up or roll back on plugin unload/HMR.
   - `overlays` / `shell.overlays` slot root enforces `pointer-events: none` so floating widgets/pets never block the main window; interactive children opt in with `pointer-events: auto`.
   - **Never add new rules to [`src/styles.css`](src/styles.css)** (locked by a monotonically non-increasing line watermark in [`tests/test-architecture-guardrails.test.ts`](tests/test-architecture-guardrails.test.ts)). Author new host styles in `@layer components` using `--qj-*` semantic tokens from [`src/styles/tokens.css`](src/styles/tokens.css).
2. **Fault-Isolated Slot Rendering**:
   - **Never** call `entry.render(ctx)` directly in JSX (forbidden by `eslint.config.js`). Always mount plugin contributions through [`<PluginSlot>`](src/components/common/PluginSlot.tsx) / [`<SlotEntryHost>`](src/components/common/ErrorBoundary.tsx) (legacy `ctx.contributions`) or [`<SlotRoot>` / `<SlotHost>` / `renderSlot` / `renderSlotChain` / `renderFactory`](src/kernel/slots/renderer.tsx) (`@qianji/client-slots`) so synchronous throws and React Hooks stay isolated inside a dedicated child Fiber with automatic abdication and Reload/Disable recovery.
3. **Component Size Budgets**:
   - The 7 top-level shell/panel entry files (`src/App.tsx`, `PluginsSettingsPanel.tsx`, `ModelsPage.tsx`, `IntelligentUiCard.tsx`, `Sidebar.tsx`, `Message.tsx`, `Composer.tsx`) must remain **`<= 350` physical lines** each.
   - Modular subdirectories (`src/components/{ui,plugins,models,shell,intelligent-ui,sidebar,message,composer}/**`) enforce ESLint **`max-lines: 400`** (excluding blank lines and comments).
   - Every other `.ts`/`.tsx` file under `src/` and `packages/*/src` stays within **500 physical lines**. Files that were already larger are frozen at their ceilings in [`tests/test-file-size-ratchet.test.ts`](tests/test-file-size-ratchet.test.ts). Split them instead of growing them, and lower the ceiling (or drop the entry) when they shrink.
4. **React Hooks & TypeScript Hygiene (`eslint.config.js`)**:
   - Zero `!` non-null assertions (`@typescript-eslint/no-non-null-assertion: "error"`).
   - Strict `===` equality (`eqeqeq: ["error", "always", { null: "ignore" }]`).
   - Never call `setState` synchronously inside `useEffect` (`react-hooks/set-state-in-effect: "error"`): use TanStack Query ([`src/lib/queries.ts`](src/lib/queries.ts)) for async backend state and [`useSyncOnChange`](src/hooks/useSyncOnChange.ts) when local state tracks a prop change.
   - Do not return `RefObject` instances inside composite state objects from custom hooks; declare DOM refs in the component and pass them into hooks to satisfy `react-hooks/refs`.

---

## 4. Tri-End `AppSettings` Modification Checklist

Whenever adding or renaming a desktop setting, update **all five** locations together (verified by [`tests/test-appsettings-alignment.test.ts`](tests/test-appsettings-alignment.test.ts)):

1. [`packages/protocol/src/app-settings.ts`](packages/protocol/src/app-settings.ts) — Add field to `AppSettings` interface, `DEFAULT_APP_SETTINGS`, and `APP_SETTINGS_KEYS`.
2. [`src-tauri/src/config.rs`](src-tauri/src/config.rs) — Add corresponding `#[serde(default = "...")]` field to `pub struct AppSettings` and `impl Default for AppSettings` under `#[serde(rename_all = "camelCase")]` so Rust never silently drops the field on save.
3. [`packages/host/src/desktop-settings.ts`](packages/host/src/desktop-settings.ts) — Wire runtime synchronization into `harness.json` / Host state if the Host consumes the setting.
4. [`src/components/SettingsModal.tsx`](src/components/SettingsModal.tsx) (and [`src/types.ts`](src/types.ts) re-exports) — Expose or preserve the field in `DEFAULT_SETTINGS` and settings UI.
5. [`tests/test-appsettings-alignment.test.ts`](tests/test-appsettings-alignment.test.ts) — Run Vitest to confirm 1:1 camelCase ↔ snake_case key parity across Protocol, Rust, and React.

---

## 5. Verification Commands

Run these checks before completing changes:

```bash
node scripts/generate-plugin-types.mjs   # Refresh offline plugin .d.ts declarations when SDK/protocol changes
npm run typecheck                        # Workspace-wide TypeScript check
npm run lint                             # ESLint (ADR 0005 boundaries, slot .render() gate, max-lines, React Hooks)
npm test                                 # Full Vitest suite (unit, fault-isolation, CSS @scope, guardrails)
npm run test:doc-links                   # Verify all local Markdown links resolve
npm run test:public-hygiene              # Version, CSP, and bundle resource hygiene checks
```
