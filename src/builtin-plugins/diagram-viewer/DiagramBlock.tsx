/**
 * Interactive Mermaid & PlantUML diagram components for `diagram-viewer` (ADR 0023).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  Code2,
  Copy,
  Download,
  Eye,
  LoaderCircle,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
  TriangleAlert,
  Workflow,
  X,
} from "lucide-react";
import {
  clampDiagramZoom,
  darkThemeActive,
  downloadDiagramSvg,
  getDiagramSnapshot,
  LOADING_DIAGRAM_STATE,
  MAX_DIAGRAM_ZOOM,
  MIN_DIAGRAM_ZOOM,
  subscribeDiagramCell,
  type DiagramKind,
  type DiagramRenderState,
} from "./diagramEngine";

export { clampDiagramZoom, type DiagramKind };

function useDiagramRender(kind: DiagramKind, dark: boolean, source: string): DiagramRenderState {
  const subscribe = useCallback(
    (listener: () => void) => subscribeDiagramCell(kind, dark, source, listener),
    [kind, dark, source],
  );
  const getSnapshot = useCallback(
    () => getDiagramSnapshot(kind, dark, source),
    [kind, dark, source],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => LOADING_DIAGRAM_STATE);
}

/** Interactive Mermaid / PlantUML diagram renderer block. */
export function DiagramBlock({ kind, source }: { readonly kind: DiagramKind; readonly source: string }): ReactElement {
  const [dark, setDark] = useState(darkThemeActive);
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [zoom, setZoom] = useState(1);
  const lightboxViewportRef = useRef<HTMLDivElement>(null);

  const state = useDiagramRender(kind, dark, source);

  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => setDark(darkThemeActive()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  const label = kind === "mermaid" ? "Mermaid" : "PlantUML";
  const sourceVisible = showSource || state.status === "error";

  const saveSvg = () => {
    if (state.svg === "") return;
    downloadDiagramSvg(kind, state.svg);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  };

  return (
    <section className={`diagram-block diagram-${kind}`} data-feature-diagram={kind} aria-label={`${label} 图形`}>
      <div className="diagram-toolbar">
        <span>{label}</span>
        <div>
          <button
            type="button"
            title="查看大图"
            aria-label={`查看 ${label} 大图`}
            disabled={state.status !== "ready"}
            onClick={() => {
              setZoom(1);
              setExpanded(true);
            }}
          >
            <Maximize2 size={14} />
          </button>
          <button
            type="button"
            title={saved ? "已保存" : "保存为 SVG"}
            aria-label={saved ? `${label} 已保存` : `保存 ${label} 为 SVG`}
            disabled={state.status !== "ready"}
            onClick={saveSvg}
          >
            {saved ? <Check size={14} /> : <Download size={14} />}
          </button>
          <button
            type="button"
            title={sourceVisible && state.status !== "error" ? "查看图形" : "查看源码"}
            aria-label={sourceVisible && state.status !== "error" ? "查看图形" : "查看源码"}
            disabled={state.status === "error"}
            onClick={() => setShowSource((visible) => !visible)}
          >
            {sourceVisible && state.status !== "error" ? <Eye size={14} /> : <Code2 size={14} />}
          </button>
          <button
            type="button"
            title={copied ? "已复制" : "复制源码"}
            aria-label={copied ? "已复制" : "复制源码"}
            onClick={() => {
              void navigator.clipboard?.writeText(source).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1600);
              }).catch(() => undefined);
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
      </div>
      {state.status === "loading" && (
        <div className="diagram-status" role="status">
          <LoaderCircle className="spin" size={16} />
          <span>正在渲染...</span>
        </div>
      )}
      {state.status === "error" && (
        <div className="diagram-status error" role="alert">
          <TriangleAlert size={16} />
          <span>{state.error}</span>
        </div>
      )}
      {state.status === "ready" && !sourceVisible && (
        <div
          className="diagram-render"
          title="双击查看大图"
          onDoubleClick={() => {
            setZoom(1);
            setExpanded(true);
          }}
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      )}
      {sourceVisible && (
        <pre className="diagram-source">
          <code>{source}</code>
        </pre>
      )}
      {expanded && state.status === "ready" && typeof document !== "undefined" && document.body !== null && createPortal(
        <div className="diagram-lightbox" role="presentation" onMouseDown={() => setExpanded(false)}>
          <section
            className="diagram-lightbox-panel"
            role="dialog"
            aria-modal="true"
            aria-label={`${label} 大图`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="diagram-lightbox-header">
              <strong>{label}</strong>
              <div className="diagram-lightbox-actions">
                <div className="diagram-zoom-controls" role="group" aria-label="图形缩放">
                  <button type="button" title="缩小" disabled={zoom <= MIN_DIAGRAM_ZOOM} onClick={() => setZoom((z) => clampDiagramZoom(z - 0.25))}>
                    <Minus size={16} />
                  </button>
                  <span className="diagram-zoom-value">{Math.round(zoom * 100)}%</span>
                  <button type="button" title="放大" disabled={zoom >= MAX_DIAGRAM_ZOOM} onClick={() => setZoom((z) => clampDiagramZoom(z + 0.25))}>
                    <Plus size={16} />
                  </button>
                  <button type="button" title="适应窗口" disabled={zoom === 1} onClick={() => setZoom(1)}>
                    <RotateCcw size={15} />
                  </button>
                </div>
                <button type="button" title="关闭大图" onClick={() => setExpanded(false)}>
                  <X size={17} />
                </button>
              </div>
            </header>
            <div ref={lightboxViewportRef} className="diagram-lightbox-viewport">
              <div
                className="diagram-lightbox-render"
                style={{ width: `${Math.max(1, zoom) * 100}%`, height: `${Math.max(1, zoom) * 100}%` }}
                dangerouslySetInnerHTML={{ __html: state.svg }}
              />
            </div>
          </section>
        </div>,
        document.body,
      )}
    </section>
  );
}

/** File viewer wrapper for `.mmd`/`.mermaid`/`.puml`/`.plantuml` files in `workbench.fileViewer`. */
export function DiagramFileViewer({
  kind,
  path,
  content,
}: {
  readonly kind: DiagramKind;
  readonly path: string;
  readonly content: string;
}): ReactElement {
  const [viewMode, setViewMode] = useState<"preview" | "source">("preview");
  const title = kind === "mermaid" ? "Mermaid 图表" : "PlantUML 图表";

  return (
    <div className="pid-wb-diagram-file" data-feature-file-viewer={`diagram-${kind}`} data-file-path={path}>
      <div className="pid-wb-subbar">
        <span className="pid-wb-filepath">
          <Workflow size={13} />
          <span>{title}</span>
        </span>
        <div className="pid-wb-subbar-actions">
          <button type="button" className={`pid-wb-pill${viewMode === "preview" ? " active" : ""}`} onClick={() => setViewMode("preview")}>
            <Eye size={12} />
            <span>可视化</span>
          </button>
          <button type="button" className={`pid-wb-pill${viewMode === "source" ? " active" : ""}`} onClick={() => setViewMode("source")}>
            <Code2 size={12} />
            <span>源码</span>
          </button>
        </div>
      </div>
      <div className="pid-wb-scroll">
        {viewMode === "preview" ? (
          <DiagramBlock kind={kind} source={content} />
        ) : (
          <pre className="diagram-source">
            <code>{content}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
