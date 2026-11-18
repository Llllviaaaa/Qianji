# Qianji (千机)

![Qianji Banner](docs/assets/hero-banner.svg)

**A local-first Windows desktop creation environment fusing an Agent Workbench, an Autonomous Bot, and a Lightweight IDE.**

[**简体中文**](README.md) · [**English**](README.en.md)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows_10%2F11-0078D6.svg)](#quick-start)
[![Engine: Harness Host](https://img.shields.io/badge/Engine-Harness_Host_(Cordis)-6E56CF.svg)](docs/SYSTEM_DESIGN.md)
[![Runtime: Tauri 2 + React 19](https://img.shields.io/badge/Shell-Tauri_2_%2B_React_19-FFC131.svg)](#system-architecture)

[Screenshots](#screenshots) · [Why Qianji?](#why-qianji) · [Capabilities](#capabilities) · [System Architecture](#system-architecture) · [Monorepo Packages](#monorepo-packages) · [Quick Start](#quick-start) · [Security Model](#security-model) · [Documentation](#documentation)

---

**Qianji (千机)** (formerly *Pi Desktop* before v0.3) is a **100% local-only** desktop environment engineered around its own microkernel engine, the **Harness Host** (`qianji-harness.exe`). One host process serves every concurrent task, subagent, and background schedule, wiring the agent loop, model adapters, tools, permissions, sessions, MCP, browser automation, computer use, and **Intelligent UI** as hot-reloadable [Cordis](https://github.com/cordiverse/cordis) plugins.

Qianji has **zero runtime dependency on external CLI agents or global Node.js installations** and **no cloud account or telemetry lock-in**. Existing `~/.pid` data and `%APPDATA%/pid-desktop` settings are migrated automatically to `~/.qianji` and `%APPDATA%/qianji` on first launch.

> [!NOTE]
> Qianji is an independent open-source project. It is not affiliated with or endorsed by OpenAI, Anthropic, or Google. References to Codex, Claude Artifacts, or Grok describe interaction patterns, not product ownership.

---

## Screenshots

| New Session Home & Composer | Intelligent UI & Split-Pane Canvas |
| :---: | :---: |
| ![Home & Composer](docs/assets/screenshot-home.png)<br/><sub>Workspace & Local/Worktree selector, model/thinking picker, and quick starters</sub> | ![Intelligent UI & Split-Pane Canvas](docs/assets/screenshot-intelligent-ui.png)<br/><sub>Live interactive calculators, charts, and sandboxed apps inline and side-by-side</sub> |
| **Unified Right IDE Workbench & Git Review** | **Connectors & Dynamic Plugin Center** |
| ![Right IDE Workbench & Review Diff](docs/assets/screenshot-workbench.png)<br/><sub>Workspace files, CodeMirror 6 editor, hunk-level Git stage/revert, and side chat</sub> | ![Connectors & Plugin Center](docs/assets/screenshot-settings.png)<br/><sub>Manage MCP servers, CDP browser, desktop control, subagents, and hot-reloadable plugins</sub> |

---

## Why Qianji?

| Dimension | Typical CLI / Cloud Agents | Qianji (千机) |
| :--- | :--- | :--- |
| **Execution Architecture** | Spawns a separate runtime process per task or routes code through remote cloud workers | **Single-Host Microkernel**: One compiled `qianji-harness.exe` hosts all concurrent sessions, subagents, and schedules in isolated Cordis fibers ([ADR 0001](docs/adr/0001-harness-host-process.md)) |
| **Workspace Form Factor** | Terminal-only TUI or chat-only sidebar extension | **3-in-1 Native Workbench**: Unifies multi-turn Agent chat, a hybrid split-tile right workbench (`Files & CodeMirror 6` / `Git Review` / `Web Preview` / `Side Chat` / `Intelligent UI Canvas` / `Terminal` / `Observability` + adaptive inspector), and a multi-tab ConPTY terminal |
| **Data & Secret Sovereignty** | Cloud-stored transcripts or plaintext API keys in config files | **100% Local & DPAPI-Encrypted**: Append-only JSONL session logs (`~/.qianji/sessions`), offline SQLite FTS5 search (`~/.qianji/index.sqlite`), and Windows DPAPI secret storage (`secrets.dat`) |
| **Extensibility** | Static build-time tools or prompt-only skills | **Full-Stack Dynamic Plugins with HMR**: 3-tier override (`builtin` < `user` < `workspace`), 10 official bundled plugins, 22 fault-isolated `<PluginSlot>` UI extension points & `@qianji/client` SDK, plus deferred HMR while agent runs are active ([ADR 0016](docs/adr/0016-dynamic-plugins-and-hmr.md)) |
| **Workspace Safety** | All-or-nothing file mutations | **Turn Checkpoints & Approval Gates**: Non-invasive Git snapshots (`refs/qianji/checkpoints`) before every writable turn, unified diff review, default `allowForcePush: false`, and lightweight Windows Job Object sandboxing |

---

## Capabilities

### 1. Multi-Model Agent Core & Session Engine
- **Native Multi-Provider Streaming & Adaptive Thinking**: First-class adapters for **Anthropic Messages** (`/v1/messages` with Claude 4.6+ / 5 adaptive thinking `thinking: { type: "adaptive" }` & `output_config.effort`, multi-breakpoint session prompt caching, and `/v1/models` context-window discovery, [ADR 0018](docs/adr/0018-anthropic-adaptive-thinking-and-caching.md)), **OpenAI Chat Completions** (`/v1/chat/completions` with automatic `reasoning_effort` inference and HTTP 400 parameter fallbacks, compatible with DeepSeek, OpenRouter, Ollama, vLLM), **OpenAI Responses** (`/v1/responses` for o-series / GPT-5 reasoning), and **Google Gemini** (`streamGenerateContent`) ([ADR 0007](docs/adr/0007-llm-layer.md)).
- **Modes & Live Steering**: Switch dynamically between `Execute` (`agent`), `Plan`, and `Ask` modes; inject live `steer` corrections mid-run or curate an editable `followUp` queue; track step-by-step execution plans (`update_plan`) and pre-stop continuation hooks (`agent/before-stop`).
- **In-Process Controlled Subagents (`@qianji/subagents`)**: Delegate parallel exploration or coding subtasks via `delegate_task` with role-based model/effort routing (`roleModels`), structured JSON output validation (`outputSchema`), optional **isolated Git Worktree execution (`isolateWorktree: true`)** with ordered patch application (saving conflicts to `.qianji/subagent-patches/*.patch`), opt-in **verification shell & diagnostics (`allowShell: true`)** bounded by parent `workspace-write` permissions, parent abort linking, and unattended propagation (`ui.markUnattended`) ([ADR 0010](docs/adr/0010-subagents-mcp-usage.md), [ADR 0022](docs/adr/0022-agent-capability-enhancements.md)).
- **Context Pressure, Sliding Compaction & Event-Sourced Sessions**: Proactively compacts before hitting context limits (`compactAtContextRatio`, default `0.8`) using sliding-window retention of recent complete tool turns (`keepRecentTokens`), shrinking summary retries on overflow, and 50K-char tool output spilling (`@qianji/tool-output` → `~/.qianji/spill/`, [ADR 0019](docs/adr/0019-context-pressure.md)). Append-only JSONL logs support non-destructive `rewind` (with optional `summarizeDropped` dead-end branch summaries), `fork`/`clone`, Markdown export, and asynchronous bilingual SQLite FTS5 search ([ADR 0004](docs/adr/0004-session-format.md), [ADR 0022](docs/adr/0022-agent-capability-enhancements.md)).
- **Tool Guards & Lazy Tool Activation**: `@qianji/tool-guards` enforces per-call timeouts (10 min default) with abort-grace detachment and nudges the model after 3/5/8 identical repeated calls ([ADR 0020](docs/adr/0020-tool-guards.md)); `@qianji/tools` provides `activate_tools` lazy schema loading for deferred tool groups (`browser`, `computer`, `code_intelligence`, `process`, `plugin_dev`, and large MCP servers).
- **Offline Token, Latency & Cost Observability**: Tracks input, output, cache read/write, and `reasoningTokens` per turn, estimating session and cumulative USD cost locally via `@qianji/pricing`, surfaced in the composer by the official `session-usage` plugin (`/usage`).

### 2. Intelligent UI & Split-Pane Canvas
- **Generative Interactive Widgets (`@qianji/intelligent-ui`)**: Models can invoke `render_ui` and `update_ui` (or users can trigger `/ui <request>` / `/ui clear`) to compose live interactive artifacts inline in the chat stream and expand them in the right workbench Canvas pane.
- **Dual Rendering Engines**:
  - **Declarative Engine (`declarative`)**: Zero-JS schema for sliders, numeric/select/toggle controls, real-time `Math.*` formula metric cards, bar/line/area/donut charts, searchable tables, tabs, checklists, and prompt-submitting forms.
  - **Isolated Sandbox Engine (`html`)**: Self-contained HTML/CSS/SVG/Canvas mini-apps served from an isolated loopback origin with strict CSP, `--pi-*` theme token injection inside the widget iframe, version history switching, and `window.piUI.sendPrompt()` callback bridging (while host workbench UI plugins use `@qianji/client` and `--qj-*` semantic tokens).

### 3. Browser Control, Computer Use & MCP Ecosystem
- **Grok-Style Browser Automation (`@qianji/browser`)**: Drives local Edge, Chrome, or Chromium over CDP with 11 deferred `browser_*` tools (`browser_navigate`, `browser_inspect`, `browser_click`, `browser_type`, `browser_screenshot`, …) plus `/browser-diagnose`, numbered inspect element refs, per-session browser isolation, workspace-scoped downloads, and idle auto-reclaiming ([ADR 0012](docs/adr/0012-browser.md)).
- **Windows Computer Use (`@qianji/computer`)**: Native Win32 screen/window observation and SendInput mouse/keyboard automation via 11 deferred `computer_*` tools (`computer_sources`, `computer_start`, `computer_screenshot`, `computer_click`, `computer_type`, …) with per-session observe/control isolation and approval gates ([ADR 0011](docs/adr/0011-computer-and-schedule.md)).
- **Full MCP Host (`@qianji/mcp`)**: Connects to local newline-framed **STDIO** and remote **Streamable HTTP** MCP servers in the background; exposes dynamic `mcp__<server>__<tool>` tools (auto-deferring servers with > 8 tools via `activate_tools`) with `list_changed` hot-refresh, exponential-backoff reconnect, live resource subscriptions (`/mcp-resources`, `/mcp-read`), prompt templates (`/mcp-prompts`), and DPAPI-encrypted secret headers/env.

### 4. Integrated IDE, Multi-Pane Workbench, Precision Code Tools & Git Review
- **Multi-Pane Split-Tile Right Workbench**: Hybrid tiling workbench supporting vertical/horizontal splits, sash resizing, pointer header drag-docking/swapping, pane maximization, and an adaptive (docked/sole/floating) **Task & Context Inspector**, integrating **Code Workspace** (file tree + streaming full-text search + multi-tab CodeMirror 6 + custom file viewers such as Mermaid/PlantUML), **Git Review Diff**, **Web Preview** (`/preview`), **Side Chat** (`/side`, `/btw`, `Ctrl+Alt+S`), **Intelligent UI Canvas**, **ConPTY Terminal** (dockable in the bottom panel `Ctrl+J` or right workbench), and dynamic plugin panes (e.g. `observability`).
- **Precision Code Editing, Fast Search & Managed Background Processes ([ADR 0021](docs/adr/0021-powershell-fallback.md), [ADR 0022](docs/adr/0022-agent-capability-enhancements.md))**:
  - `@qianji/tool-fs`: Content-hash anchored `read(..., { hashlines: true })` and atomic multi-hunk `HashlineEdit` (`±20` line drift auto-relocation), `ripgrep` (`rg`) fast search with pure-Node fallback, and deferred read-only `diagnostics` (JSON validation & local `tsc --noEmit`).
  - `@qianji/tool-bash`: Automatic **`powershell` fallback tool** on Windows machines without Git Bash (matching `bash` permission & sandbox parity), plus session-isolated **managed background processes** (`background: true` + `bg_process` `list`/`logs`/`wait`/`stop`) automatically reaped on session unload/delete.
- **Codex-Style Git Review, Inline Comments & PR Loop**: Inspect uncommitted, staged, unstaged, last-turn checkpoint, branch comparison, or commit diffs; stage, unstage, or revert individual diff hunks; add inline diff comments on specific lines and send them to the Agent in batch; draft commit messages and create/inspect GitHub Pull Requests via local `gh` CLI with one-click CI failure / review comment autofix.
- **Non-Invasive Checkpoints & Smart Rewind**: Automatically captures Git workspace snapshots under `refs/qianji/checkpoints` before writable turns without touching `.git/index`; `smart-rewind` adds `/rewind`, `Esc Esc` timeline, 3-way restore (conversation + code / conversation only / code only), unsent draft recovery, and one-click undo ([ADR 0009](docs/adr/0009-feature-plugins.md)).
- **Managed Git Worktrees & Multi-Tab ConPTY Terminal**: Start tasks in isolated Git worktrees; run persistent multi-tab shells (PowerShell 7, Windows PowerShell, CMD, Git Bash, WSL) in the bottom panel (`Ctrl+J`) or a right workbench tile. Terminal output is **never** injected into model context unless you explicitly click "Send to Chat".

### 5. Autonomous Bot, Goal Tracker, Progressive Memory 2.0 & Full-Stack Plugins
- **Local Scheduled Tasks (`@qianji/schedule`)**: Run recurring `hourly`, `daily`, `weekdays`, or `weekly` tasks in unattended sessions (`read-only`, `ask`, or `workspace-write` — silent `full-access` is prohibited) with run history and direct links to generated sessions ([ADR 0011](docs/adr/0011-computer-and-schedule.md)).
- **Long-Horizon Goal Tracker (`plugins/goal-tracker`)**: Provides `/goal` and `create_goal` / `get_goal` / `update_goal` tools with an interactive composer dock banner, acceptance checklist tracking, `<goal-reminder>` anti-drift injection, and pre-stop auto-audit continuation.
- **Progressive Memory 2.0 (`@qianji/memory`) & Skills (`SKILL.md`)**: Separate toggles and editors for global (`~/.qianji/memory.md`) and workspace-trusted project memory (`<workspace>/.qianji/memory.md`); automatically switches to compact `<memory mode="indexed">` directory mode above `inlineMaxChars` (4,000 chars) alongside `search`, sliced `read`, and `upsert_section` with unified diff approval; built-in Skills Manager (`~/.qianji/skills`, `.qianji/skills`, `.agents/skills`, and plugin-bundled skills) with live `/skill:<name>` slash command registration.
- **Unified Plugins Hub, `@qianji/client` SDK & 10 Official Bundled Plugins ([ADR 0016](docs/adr/0016-dynamic-plugins-and-hmr.md), [ADR 0017](docs/adr/0017-plugin-trust-model.md))**:
  - Unified **Plugins Hub** managing Core Capabilities (`builtin`), 10 Official Bundled Plugins (`code-review`, `diagram-viewer`, `goal-tracker`, `message-actions`, `observability`, `quick-prompts`, `session-usage`, `side-chat`, `smart-rewind`, `web-preview`), User Plugins, and Workspace Plugins.
  - Client plugins mount through `@qianji/client` (`src/sdk/index.ts`) across 22 fault-isolated `<PluginSlot>` points (native left-sidebar pages & sections, left-rail `settings.pages` & `settings.sections`, workbench & bottom tabs, menus, keybindings, Markdown code blocks, file viewers, composer banners/status, overlays) with `@layer plugin-ui` + `@scope` CSS isolation.
  - Install from local folders (with file-watch HMR deferred automatically while agent runs are active), `.tgz`/`.zip` archives, Git repositories, or npm (via embedded Bun with `--ignore-scripts`); includes closed-loop Agent plugin tools (`qianji_inspect` + `plugin_manager` + offline `plugin-types/`) and cross-plane crash forensics (`observability` + `/logs`).

---

## System Architecture

> For the comprehensive architectural specification, sequence diagrams, data storage layout, and subsystem internals, see **[docs/SYSTEM_DESIGN.md](docs/SYSTEM_DESIGN.md)** and the **[Architecture Decision Records (docs/adr)](docs/adr/README.md)**.

![Qianji System Architecture](docs/assets/architecture-diagram.svg)

- **The Rust Shell (`src-tauri`)** owns the application window, system tray, prevent-sleep thread, native Git diff/stage/PR commands, ConPTY terminal sessions, workspace file streaming search, the `--computer-helper` native bridge, and the lifecycle of the Harness Host child process. It passes desktop settings to the Host over `stdin` and automatically restarts the Host with exponential backoff if it crashes ([ADR 0001](docs/adr/0001-harness-host-process.md), [ADR 0013](docs/adr/0013-desktop-settings-and-secrets.md)).
- **The Harness Host (`packages/host`)** is compiled into a standalone Windows executable (`qianji-harness.exe`) using `esbuild` and `bun build --compile`, so end users need no external runtime. The frontend talks directly to the Host over authenticated loopback WebSocket JSON-RPC 2.0 for all agent, session, model, MCP, schedule, and plugin operations ([ADR 0002](docs/adr/0002-client-protocol.md), [ADR 0014](docs/adr/0014-frontend-harness-adapter.md)).

---

## Monorepo Packages

The repository is organized as an npm workspace (`packages/*`, 36 packages total) with strict architectural import boundaries enforced by ESLint and guardrail tests ([ADR 0005](docs/adr/0005-repository-layout.md)):

| Package | Role | Description |
| :--- | :--- | :--- |
| `packages/protocol` & `packages/rpc` | Shared Contract | JSON-RPC 2.0 wire types, method schemas, `AppSettings` contract, secret redaction, and Host RPC registration bus |
| `packages/kernel` | Microkernel | Cordis dependency extraction, deterministic Kahn topological sort, fiber readiness inspection, and workspace scopes |
| `packages/host` | Engine Entry | Process entrypoint, WebServer, PluginManager, client TSX bundler, DPAPI FFI secret store, crash forensics, and `qianji_inspect`/`plugin_manager` |
| `packages/agent` & `packages/agent-loop` | Agent Core | Agent service contracts (including `agent/before-stop`), streaming delta types, sliding compaction, and the single deterministic multi-turn Agent Loop |
| `packages/llm`, `llm-openai-compat`, `llm-openai-responses`, `llm-anthropic`, `llm-gemini` | Model Layer | Unified streaming LLM interface, credential refs, and native adapters for OpenAI Compat, OpenAI Responses, Anthropic (adaptive thinking & caching), and Gemini |
| `packages/pricing` | Observability | Offline model pricing catalog and per-turn / cumulative USD cost estimation |
| `packages/session`, `session-jsonl`, `session-search-fts` | Storage & Search | Event-sourced session state, branch & rewind summary derivation, append-only JSONL persistence, and SQLite FTS5 indexing |
| `packages/tools`, `tool-fs`, `tool-bash`, `tool-guards`, `tool-output` | Tooling, Guards & Sandbox | Three-stage tool pipeline with `activate_tools` lazy loading, Hashline edits/`rg`/`diagnostics`, Bash/PowerShell fallback & `bg_process`, timeout/repeat guards, and 50K output spill |
| `packages/permissions` & `packages/checkpoints` | Safety & Rewind | Ordered allow/confirm/block rule engine (`allowForcePush`, `powershell` parity), permission modes, and non-invasive Git snapshot creation/restore |
| `packages/system-prompt` & `packages/prompt-context` | Context Builder | Ordered system prompt assembly, `AGENTS.md`/`CLAUDE.md` discovery, and `SKILL.md` lifecycle management |
| `packages/plan`, `memory`, `hooks`, `commands`, `ui` | Capabilities | Step plan tracking, progressive indexed Memory 2.0 with diff approval, lifecycle shell hooks, slash commands, and multi-transport UI bus |
| `packages/subagents`, `mcp`, `browser`, `computer`, `schedule`, `intelligent-ui` | Extensions | Worktree-capable subagents with `outputSchema`, STDIO/HTTP MCP client, CDP browser driver, Windows computer use, scheduler, and generative UI |
| `packages/testkit` | Testing Utilities | Deterministic scripted LLM providers (`ScriptedProvider`) and golden JSONL test helpers |
| `plugins/*` | 10 Official Plugins | `code-review`, `diagram-viewer`, `goal-tracker`, `message-actions`, `observability`, `quick-prompts`, `session-usage`, `side-chat`, `smart-rewind`, `web-preview` |
| `src/` (incl. `src/sdk/`) & `src-tauri/` | Desktop Client | React 19 + Zustand 4-slice frontend workbench, `@qianji/client` SDK (`src/sdk/`), and Tauri 2 Rust native shell (`src-tauri/`) |

---

## Quick Start

### Prerequisites
- **Windows 10 / 11 (x64)** with **WebView2** (pre-installed on modern Windows)
- **Node.js >= 22** and `npm`
- **Rust stable** with the `x86_64-pc-windows-msvc` toolchain

### Development & Desktop Build

`npm ci` installs workspace dependencies and the pinned Bun compiler. Tauri dev and build commands compile `qianji-harness.exe` automatically via [`scripts/prepare-harness-host.mjs`](scripts/prepare-harness-host.mjs).

```powershell
# 1. Install dependencies
npm ci

# 2. Launch the desktop app in development mode (auto-builds Harness Host)
npm run tauri -- dev

# 3. Build production Windows installers (NSIS / MSI)
npm run tauri -- build
```

### Headless CLI Mode

The compiled Harness Host also supports standalone headless execution for scripting and CI workflows:

```powershell
npm run prepare:harness-host
.\src-tauri\resources\harness\qianji-harness.exe run --cwd . --model anthropic/claude-sonnet-4-20250514 "Summarize the repository architecture"
```

### Quality & Verification Gates

Every pull request must pass all 7 verification gates:

```powershell
npm run scan:secrets            # Scan working tree and Git history for leaked credentials
npm audit --audit-level=high    # Verify npm dependency security baseline
npm run typecheck               # Type-check UI, build scripts, packages/*, and E2E suites
npm run lint                    # Enforce code quality and ADR 0005 module boundary rules
npm run test:unit               # Run Vitest unit/golden tests, exe smoke tests, hygiene & doc-link checks
npm run test:stress             # Run Host concurrency, high-frequency delta, and HMR memory leak stress tests
npm run test:e2e                # Run Playwright E2E tests in Edge against a real Harness Host

# Run Rust unit tests
Push-Location src-tauri
cargo test
Pop-Location
```

---

## Security Model

1. **Permission Modes, `powershell` Parity & Lightweight Sandbox**:
   - `read-only`, `ask`, `workspace-write`, and `full-access` modes are enforced by `@qianji/permissions` on `tools/pre-execute` before any model-initiated tool runs. The Windows `powershell` fallback shares exact approval and interception parity with `bash`, and `allowForcePush: false` blocks `git push --force` by default ([ADR 0021](docs/adr/0021-powershell-fallback.md)).
   - In non-`full-access` modes, `@qianji/tool-bash` applies a lightweight Windows sandbox (credential environment scrubbing, `.qianji/sandbox-tmp` redirection, static high-risk command blocking, and Windows Job Object process limits).
   - Approval gates and process-level guards are **not** a kernel or hypervisor virtualization boundary. For untrusted or unattended workloads, export a `.wsb` (Windows Sandbox) or `.devcontainer` configuration directly from Settings (`sandbox.generateConfig`).
2. **Encrypted Credentials at Rest (Windows DPAPI)**:
   - Model provider API keys (`~/.qianji/secrets.dat`) and MCP server secrets (`%APPDATA%/qianji/mcp-secrets.dat`) are encrypted on disk using Windows `CryptProtectData` (DPAPI) bound to the current OS user. Configuration files store only opaque `SecretRef` pointers or `$ENV_VAR` names ([ADR 0013](docs/adr/0013-desktop-settings-and-secrets.md)).
3. **Plugin Trust Model & Workspace Trust Gate ([ADR 0016](docs/adr/0016-dynamic-plugins-and-hmr.md), [ADR 0017](docs/adr/0017-plugin-trust-model.md))**:
   - Enabled plugins run in-process inside the Host event loop and main WebView with **full user trust** (no runtime worker sandbox and no `permissions` manifest field; Fiber boundaries and `@scope` isolate render errors and CSS cascade, not malicious code or synchronous hangs).
   - Risk is gated by source trust: user plugins require explicit installation/enablement, and project-scoped plugins (`<workspace>/.qianji/plugins`), project configurations (`<workspace>/.qianji/harness.json`), and project memory are **never** loaded until the user explicitly grants trust to the canonical workspace path in `~/.qianji/trusted-workspaces.json`. Revoking trust immediately disposes the workspace's isolated Cordis fiber.
4. **Browser, Computer Use & Scheduled Tasks**:
   - Observation tools (`computer_sources`, `computer_screenshot`, `computer_inspect`) are read-only; interactive input requires `computer_start` in control mode and an approval gate. Windows UIPI still prevents input into higher-integrity windows.
   - Scheduled tasks execute only while the computer and Qianji are running, mark their sessions as unattended (auto-denying any confirmation prompt), and prohibit `full-access` mode.

Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

---

## Documentation

- **[System Design Document (`docs/SYSTEM_DESIGN.md`)](docs/SYSTEM_DESIGN.md)** — Complete architecture, sequence diagrams, subsystem breakdown, state management, and data directory specification.
- **[Architecture Decision Records (`docs/adr/README.md`)](docs/adr/README.md)** — ADR 0001 through ADR 0022 covering the V2 Harness Host architecture and evolutions.
- **[Engineering & Agent Guidelines (`AGENTS.md`)](AGENTS.md)** — Three-plane boundaries, frontend CSS/component budgets, closed-loop plugin workflow, and `AppSettings` alignment checklist.
- **[Plugin Development Skill (`skills/qianji-plugin-development/SKILL.md`)](skills/qianji-plugin-development/SKILL.md)** — Official plugin guide, `@qianji/client` SDK, `--qj-*` tokens, and scaffold templates.
- **[Local Capabilities Boundary (`docs/LOCAL_CAPABILITIES.md`)](docs/LOCAL_CAPABILITIES.md)** — Scope baseline, completed local capabilities, and explicit non-goals.
- **[Codex UI Reference (`docs/CODEX_UI_REFERENCE.md`)](docs/CODEX_UI_REFERENCE.md)** — Design restraint and interaction references for the workbench, composer, and diff review UI.
- **[Appearance Extensions (`docs/appearance-extensions.md`)](docs/appearance-extensions.md)** — Custom themes and appearance package format.
- **[Dependency Security Baseline (`docs/DEPENDENCY_SECURITY.md`)](docs/DEPENDENCY_SECURITY.md)** — RustSec and npm audit baseline and license inventory.
- **[Release Checklist (`docs/RELEASING.md`)](docs/RELEASING.md)** & **[Contributing Guide (`CONTRIBUTING.md`)](CONTRIBUTING.md)**.

---

## License

Qianji is licensed under the [Apache License 2.0](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled third-party software notices.
