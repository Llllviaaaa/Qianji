/**
 * Slot-registry-backed feature availability queries (`src/kernel/runtime/featureSlotQueries.ts`).
 *
 * Replaces the legacy `builtinPluginGatesStore` boolean flags (ADR 0023 §6):
 * once the microkernel `BuiltinCorePluginCoordinator` boots, pane and code-block
 * availability is derived directly from live Cordis Fiber registrations in
 * `clientSlotsRegistry` (plus legacy `clientContributions`). Before boot (e.g.
 * isolated legacy component unit tests), sensible built-in defaults apply.
 */
import { useCallback, useSyncExternalStore } from "react";
import { clientContributions } from "../../lib/clientContributions";
import { clientSlotsRegistry, type SlotRegistry } from "../slots/registry";

const DEFAULT_PREBOOT_PANES: ReadonlySet<string> = new Set([
  "files",
  "editor",
  "code",
  "terminal",
  "review",
  "preview",
  "side-chat",
  "intelligent-ui-canvas",
]);

const DEFAULT_PREBOOT_CODE_LANGUAGES: ReadonlySet<string> = new Set([
  "mermaid",
  "plantuml",
  "puml",
  "uml",
]);

let coordinatorBooted = false;

/** Mark whether `BuiltinCorePluginCoordinator` has taken ownership of builtin feature Fibers. */
export function setBuiltinFeatureCoordinatorActive(active: boolean): void {
  coordinatorBooted = active;
}

export function isBuiltinFeatureCoordinatorActive(): boolean {
  return coordinatorBooted;
}

/**
 * Determine whether a right-workbench pane ID is currently provided by a mounted
 * built-in or external plugin (`workbench.panes` slot or legacy `rightWorkbenchTabs`).
 */
export function isWorkbenchPaneAvailable(
  paneId: string,
  registry: SlotRegistry = clientSlotsRegistry,
): boolean {
  const normalized = paneId.trim();
  if (normalized === "") return false;
  if (registry.getKeyedCandidates("workbench.panes", normalized).length > 0) {
    return true;
  }
  if (
    clientContributions
      .getSnapshot()
      .rightWorkbenchTabs.some((tab) => tab.id === normalized)
  ) {
    return true;
  }
  if (!coordinatorBooted && registry.getEntries("workbench.panes").length === 0) {
    return DEFAULT_PREBOOT_PANES.has(normalized);
  }
  return false;
}

/** Reactive hook subscribing to `SlotRegistry` + legacy contributions for pane availability. */
export function useWorkbenchPaneAvailable(
  paneId: string,
  registry: SlotRegistry = clientSlotsRegistry,
): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      const offSlots = registry.subscribe(listener);
      const offLegacy = clientContributions.subscribe(listener);
      return () => {
        offSlots();
        offLegacy();
      };
    },
    [registry],
  );
  const getSnapshot = useCallback(
    () => isWorkbenchPaneAvailable(paneId, registry),
    [paneId, registry],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Check whether a keyed `conversation.markdown.codeBlock` slot entry is currently
 * registered for `language` (e.g., `"mermaid"` or `"plantuml"` from `diagram-viewer`).
 */
export function hasCodeBlockSlotEntry(
  language: string,
  registry: SlotRegistry = clientSlotsRegistry,
): boolean {
  const normalized = language.trim().toLowerCase();
  if (normalized === "") return false;
  return registry.getKeyedCandidates("conversation.markdown.codeBlock", normalized).length > 0;
}

/**
 * Reactive check for whether built-in fallback diagram rendering should run when
 * no explicit `conversation.markdown.codeBlock` slot or legacy renderer matched.
 * Returns `false` once the microkernel coordinator has booted (because `diagram-viewer`
 * owns diagram rendering via real slot registration and unmounts cleanly when disabled).
 */
export function useCodeBlockSlotStatus(
  language: string,
  registry: SlotRegistry = clientSlotsRegistry,
): { readonly hasSlotEntry: boolean; readonly allowPrebootDiagramFallback: boolean } {
  const normalized = language.trim().toLowerCase();
  const subscribe = useCallback(
    (listener: () => void) => registry.subscribe(listener),
    [registry],
  );
  const getHasEntry = useCallback(
    () => (normalized === "" ? false : registry.getKeyedCandidates("conversation.markdown.codeBlock", normalized).length > 0),
    [normalized, registry],
  );
  const hasSlotEntry = useSyncExternalStore(subscribe, getHasEntry, getHasEntry);
  const allowPrebootDiagramFallback =
    !hasSlotEntry &&
    !coordinatorBooted &&
    registry.getEntries("conversation.markdown.codeBlock").length === 0 &&
    DEFAULT_PREBOOT_CODE_LANGUAGES.has(normalized);
  return { hasSlotEntry, allowPrebootDiagramFallback };
}
