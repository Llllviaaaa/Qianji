/**
 * Built-in `intelligent-ui` workbench canvas pane (`IntelligentUiCanvasTab`, ADR 0023).
 *
 * Wired purely via `@qianji/client` Frontend Cordis Services — zero internal
 * store imports or host component traversals.
 */
import { useMemo, useState, type ReactElement } from "react";
import { Download, Layers, Sparkles } from "lucide-react";
import {
  sendChatPrompt,
  showToast,
  useAppearanceTheme,
  useFrontendService,
  useSessionState,
  type UiMessage,
} from "@qianji/client";
import type { SlotComponentProps, WorkbenchPaneSlotProps } from "@qianji/client-slots";
import {
  buildInitialState,
  buildSandboxedWidgetHtml,
  deriveSessionWidgets,
  interpolateWidgetText,
  serializeWidgetArtifact,
  type IntelligentUiArtifact,
  type IntelligentUiStateMap,
} from "./artifactParser";

const EMPTY_MESSAGES: readonly UiMessage[] = [];

const CANVAS_STARTERS = [
  {
    title: "复利与定投收益模拟器",
    desc: "滑块调节本金、年化与年限，实时计算收益曲线",
    prompt:
      "/ui 做一个复利与月定投收益模拟器，支持滑块调节初始本金、每月定投额、预期年化收益率与投资年限，展示关键指标卡片与增长趋势图，并支持一键把当前配置回传对话。",
  },
  {
    title: "服务架构延迟与成本看板",
    desc: "多指标对比柱状图、可排序表格与流量估算",
    prompt:
      "/ui 做一个 API 架构方案对比看板（单体 / 微服务 / Serverless），支持拖动日均请求量滑块实时重算月度成本、P99 延迟对比图与可筛选对比表。",
  },
  {
    title: "阻尼弹簧振子物理沙箱",
    desc: "独立 HTML Canvas 实时动画与参数控制",
    prompt:
      "/ui 使用 html 引擎做一个交互式阻尼简谐振动物理演示，包含 Canvas 实时动画与刚度系数、阻尼比滑块控制。",
  },
] as const;

function DeclarativeArtifactView({ artifact }: { readonly artifact: IntelligentUiArtifact }): ReactElement {
  const [state, setState] = useState<IntelligentUiStateMap>(() => buildInitialState(artifact.spec));
  const [prevKey, setPrevKey] = useState(`${artifact.id}:${artifact.version}`);

  const currentKey = `${artifact.id}:${artifact.version}`;
  if (prevKey !== currentKey) {
    setPrevKey(currentKey);
    setState(buildInitialState(artifact.spec));
  }

  const blocks = artifact.spec?.blocks ?? [];

  return (
    <div className="pi-iui-card" data-iui-widget={artifact.id} data-iui-version={artifact.version}>
      <header className="pi-iui-card-head">
        <strong>{artifact.title}</strong>
        {artifact.subtitle !== undefined && <span className="pid-wb-muted">{artifact.subtitle}</span>}
      </header>
      <div className="pi-iui-card-body">
        {blocks.map((block, idx) => {
          if (block.type === "callout") {
            return (
              <div key={`b-${idx}`} className="pi-iui-callout">
                {block.title !== undefined && <strong>{block.title}</strong>}
                <p>{interpolateWidgetText(block.body, state)}</p>
              </div>
            );
          }
          if (block.type === "stats") {
            return (
              <div key={`b-${idx}`} className="pi-iui-stats-grid">
                {block.items.map((item, sIdx) => {
                  const display =
                    item.value !== undefined
                      ? interpolateWidgetText(String(item.value), state)
                      : item.formula !== undefined && item.formula.trim() in state
                        ? String(state[item.formula.trim()])
                        : "—";
                  return (
                    <div key={`s-${sIdx}`} className="pi-iui-stat-card">
                      <span className="pi-iui-stat-label">{item.label}</span>
                      <strong className="pi-iui-stat-val">
                        {item.prefix ?? ""}
                        {display}
                        {item.suffix ?? ""}
                      </strong>
                    </div>
                  );
                })}
              </div>
            );
          }
          if (block.type === "controls") {
            return (
              <div key={`b-${idx}`} className="pi-iui-controls-grid">
                {block.items.map((ctrl) => {
                  const val = state[ctrl.key];
                  return (
                    <label key={ctrl.key} className="pi-iui-control-field">
                      <span>
                        {ctrl.label}
                        {ctrl.unit !== undefined ? ` (${ctrl.unit})` : ""}
                      </span>
                      {ctrl.kind === "toggle" ? (
                        <input
                          type="checkbox"
                          checked={Boolean(val)}
                          onChange={(event) => setState((prev) => ({ ...prev, [ctrl.key]: event.target.checked }))}
                        />
                      ) : ctrl.kind === "select" ? (
                        <select
                          value={String(val ?? "")}
                          onChange={(event) => setState((prev) => ({ ...prev, [ctrl.key]: event.target.value }))}
                        >
                          {(ctrl.options ?? []).map((opt) => (
                            <option key={String(opt.value)} value={String(opt.value)}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type={ctrl.kind === "slider" ? "range" : ctrl.kind === "number" ? "number" : "text"}
                          min={ctrl.min}
                          max={ctrl.max}
                          step={ctrl.step}
                          value={String(val ?? "")}
                          onChange={(event) =>
                            setState((prev) => ({
                              ...prev,
                              [ctrl.key]:
                                ctrl.kind === "slider" || ctrl.kind === "number"
                                  ? Number(event.target.value)
                                  : event.target.value,
                            }))
                          }
                        />
                      )}
                    </label>
                  );
                })}
              </div>
            );
          }
          if (block.type === "table") {
            return (
              <table key={`b-${idx}`} className="pi-iui-table">
                <thead>
                  <tr>
                    {block.columns.map((col) => (
                      <th key={col.key}>{col.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rIdx) => (
                    <tr key={`row-${rIdx}`}>
                      {block.columns.map((col) => (
                        <td key={col.key}>{String(row[col.key] ?? "")}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          }
          if (block.type === "form") {
            return (
              <form
                key={`b-${idx}`}
                className="pi-iui-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const template = block.promptTemplate ?? `已提交 ${artifact.title}`;
                  void sendChatPrompt(interpolateWidgetText(template, state));
                }}
              >
                <button type="submit" className="pid-wb-btn small primary">
                  {block.submitLabel ?? "提交"}
                </button>
              </form>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}

/** Keyed `"intelligent-ui-canvas"` pane registered onto `workbench.panes`. */
export function IntelligentUiCanvasTab({
  ctx,
}: SlotComponentProps<WorkbenchPaneSlotProps, "session-maybe">): ReactElement {
  const session = useSessionState(ctx);
  const composerService = useFrontendService("composerService", ctx);
  const appearance = useAppearanceTheme();

  const messages = session?.messages ?? EMPTY_MESSAGES;
  const groups = useMemo(() => deriveSessionWidgets(messages), [messages]);
  const [selectedWidgetId, setSelectedWidgetId] = useState<string | null>(null);
  const [selectedVersions, setSelectedVersions] = useState<Record<string, number>>({});

  const activeGroup = useMemo(() => {
    if (groups.length === 0) return null;
    if (selectedWidgetId !== null) {
      const matched = groups.find((grp) => grp.id === selectedWidgetId);
      if (matched !== undefined) return matched;
    }
    return groups[groups.length - 1] ?? null;
  }, [groups, selectedWidgetId]);

  if (activeGroup === null) {
    return (
      <div className="pi-iui-canvas-empty" data-feature-pane="intelligent-ui">
        <div className="pi-iui-canvas-empty-hero">
          <span className="pi-iui-canvas-empty-icon" aria-hidden="true">
            <Layers size={18} strokeWidth={1.7} />
          </span>
          <h3>交互画布</h3>
          <p>
            对话中由 <code>render_ui</code> 生成的交互式计算器、可视化图表与 HTML 沙箱会在此集中固定展示，支持版本回溯与源码导出。
          </p>
        </div>

        <div className="pi-iui-canvas-starters">
          <span className="pi-iui-canvas-starters-heading">快速填入示例指令</span>
          {CANVAS_STARTERS.map((starter) => (
            <button
              key={starter.title}
              type="button"
              className="pi-iui-starter-card"
              onClick={() => {
                if (composerService !== undefined) {
                  composerService.prefill(starter.prompt);
                } else {
                  void sendChatPrompt(starter.prompt, { prefillOnly: true });
                }
                showToast("已填入输入框，按回车即可生成交互组件", "info");
              }}
            >
              <div className="pi-iui-starter-title-row">
                <Sparkles size={13} strokeWidth={1.8} />
                <strong>{starter.title}</strong>
              </div>
              <span>{starter.desc}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const activeVerNum = selectedVersions[activeGroup.id] ?? activeGroup.latest.version;
  const activeArtifact =
    activeGroup.versions.find((item) => item.version === activeVerNum) ?? activeGroup.latest;
  const isDark = appearance.resolvedScheme === "dark";

  const handleDownload = () => {
    const isHtml = activeArtifact.engine === "html";
    const content = isHtml
      ? buildSandboxedWidgetHtml(activeArtifact, isDark)
      : serializeWidgetArtifact(activeArtifact);
    const ext = isHtml ? "html" : "json";
    const mime = isHtml ? "text/html;charset=utf-8" : "application/json;charset=utf-8";
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${activeArtifact.id}-v${activeArtifact.version}.${ext}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast(`已导出 ${activeArtifact.id}-v${activeArtifact.version}.${ext}`, "info");
  };

  return (
    <div className="pi-iui-canvas-pane" data-feature-pane="intelligent-ui">
      <div className="pi-iui-canvas-topbar">
        <div className="pi-iui-canvas-switcher" role="tablist" aria-label="会话组件列表">
          {groups.map((grp) => {
            const isSelected = grp.id === activeGroup.id;
            return (
              <button
                key={grp.id}
                type="button"
                role="tab"
                aria-selected={isSelected}
                className={`pi-iui-canvas-pill${isSelected ? " is-active" : ""}`}
                onClick={() => setSelectedWidgetId(grp.id)}
              >
                <span className="pi-iui-canvas-pill-title">{grp.latest.title}</span>
                <small>v{grp.latest.version}</small>
              </button>
            );
          })}
        </div>

        {activeGroup.versions.length > 1 && (
          <div className="pi-iui-version-switcher">
            {activeGroup.versions.map((ver) => (
              <button
                key={ver.version}
                type="button"
                className={`pid-wb-pill${ver.version === activeArtifact.version ? " active" : ""}`}
                onClick={() => setSelectedVersions((prev) => ({ ...prev, [activeGroup.id]: ver.version }))}
              >
                v{ver.version}
              </button>
            ))}
          </div>
        )}

        <button
          type="button"
          className="pi-iui-canvas-export-btn"
          onClick={handleDownload}
          title={activeArtifact.engine === "html" ? "导出独立 HTML 文件" : "导出组件 JSON 定义"}
        >
          <Download size={12} strokeWidth={1.8} />
          <span>导出</span>
        </button>
      </div>

      <div className={`pi-iui-canvas-scroll${activeArtifact.engine === "html" ? " is-html-stage" : ""}`}>
        {activeArtifact.engine === "html" ? (
          <iframe
            className="pi-iui-html-iframe"
            title={activeArtifact.title}
            sandbox="allow-scripts"
            srcDoc={buildSandboxedWidgetHtml(activeArtifact, isDark)}
          />
        ) : (
          <DeclarativeArtifactView artifact={activeArtifact} />
        )}
      </div>
    </div>
  );
}
