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
            <SafeModeBanner />
            <SlotRoot
              registry={clientSlotsRegistry}
              ctx={root}
              props={{ safeMode: safeMode.active }}
            />
          </WorkspaceFileOpenContext.Provider>
        </FileActionsProvider>
      </SlotKernelProvider>
    </RegionErrorBoundary>
  );
}
