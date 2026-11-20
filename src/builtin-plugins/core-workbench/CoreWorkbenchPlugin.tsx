/**
 * Cordis client plugin definition for `core-workbench` (ADR 0023 Wave 2B).
 *
 * Registers `shell.workbench.right`, `shell.workbench.bottom`, `workbench.tilingGrid`,
 * built-in keyed panes (`files`/`editor`/`code` and `terminal`), built-in bottom
 * terminal tab, built-in inspector sections (`env`, `context`, `outputs`,
 * `extensions`, `diagnostics`), and core topbar controls.
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { CORE_SLOT_SPECS } from "@qianji/client-slots";
import { CoreCodeWorkspacePane } from "./CoreCodeWorkspacePane";
import {
  InspectorContextSection,
  InspectorDiagnosticsSection,
  InspectorEnvSection,
  InspectorExtensionsSection,
  InspectorOutputsSection,
} from "./CoreInspectorSections";
import { CoreBottomTerminalTab, CoreTerminalPane } from "./CoreTerminalPane";
import { CoreChromeTopbarButtons, CorePrimaryTopbarButtons } from "./CoreTopbarControls";
import { CoreWorkbenchBottom } from "./CoreWorkbenchBottom";
import { CoreWorkbenchRight, CoreWorkbenchTilingGrid } from "./CoreWorkbenchRight";

export const CORE_WORKBENCH_PLUGIN_ID = "core-workbench";

export const coreWorkbenchPlugin: Plugin = {
  name: CORE_WORKBENCH_PLUGIN_ID,
  inject: ["slots", "workbenchService", "workspaceService", "sessionService"],
  apply(ctx: Context): void {
    // Define `workbench.topbarControls` spec without claiming cross-parent ownership
    // (`core-shell`'s `shell.menubar` owns `workbench.topbarControls` in full shell boots).
    ctx.slots.defineSlot("workbench.topbarControls", CORE_SLOT_SPECS["workbench.topbarControls"]);

    // 1. Right workbench container (`shell.workbench.right`)
    ctx.slots.register("shell.workbench.right", {
      id: `${CORE_WORKBENCH_PLUGIN_ID}:right`,
      priority: 0,
      children: {
        "workbench.tilingGrid": CORE_SLOT_SPECS["workbench.tilingGrid"],
        "workbench.inspector.sections": CORE_SLOT_SPECS["workbench.inspector.sections"],
      },
      component: CoreWorkbenchRight,
    });

    // 2. Dynamic tiling grid (`workbench.tilingGrid`) owning keyed `workbench.panes`
    ctx.slots.register("workbench.tilingGrid", {
      id: `${CORE_WORKBENCH_PLUGIN_ID}:tiling-grid`,
      priority: 0,
      children: {
        "workbench.panes": CORE_SLOT_SPECS["workbench.panes"],
      },
      component: CoreWorkbenchTilingGrid,
    });

    // 3. Built-in keyed workbench panes (`files`/`editor`/`code` -> CodeWorkspacePane, `terminal` -> TerminalPanel)
    ctx.slots.register("workbench.panes", {
      id: `${CORE_WORKBENCH_PLUGIN_ID}:pane:files`,
      key: ["files", "editor", "code"],
      priority: 0,
      children: {
        "workbench.fileViewer": CORE_SLOT_SPECS["workbench.fileViewer"],
      },
      component: CoreCodeWorkspacePane,
    });

    ctx.slots.register("workbench.panes", {
      id: `${CORE_WORKBENCH_PLUGIN_ID}:pane:terminal`,
      key: "terminal",
      priority: 0,
      component: CoreTerminalPane,
    });

    // 4. Built-in inspector sections (`env`, `context`, `outputs`, `extensions`, `diagnostics`)
    ctx.slots.register("workbench.inspector.sections", {
      id: `${CORE_WORKBENCH_PLUGIN_ID}:inspector:env`,
      order: 10,
      component: InspectorEnvSection,
    });
    ctx.slots.register("workbench.inspector.sections", {
      id: `${CORE_WORKBENCH_PLUGIN_ID}:inspector:context`,
      order: 20,
      component: InspectorContextSection,
    });
    ctx.slots.register("workbench.inspector.sections", {
      id: `${CORE_WORKBENCH_PLUGIN_ID}:inspector:outputs`,
      order: 30,
      component: InspectorOutputsSection,
    });
    ctx.slots.register("workbench.inspector.sections", {
      id: `${CORE_WORKBENCH_PLUGIN_ID}:inspector:extensions`,
      order: 40,
      component: InspectorExtensionsSection,
    });
    ctx.slots.register("workbench.inspector.sections", {
      id: `${CORE_WORKBENCH_PLUGIN_ID}:inspector:diagnostics`,
      order: 50,
      component: InspectorDiagnosticsSection,
    });

    // 5. Bottom workbench drawer (`shell.workbench.bottom`) owning keyed `workbench.bottom.tabs`
    ctx.slots.register("shell.workbench.bottom", {
      id: `${CORE_WORKBENCH_PLUGIN_ID}:bottom`,
      priority: 0,
      children: {
        "workbench.bottom.tabs": CORE_SLOT_SPECS["workbench.bottom.tabs"],
      },
      component: CoreWorkbenchBottom,
    });

    ctx.slots.register("workbench.bottom.tabs", {
      id: `${CORE_WORKBENCH_PLUGIN_ID}:bottom:terminal`,
      key: "terminal",
      priority: 0,
      component: CoreBottomTerminalTab,
    });

    // 6. Core topbar workbench toggles (`files`, `terminal`, active legacy tabs, bottom, inspector)
    ctx.slots.register("workbench.topbarControls", {
      id: `${CORE_WORKBENCH_PLUGIN_ID}:topbar:primary`,
      order: 30,
      component: CorePrimaryTopbarButtons,
    });
    ctx.slots.register("workbench.topbarControls", {
      id: `${CORE_WORKBENCH_PLUGIN_ID}:topbar:chrome`,
      order: 90,
      component: CoreChromeTopbarButtons,
    });
  },
};

export default coreWorkbenchPlugin;
