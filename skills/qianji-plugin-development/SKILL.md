---
name: qianji-plugin-development
description: Develop, verify, and hot-reload Qianji Desktop plugins (Host tools, JSON-RPC methods, backend `agent-loop` overrides, typed `ctx.slots` core UI overrides, backward-compatible `<PluginSlot>` / `ctx.contributions` extensions, frontend Cordis services, `@qianji/client-primitives`, `*.global.css` global skins, file viewers, appearance themes, and desktop pets). Use when extending Qianji, overriding core UI/agent behavior, building or debugging plugins, or customizing themes, skins, and pets.
---

# Qianji Plugin Development

Qianji uses a dual-plane `@deepseek-ai/cordis` microkernel plus optional companion skills:
- **Host plane** (`index.ts`, Node/Bun): tools, JSON-RPC methods, commands, prompts, HTTP routes, and same-ID overrides of built-in Host plugins (including `agent-loop`).
- **Client plane** (`client.tsx`, React 19): fault-isolated UI on Qianji's typed **`ctx.slots`** microkernel (`@qianji/client-slots`, 46 canonical core slots) and backward-compatible **`ctx.contributions`** (22 APIs), powered by 11 frontend domain Cordis services, `@qianji/client`, `@qianji/client-store`, `@qianji/client-primitives`, and `--qj-*` tokens.
- **Companion Skills** (`skills/<name>/SKILL.md`): optional read-only Agent Skills & `/skill:<name>` commands (`host`/`client` optional).

## 1. Capability Routing (Decide Before Coding)

| User Goal | Mechanism |
| :--- | :--- |
| One-off calculator, chart, dashboard, or form in current chat | Call **`render_ui`** directly. Do **not** scaffold a plugin. |
| Workbench tab, status widget, message action, file viewer, command, or Host tool | Build a **Qianji Plugin** (`tool-only` / `ui-slot-widget` / `fullstack-panel`, optionally with `skills/`). |
| Replace or wrap core UI (composer, messages, sidebar, topbar, workbench, settings) or expose nested child slots | Build a **Core Override Plugin** (`template: "core-override"`) using `ctx.slots` (`single`/`chain`/`overlay`/`wrap`) or a same-ID override of a built-in core plugin. |
| Restyle global host chrome beyond palette tokens | Build a **Global Skin Plugin** (`template: "global-skin"`) using `*.global.css` / `ctx.styles.injectGlobal()` (`@layer plugin-skin`). |
| Replace or customize the backend Agent execution loop | Build a Host plugin with `qianji.id: "agent-loop"` and `provides: ["agents"]`. |
| Bundled skill playbook (`SKILL.md`) toggled with a plugin | Add `skills/<name>/SKILL.md` (see [references/manifest-and-host.md](references/manifest-and-host.md)). |
| Settings page/card, menu command, global shortcut, or Markdown fence renderer | Plugin with `ctx.contributions.registerSettingsPage` / `SettingsSection` / `MenuItem` / `Keybinding` / `CodeBlockRenderer` (or typed `ctx.slots`). |
| Custom color theme or desktop pet sprite pack | Build an **Appearance Extension** ([references/appearance-and-pets.md](references/appearance-and-pets.md)). |

## 2. Mandatory 5-Step Workflow

1. **Inspect contracts & activate `plugin_dev` first** (`readOnly`):
   Call `qianji_inspect` (`topic: "all"` | `"services"` | `"client_slots"` | `"slot_tree"` | `"frontend_services"` | `"slot_owners"` | `"primitives"` | `"shared_modules"` | `"theme_tokens"` | `"rpc_methods"` | `"plugins"`) and `activate_tools(names: ["plugin_dev"])` to unlock `plugin_manager`. Never guess APIs, slot keys, or tokens.
2. **Scaffold in a writable folder**:
   Call `plugin_manager(action: "scaffold", id: "<kebab-id>", template: "tool-only" | "ui-slot-widget" | "fullstack-panel" | "core-override" | "global-skin")`. Never edit templates in place.
3. **Pre-flight verify before installing** (`readOnly`):
   Call `plugin_manager(action: "verify", dir: "<plugin-dir>")`. Fix all manifest, Host, and Client errors until `ok: true`.
4. **Link-install with live HMR**:
   Call `plugin_manager(action: "install_local", dir: "<plugin-dir>", link: true, watch: true)`.
5. **Check live status & `clientError`**:
   Call `qianji_inspect(topic: "plugins", pluginId: "<kebab-id>")`. Confirm `status === "active"`, `error === undefined`, and `clientError === undefined`. If `clientError` appears (`phase: "load" | "render"`), inspect its stack, fix `client.tsx` (HMR updates `clientEtag` and clears `clientError`), or call `plugin_manager(action: "reload", id: "<kebab-id>")`.

## 3. Architecture Guardrails

- **Allowed Client Imports**: Only shared externals (`react`, `react/jsx-runtime`, `react-dom`, `lucide-react`, `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@qianji/client`, `@qianji/client-slots`, `@qianji/client-store`, `@qianji/client-primitives`, `@qianji/protocol`, `dsh-better-sidebar`) and relative files inside the plugin directory. Never import internal `src/*` modules, Zustand stores, or `..` paths escaping the plugin folder.
- **CSS Cascade (`@layer`), Scoped CSS & Global Skin Channel**:
  - Authoritative order: `@layer theme, base, plugin-ui, legacy, skin, components, plugin-skin, utilities;`.
  - **Default scoped CSS**: `ctx.styles.inject(css, key?)` or `import "./styles.css"` auto-wraps in `@layer plugin-ui { @scope ([data-qj-plugin="<id>"]) { ... } }`. Use `--qj-*` variables for light/dark/skin parity.
  - **Opt-in global skin CSS**: `ctx.styles.injectGlobal(css, key?)` or `import "./skin.global.css"` compiles into unscoped `@layer plugin-skin { ... }` (above host `legacy`/`skin`/`components`, below Tailwind `utilities`) and auto-cleans/rolls back on unload or HMR.
- **Slot Ownership, Abdication & Safe Mode**: Core `single`/`chain`/`keyed` slots elect winners by `slotOverrides > workspace > user > builtin > priority > registrationOrder` (inspect & pin under Settings → **核心槽位与接管**). Any throwing core override automatically **abdicates** back to the built-in core plugin and recovers on the next `(etag, configKey, reloadEpoch)` cycle. Emergency **Safe Mode** (`Ctrl+Shift+Alt+R`, `Cmd+Shift+Alt+R` on macOS, `--safe-mode`, or `?safeMode=1`) pauses all external `user`/`workspace` client plugins while keeping the built-in core layer running.
- **Overlay Pointer Safety**: `.plugin-overlays-host` / `shell.overlays` sets `pointer-events: none`. Set `pointer-events: auto` only on visible floating cards, never on full-screen wrappers.
- **Fiber Cleanup**: `ctx.slots`, `ctx.contributions`, `ctx.styles`, and `@qianji/client-store` seats auto-dispose on unload. Wrap custom timers or watchers in `ctx.effect(() => () => cleanup())`.

## 4. Read Next

| Topic | Path |
| :--- | :--- |
| Manifest, `configSchema`, Host tools/RPC/commands | [references/manifest-and-host.md](references/manifest-and-host.md) |
| Typed `ctx.slots` microkernel, 11 frontend services, `@qianji/client-primitives`, `@qianji/client-store`, global skins, Safe Mode, `agent-loop` override & all 22 `ctx.contributions` APIs | [references/client-slots-and-sdk.md](references/client-slots-and-sdk.md) |
| `@layer` + `@scope` rules & `--qj-*` tokens | [references/styling-and-tokens.md](references/styling-and-tokens.md) |
| Custom themes & desktop pet overlays | [references/appearance-and-pets.md](references/appearance-and-pets.md) |
| Host tool template | [templates/tool-only/package.json](templates/tool-only/package.json), [templates/tool-only/index.ts](templates/tool-only/index.ts) |
| UI slot widget template | [templates/ui-slot-widget/package.json](templates/ui-slot-widget/package.json), [templates/ui-slot-widget/client.tsx](templates/ui-slot-widget/client.tsx) |
| Fullstack panel template | [templates/fullstack-panel/package.json](templates/fullstack-panel/package.json), [templates/fullstack-panel/index.ts](templates/fullstack-panel/index.ts), [templates/fullstack-panel/client.tsx](templates/fullstack-panel/client.tsx) |
| Core override & global skin templates | Generated via `plugin_manager(action: "scaffold", template: "core-override" \| "global-skin")` |
