---
name: qianji-plugin-development
description: Develop, verify, and hot-reload Qianji Desktop plugins (Host tools/RPC, `agent-loop` overrides, typed `ctx.slots` core UI overrides, `ctx.contributions` extensions, `*.global.css` skins, themes, and pets). Use when extending Qianji or overriding core UI/agent behavior.
---

# Qianji Plugin Development

Dual-plane `@deepseek-ai/cordis` microkernel + optional companion skills:
- **Host (`index.ts`)**: tools, JSON-RPC, commands, prompts, HTTP routes, same-ID overrides (incl. `agent-loop`).
- **Client (`client.tsx`)**: React 19 UI on typed **`ctx.slots`** (46 core slots) & **`ctx.contributions`** (22 APIs), 11 frontend services, `@qianji/client-{slots,store,primitives}`, `--qj-*` tokens.
- **Companion Skills (`skills/<name>/SKILL.md`)**: read-only Agent Skills & `/skill:<name>` commands.

## 1. Capability Routing

| User Goal | Mechanism |
| :--- | :--- |
| One-off chart, calculator, or form in current chat | Call **`render_ui`** directly (no plugin). |
| Workbench tab, status widget, action, viewer, command, or tool | Plugin (`tool-only` / `ui-slot-widget` / `fullstack-panel`, optional `skills/`). |
| Bot Connector (4-tier permissions, approvals & patrol, optional Agent sharing) | **Connector Plugin** (`template: "connector"`, `qianji.{targets,connectors}` + `ctx.connectors.register()`). |
| Replace/wrap core UI (composer, messages, sidebar, workbench, settings) | **Core Override** (`template: "core-override"`) via `ctx.slots` (`single`/`chain`/`overlay`/`wrap`) or same-ID. |
| Restyle global host chrome beyond tokens | **Global Skin** (`template: "global-skin"`) via `*.global.css` / `ctx.styles.injectGlobal()`. |
| Replace backend Agent execution loop | Host plugin with `qianji.id: "agent-loop"` & `provides: ["agents"]`. |
| Settings page/card, menu, shortcut, or code fence | `ctx.contributions` (`registerSettingsPage`/`SettingsSection`/`MenuItem`/`Keybinding`/`CodeBlockRenderer`) or `ctx.slots`. |
| Custom color theme or desktop pet pack | [references/appearance-and-pets.md](references/appearance-and-pets.md). |

## 2. Mandatory 5-Step Workflow

1. **Inspect & activate `plugin_dev`** (`readOnly`): call `qianji_inspect` (`topic: "all" | "services" | "client_slots" | "slot_tree" | "frontend_services" | "slot_owners" | "primitives" | "shared_modules" | "theme_tokens" | "rpc_methods" | "plugins"`) and `activate_tools(names: ["plugin_dev"])`. Never guess APIs or tokens.
2. **Scaffold**: `plugin_manager(action: "scaffold", id: "<kebab-id>", template: "tool-only" | "ui-slot-widget" | "fullstack-panel" | "connector" | "core-override" | "global-skin")`. Never edit templates in place.
3. **Verify** (`readOnly`): `plugin_manager(action: "verify", dir: "<dir>")` until `ok: true`.
4. **Install with HMR**: `plugin_manager(action: "install_local", dir: "<dir>", link: true, watch: true)`.
5. **Check status**: `qianji_inspect(topic: "plugins", pluginId: "<kebab-id>")` — confirm `status === "active"`, no `error`/`clientError`.

## 3. Guardrails

- **Client Imports**: Shared externals (`react`, `react/jsx-runtime`, `react-dom`, `lucide-react`, `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@qianji/client`, `@qianji/client-slots`, `@qianji/client-store`, `@qianji/client-primitives`, `@qianji/protocol`, `dsh-better-sidebar`) and local relative files only. Never import `src/*` or raw stores.
- **CSS `@layer` & Skins**: Order `theme, base, plugin-ui, legacy, skin, components, plugin-skin, utilities`. Default `ctx.styles.inject()` / `import "./style.css"` wraps in `@layer plugin-ui { @scope ([data-qj-plugin="<id>"]) { ... } }`; `injectGlobal()` / `*.global.css` targets `@layer plugin-skin` with auto-cleanup on unload/HMR.
- **Ownership, Abdication & Safe Mode**: Precedence `slotOverrides > workspace > user > builtin > priority > order`. Throwing overrides auto-abdicate. Safe Mode (`Ctrl+Shift+Alt+R` / `--safe-mode` / `?safeMode=1`) pauses external plugins.
- **Overlays & Cleanup**: `shell.overlays` / `.plugin-overlays-host` sets `pointer-events: none` (opt in with `pointer-events: auto` on visible cards). Wrap timers/watchers in `ctx.effect(() => () => cleanup())`.

## 4. Read Next

| Topic | Path |
| :--- | :--- |
| Manifest, `configSchema`, Host tools/RPC/commands | [references/manifest-and-host.md](references/manifest-and-host.md) |
| `ctx.slots`, 11 services, primitives, stores, skins, Safe Mode, `agent-loop` & `ctx.contributions` | [references/client-slots-and-sdk.md](references/client-slots-and-sdk.md) |
| `@layer` + `@scope` rules & `--qj-*` tokens | [references/styling-and-tokens.md](references/styling-and-tokens.md) |
| Custom themes & desktop pet overlays | [references/appearance-and-pets.md](references/appearance-and-pets.md) |
| Templates | [templates/tool-only/package.json](templates/tool-only/package.json), [templates/ui-slot-widget/client.tsx](templates/ui-slot-widget/client.tsx), [templates/fullstack-panel/index.ts](templates/fullstack-panel/index.ts), plus `scaffold` (`core-override`, `global-skin`) |
