import { create } from "zustand";
import type { PluginInfo } from "@qianji/protocol";

export interface BuiltinPluginGatesState {
  codeReviewEnabled: boolean;
  webPreviewEnabled: boolean;
  sideChatEnabled: boolean;
  diagramViewerEnabled: boolean;
  mermaidEnabled: boolean;
  plantUmlEnabled: boolean;
  syncFromPluginList: (plugins: readonly PluginInfo[]) => void;
  resetBuiltinPluginGates: () => void;
}

const DEFAULT_GATES = {
  codeReviewEnabled: true,
  webPreviewEnabled: true,
  sideChatEnabled: true,
  diagramViewerEnabled: true,
  mermaidEnabled: true,
  plantUmlEnabled: true,
};

function isPluginActive(plugin: PluginInfo): boolean {
  return (
    plugin.enabled !== false &&
    plugin.status !== "disabled" &&
    plugin.status !== "errored" &&
    plugin.status !== "untrusted"
  );
}

export const useBuiltinPluginGatesStore = create<BuiltinPluginGatesState>((set) => ({
  ...DEFAULT_GATES,

  syncFromPluginList: (plugins) =>
    set((prev) => {
      const codeReview = plugins.find((p) => p.id === "code-review");
      const webPreview = plugins.find((p) => p.id === "web-preview");
      const sideChat = plugins.find((p) => p.id === "side-chat");
      const diagramViewer = plugins.find((p) => p.id === "diagram-viewer");

      const nextCodeReview = codeReview ? isPluginActive(codeReview) : prev.codeReviewEnabled;
      const nextWebPreview = webPreview ? isPluginActive(webPreview) : prev.webPreviewEnabled;
      const nextSideChat = sideChat ? isPluginActive(sideChat) : prev.sideChatEnabled;
      const nextDiagramViewer = diagramViewer ? isPluginActive(diagramViewer) : prev.diagramViewerEnabled;
      const nextMermaid = diagramViewer
        ? diagramViewer.config?.enableMermaid !== false
        : prev.mermaidEnabled;
      const nextPlantUml = diagramViewer
        ? diagramViewer.config?.enablePlantUml !== false
        : prev.plantUmlEnabled;

      if (
        nextCodeReview === prev.codeReviewEnabled &&
        nextWebPreview === prev.webPreviewEnabled &&
        nextSideChat === prev.sideChatEnabled &&
        nextDiagramViewer === prev.diagramViewerEnabled &&
        nextMermaid === prev.mermaidEnabled &&
        nextPlantUml === prev.plantUmlEnabled
      ) {
        return prev;
      }

      return {
        codeReviewEnabled: nextCodeReview,
        webPreviewEnabled: nextWebPreview,
        sideChatEnabled: nextSideChat,
        diagramViewerEnabled: nextDiagramViewer,
        mermaidEnabled: nextMermaid,
        plantUmlEnabled: nextPlantUml,
      };
    }),

  resetBuiltinPluginGates: () => set({ ...DEFAULT_GATES }),
}));
