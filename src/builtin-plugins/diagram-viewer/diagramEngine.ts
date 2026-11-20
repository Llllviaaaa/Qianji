/**
 * Deterministic Mermaid & PlantUML rendering engine and external-store cache
 * for `diagram-viewer` (`src/builtin-plugins/diagram-viewer/diagramEngine.ts`, ADR 0023).
 */
import DOMPurify from "dompurify";

export type DiagramKind = "mermaid" | "plantuml";

export interface DiagramRenderState {
  readonly status: "loading" | "ready" | "error";
  readonly svg: string;
  readonly error: string;
}

interface DiagramCacheCell {
  state: DiagramRenderState;
  started: boolean;
  readonly listeners: Set<() => void>;
}

const diagramCache = new Map<string, DiagramCacheCell>();
export const LOADING_DIAGRAM_STATE: DiagramRenderState = { status: "loading", svg: "", error: "" };

let diagramSequence = 0;
let mermaidQueue: Promise<void> = Promise.resolve();
let plantUmlQueue: Promise<void> = Promise.resolve();
let vizLoader: Promise<void> | null = null;
let plantUmlLoader: Promise<typeof import("@plantuml/core")> | null = null;

export const MIN_DIAGRAM_ZOOM = 0.5;
export const MAX_DIAGRAM_ZOOM = 3;

export function clampDiagramZoom(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return Math.min(MAX_DIAGRAM_ZOOM, Math.max(MIN_DIAGRAM_ZOOM, rounded));
}

export function darkThemeActive(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";
}

function sanitizePlantUmlSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
  });
}

export function downloadDiagramSvg(kind: DiagramKind, svg: string): void {
  const portableSvg = /<svg\b[^>]*\bxmlns=/.test(svg)
    ? svg
    : svg.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  const blob = new Blob([portableSvg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `qianji-${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.svg`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function renderMermaid(source: string, dark: boolean): Promise<string> {
  let rendered = "";
  const task = mermaidQueue.then(async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: dark ? "dark" : "default",
      flowchart: { htmlLabels: false },
    });
    diagramSequence += 1;
    const result = await mermaid.render(`qianji-diagram-${diagramSequence}`, source);
    rendered = result.svg;
  });
  mermaidQueue = task.catch(() => undefined);
  await task;
  return rendered;
}

function loadVizGlobal(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("图形渲染仅支持桌面页面"));
  if ((window as Window & { Viz?: unknown }).Viz !== undefined) return Promise.resolve();
  if (vizLoader !== null) return vizLoader;
  vizLoader = import("@plantuml/core/viz-global.js?url").then(({ default: vizGlobalUrl }) => (
    new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>("script[data-qianji-plantuml-viz]");
      const script = existing ?? document.createElement("script");
      script.addEventListener("load", () => resolve(), { once: true });
      script.addEventListener("error", () => reject(new Error("PlantUML 布局引擎加载失败")), { once: true });
      if (existing === null) {
        script.src = vizGlobalUrl;
        script.dataset.qianjiPlantumlViz = "true";
        document.head.appendChild(script);
      }
    })
  ));
  return vizLoader;
}

async function renderPlantUml(source: string, dark: boolean): Promise<string> {
  let rendered = "";
  const task = plantUmlQueue.then(async () => {
    await loadVizGlobal();
    plantUmlLoader ??= import("@plantuml/core");
    const { render } = await plantUmlLoader;
    const normalized = /^\s*@start\w+/mi.test(source) ? source : `@startuml\n${source}\n@enduml`;
    rendered = await new Promise<string>((resolve, reject) => {
      const target = document.createElement("div");
      diagramSequence += 1;
      target.id = `qianji-plantuml-${diagramSequence}`;
      target.style.cssText = "position:absolute;left:-100000px;top:0;width:1px;height:1px;overflow:hidden";
      document.body.appendChild(target);
      let timer = 0;
      const cleanup = () => {
        window.clearTimeout(timer);
        observer.disconnect();
        target.remove();
      };
      const observer = new MutationObserver(() => {
        const svg = target.querySelector("svg");
        if (svg === null) return;
        const markup = svg.outerHTML;
        cleanup();
        resolve(markup);
      });
      observer.observe(target, { childList: true, subtree: true });
      timer = window.setTimeout(() => {
        cleanup();
        reject(new Error("PlantUML 渲染超时"));
      }, 20_000);
      try {
        render(normalized.split(/\r\n|\r|\n/), target.id, { dark });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  });
  plantUmlQueue = task.catch(() => undefined);
  await task;
  return rendered;
}

function getOrCreateCell(kind: DiagramKind, dark: boolean, source: string): DiagramCacheCell {
  const key = `${kind}:${dark ? "dark" : "light"}:${source}`;
  let cell = diagramCache.get(key);
  if (cell === undefined) {
    cell = { state: LOADING_DIAGRAM_STATE, started: false, listeners: new Set() };
    diagramCache.set(key, cell);
  }
  return cell;
}

export function getDiagramSnapshot(kind: DiagramKind, dark: boolean, source: string): DiagramRenderState {
  return getOrCreateCell(kind, dark, source).state;
}

export function subscribeDiagramCell(
  kind: DiagramKind,
  dark: boolean,
  source: string,
  listener: () => void,
): () => void {
  const cell = getOrCreateCell(kind, dark, source);
  cell.listeners.add(listener);
  if (!cell.started && typeof window !== "undefined" && typeof document !== "undefined") {
    cell.started = true;
    const run =
      kind === "mermaid"
        ? renderMermaid(source, dark)
        : renderPlantUml(source, dark).then(sanitizePlantUmlSvg);
    void run.then(
      (svg) => {
        cell.state = { status: "ready", svg, error: "" };
        for (const cb of [...cell.listeners]) cb();
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        cell.state = { status: "error", svg: "", error: message };
        for (const cb of [...cell.listeners]) cb();
      },
    );
  }
  return () => {
    cell.listeners.delete(listener);
  };
}
