import { useState, type ComponentType } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { usePluginConfig } from "@qianji/client";
import { Code2, Eye, Workflow } from "lucide-react";

export const name = "diagram-viewer";
export const inject = ["contributions", "styles"];

export interface DiagramViewerConfig {
  enableMermaid?: boolean;
  enablePlantUml?: boolean;
}

type HostDiagramComponent = ComponentType<{ kind: "mermaid" | "plantuml"; source: string }>;

function resolveKind(filePath: string): "mermaid" | "plantuml" {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".puml") || lower.endsWith(".plantuml") || lower.endsWith(".wsd")) {
    return "plantuml";
  }
  return "mermaid";
}

function DiagramFileViewer({ path, content }: { path: string; content: string }) {
  const cfg = usePluginConfig<DiagramViewerConfig>("diagram-viewer", {
    enableMermaid: true,
    enablePlantUml: true,
  });
  const [viewMode, setViewMode] = useState<"preview" | "source">("preview");
  const kind = resolveKind(path);
  const engineEnabled = kind === "mermaid" ? cfg.enableMermaid !== false : cfg.enablePlantUml !== false;
  const HostDiagram = (window as unknown as { __qianjiDiagramComponent?: HostDiagramComponent })
    .__qianjiDiagramComponent;

  const canRenderDiagram = engineEnabled && HostDiagram !== undefined;

  return (
    <div className="dv-wrap">
      <div className="dv-bar">
        <span className="dv-title">
          <Workflow size={14} />
          <span>{kind === "mermaid" ? "Mermaid" : "PlantUML"} 图表</span>
        </span>
        <div className="dv-tabs">
          <button
            type="button"
            className={`dv-tab${viewMode === "preview" ? " active" : ""}`}
            onClick={() => setViewMode("preview")}
          >
            <Eye size={12.5} />
            <span>可视化</span>
          </button>
          <button
            type="button"
            className={`dv-tab${viewMode === "source" ? " active" : ""}`}
            onClick={() => setViewMode("source")}
          >
            <Code2 size={12.5} />
            <span>源码</span>
          </button>
        </div>
      </div>

      <div className="dv-body">
        {viewMode === "preview" && canRenderDiagram ? (
          <HostDiagram kind={kind} source={content} />
        ) : (
          <pre className="dv-source">{content}</pre>
        )}
      </div>
    </div>
  );
}

const SCOPED_CSS = `
.dv-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 12px;
  gap: 10px;
}
.dv-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.dv-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
}
.dv-tabs {
  display: inline-flex;
  gap: 4px;
}
.dv-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 9px;
  border-radius: 6px;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.25));
  background: transparent;
  color: var(--text-2, inherit);
  font-size: 12px;
  cursor: pointer;
}
.dv-tab.active {
  background: var(--active, rgba(128, 128, 128, 0.16));
  color: var(--text, inherit);
}
.dv-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.dv-source {
  margin: 0;
  padding: 12px;
  border-radius: 8px;
  background: var(--code-bg, rgba(128, 128, 128, 0.1));
  font-family: var(--code-font, monospace);
  font-size: 12px;
  line-height: 1.5;
  overflow: auto;
}
`;

export function apply(ctx: Context): void {
  ctx.styles.inject(SCOPED_CSS);
  ctx.contributions.registerFileViewer({
    id: "diagram-viewer:file",
    label: "图表预览",
    extensions: [".mmd", ".mermaid", ".puml", ".plantuml", ".wsd"],
    order: 10,
    render: ({ path, content }) => <DiagramFileViewer path={path} content={content} />,
  });
}

export default {
  name,
  inject,
  apply,
};
