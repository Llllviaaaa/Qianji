/**
 * Built-in `diagram-viewer` Cordis client plugin (`src/builtin-plugins/diagram-viewer/index.ts`, ADR 0023).
 *
 * Eliminates the fake `diagramViewerEnabled` / `mermaidEnabled` / `plantUmlEnabled`
 * gates by registering `"mermaid"` and `"plantuml"` directly onto
 * `conversation.markdown.codeBlock` and `.mmd`/`.mermaid`/`.puml`/`.plantuml`
 * onto `workbench.fileViewer`, respecting plugin config `enableMermaid` and
 * `enablePlantUml`.
 */
import { createElement } from "react";
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { DiagramBlock, DiagramFileViewer, type DiagramKind } from "./DiagramBlock";

export const DIAGRAM_VIEWER_PLUGIN_ID = "diagram-viewer";

export interface DiagramViewerConfig {
  readonly enableMermaid?: boolean;
  readonly enablePlantUml?: boolean;
}

function matchesExtensionRoute(routeKey: string, allowedExts: readonly string[]): boolean {
  const normalized = routeKey.trim().toLowerCase();
  if (normalized === "") return false;
  for (const ext of allowedExts) {
    if (normalized === ext || normalized === `.${ext}` || normalized.endsWith(`.${ext}`)) {
      return true;
    }
  }
  return false;
}

export const diagramViewerPlugin: Plugin<DiagramViewerConfig> = {
  name: DIAGRAM_VIEWER_PLUGIN_ID,
  inject: ["slots"],
  apply(ctx: Context, rawConfig: DiagramViewerConfig = {}): void {
    const enableMermaid = rawConfig.enableMermaid !== false;
    const enablePlantUml = rawConfig.enablePlantUml !== false;

    if (enableMermaid) {
      ctx.slots.register("conversation.markdown.codeBlock", {
        id: `${DIAGRAM_VIEWER_PLUGIN_ID}:codeblock:mermaid`,
        key: ["mermaid"],
        matchKey: (lang) => lang.trim().toLowerCase() === "mermaid",
        priority: 0,
        component: ({ code, isStreaming, renderFactory }) => {
          if (isStreaming === true) {
            return createElement(
              "pre",
              { className: "diagram-streaming-fence" },
              createElement("code", { className: "language-mermaid" }, code),
            );
          }
          return renderFactory(
            "host.diagram.block",
            { kind: "mermaid", source: code },
            { fallback: createElement(DiagramBlock, { kind: "mermaid", source: code }) },
          );
        },
      });

      ctx.slots.register("workbench.fileViewer", {
        id: `${DIAGRAM_VIEWER_PLUGIN_ID}:file:mermaid`,
        key: [".mmd", ".mermaid"],
        matchKey: (route) => matchesExtensionRoute(route, ["mmd", "mermaid"]),
        priority: 0,
        component: ({ path, content, renderFactory }) =>
          renderFactory(
            "host.diagram.block",
            { kind: "mermaid", source: content },
            { fallback: createElement(DiagramFileViewer, { kind: "mermaid", path, content }) },
          ),
      });
    }

    if (enablePlantUml) {
      ctx.slots.register("conversation.markdown.codeBlock", {
        id: `${DIAGRAM_VIEWER_PLUGIN_ID}:codeblock:plantuml`,
        key: ["plantuml", "puml", "uml"],
        matchKey: (lang) => {
          const n = lang.trim().toLowerCase();
          return n === "plantuml" || n === "puml" || n === "uml";
        },
        priority: 0,
        component: ({ code, isStreaming, renderFactory }) => {
          if (isStreaming === true) {
            return createElement(
              "pre",
              { className: "diagram-streaming-fence" },
              createElement("code", { className: "language-plantuml" }, code),
            );
          }
          return renderFactory(
            "host.diagram.block",
            { kind: "plantuml", source: code },
            { fallback: createElement(DiagramBlock, { kind: "plantuml", source: code }) },
          );
        },
      });

      ctx.slots.register("workbench.fileViewer", {
        id: `${DIAGRAM_VIEWER_PLUGIN_ID}:file:plantuml`,
        key: [".puml", ".plantuml"],
        matchKey: (route) => matchesExtensionRoute(route, ["puml", "plantuml", "wsd"]),
        priority: 0,
        component: ({ path, content, renderFactory }) =>
          renderFactory(
            "host.diagram.block",
            { kind: "plantuml", source: content },
            { fallback: createElement(DiagramFileViewer, { kind: "plantuml", path, content }) },
          ),
      });
    }
  },
};

export { DiagramBlock, DiagramFileViewer, type DiagramKind };
export default diagramViewerPlugin;
