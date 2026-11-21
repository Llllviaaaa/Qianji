/**
 * Qianji microkernel entry stub (`src/App.tsx`, ADR 0023).
 *
 * Boots the Cordis frontend microkernel (`ensureClientPluginRuntime()`), mounts
 * the un-overridable `<SafeModeBanner />`, and delegates the entire application
 * UI tree to `<SlotRoot />` inside `<SlotKernelProvider>` + `<RegionErrorBoundary>`.
 */
import { RegionErrorBoundary } from "./components/common/ErrorBoundary";
import { WorkspaceFileOpenContext } from "./components/Markdown";
import { FileActionsProvider } from "./components/WorkspaceOpeners";
import { SafeModeBanner } from "./kernel/runtime/SafeModeBanner";
import { useMicrokernelBootstrap } from "./kernel/runtime/useMicrokernelBootstrap";
import { clientSlotsRegistry, SlotKernelProvider, SlotRoot } from "./kernel/slots";

export default function App() {
  const { root, safeMode, fileActions } = useMicrokernelBootstrap();

  return (
    <RegionErrorBoundary region="应用微内核">
      <SlotKernelProvider registry={clientSlotsRegistry} ctx={root}>
        <FileActionsProvider
          workspace={fileActions.workspace}
          editors={fileActions.editors}
          preferredEditor={fileActions.preferredEditor}
          onOpenPreview={fileActions.onOpenPreview}
          onAddToChat={fileActions.onAddToChat}
          onNotify={fileActions.onNotify}
        >
          <WorkspaceFileOpenContext.Provider value={fileActions.onOpenPreview}>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                width: "100%",
                height: "100%",
                minHeight: 0,
                overflow: "hidden",
              }}
            >
              <SafeModeBanner />
              <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
                <SlotRoot
                  registry={clientSlotsRegistry}
                  ctx={root}
                  props={{ safeMode: safeMode.active }}
                />
              </div>
            </div>
          </WorkspaceFileOpenContext.Provider>
        </FileActionsProvider>
      </SlotKernelProvider>
    </RegionErrorBoundary>
  );
}
