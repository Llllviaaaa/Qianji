/**
 * Built-in `web-preview` workbench pane (`BrowserPreviewTab`) & topbar toggle button (ADR 0023).
 *
 * Wired purely via `@qianji/client` Frontend Cordis Services with strict
 * `sanitizePreviewUrl` SSRF/same-origin/IPC-host protection.
 */
import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Globe,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  Monitor,
  MoreHorizontal,
  RotateCw,
  ShieldAlert,
  Smartphone,
  X,
} from "lucide-react";
import {
  sendChatPrompt,
  showToast,
  useFrontendService,
  useWorkbenchState,
  useWorkspaceState,
} from "@qianji/client";
import type {
  SlotComponentProps,
  WorkbenchPaneSlotProps,
  WorkbenchSlotBaseProps,
} from "@qianji/client-slots";
import {
  inferDevServerPort,
  normalizePreviewUrl,
  PreviewFeedbackBar,
  sanitizePreviewUrl,
  type PreviewViewportMode,
} from "./previewHelpers";

export { sanitizePreviewUrl };

/** Topbar toggle button registered onto `workbench.topbarControls` by `web-preview`. */
export function WebPreviewTopbarButton({
  ctx,
}: SlotComponentProps<WorkbenchSlotBaseProps, "session-maybe">): ReactElement {
  const workbench = useWorkbenchState(ctx);
  const workbenchService = useFrontendService("workbenchService", ctx);
  const isOpen = (workbench?.openPanes ?? []).includes("preview");

  return (
    <button
      type="button"
      data-wb-tab="preview"
      data-plugin-topbar="web-preview"
      className={`pid-wb-top-toggle${isOpen ? " active" : ""}`}
      title="浏览器预览 (Ctrl+T)"
      aria-label="浏览器预览"
      aria-pressed={isOpen}
      onClick={() => workbenchService?.togglePane("preview")}
    >
      <Globe size={15} strokeWidth={1.65} />
    </button>
  );
}

/** Keyed `"preview"` pane rendered inside `workbench.panes`. */
export function BrowserPreviewTab({
  cwd: propCwd,
  maximized = false,
  onClose,
  ctx,
}: SlotComponentProps<WorkbenchPaneSlotProps, "session-maybe">): ReactElement {
  const workbench = useWorkbenchState(ctx);
  const workspace = useWorkspaceState(ctx);
  const workbenchService = useFrontendService("workbenchService", ctx);
  const workspaceService = useFrontendService("workspaceService", ctx);
  const composerService = useFrontendService("composerService", ctx);

  const cwd = propCwd ?? workspace?.cwd ?? "";
  const previewUrl = workbench?.previewUrl ?? "";

  const [prevExternalUrl, setPrevExternalUrl] = useState(previewUrl);
  const [draftUrl, setDraftUrl] = useState(previewUrl);
  const [urlHistory, setUrlHistory] = useState<readonly string[]>(() =>
    previewUrl.trim() !== "" ? [previewUrl.trim()] : [],
  );
  const [historyIdx, setHistoryIdx] = useState(() => (previewUrl.trim() !== "" ? 0 : -1));
  const [reloadNonce, setReloadNonce] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [viewportMode, setViewportMode] = useState<PreviewViewportMode>("responsive");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [sendingFeedback, setSendingFeedback] = useState(false);
  const [detectingServer, setDetectingServer] = useState(false);

  if (prevExternalUrl !== previewUrl) {
    setPrevExternalUrl(previewUrl);
    setDraftUrl(previewUrl);
    const trimmed = previewUrl.trim();
    if (trimmed !== "" && urlHistory[historyIdx] !== trimmed) {
      const sliced = urlHistory.slice(0, Math.max(0, historyIdx + 1));
      const next = [...sliced, trimmed];
      setUrlHistory(next);
      setHistoryIdx(next.length - 1);
    }
  }

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".pid-wb-menu-anchor") !== null) return;
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const activeUrl = sanitizePreviewUrl(previewUrl) ?? "";
  const isBlockedCandidate = previewUrl.trim() !== "" && sanitizePreviewUrl(previewUrl) === null;
  const canGoBack = historyIdx > 0;
  const canGoForward = historyIdx >= 0 && historyIdx < urlHistory.length - 1;

  const navigateUrl = (nextUrl: string) => {
    setDraftUrl(nextUrl);
    workbenchService?.openPreview(nextUrl);
  };

  const handleStepHistory = (delta: -1 | 1) => {
    const nextIdx = historyIdx + delta;
    const target = urlHistory[nextIdx];
    if (target === undefined) return;
    setHistoryIdx(nextIdx);
    setDraftUrl(target);
    workbenchService?.openPreview(target);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const raw = draftUrl.trim();
    if (raw === "") {
      workbenchService?.openPreview("");
      return;
    }
    navigateUrl(normalizePreviewUrl(raw));
  };

  const handleDetectDevServer = async () => {
    if (detectingServer) return;
    setMenuOpen(false);
    setDetectingServer(true);
    try {
      let port = 5173;
      if (cwd !== "" && workspaceService !== undefined) {
        try {
          const pkg = await workspaceService.readFile("package.json", cwd);
          if (pkg.text !== null && pkg.text !== undefined && pkg.text !== "") {
            port = inferDevServerPort(pkg.text);
          }
        } catch {
          // Non-Node workspace: default to 5173.
        }
      }
      navigateUrl(`http://localhost:${port}`);
    } finally {
      setDetectingServer(false);
    }
  };

  const handleSendFeedback = async (prefillOnly: boolean) => {
    const trimmed = feedbackText.trim();
    if (trimmed === "" || sendingFeedback) return;
    const urlPart = activeUrl || draftUrl.trim();
    const viewportLabel =
      viewportMode === "mobile" ? "移动端 390px" : viewportMode === "desktop" ? "桌面端 1280px" : "自适应";
    const prompt = [
      urlPart !== ""
        ? `关于预览页面（${urlPart} · 视口 ${viewportLabel}）的视觉/交互反馈：`
        : `关于预览页面（视口 ${viewportLabel}）的视觉/交互反馈：`,
      trimmed,
    ].join("\n\n");

    if (prefillOnly) {
      if (composerService !== undefined) {
        composerService.prefill(prompt);
        showToast("已填入对话输入框", "info");
      } else {
        await sendChatPrompt(prompt, { prefillOnly: true });
      }
      return;
    }

    setSendingFeedback(true);
    try {
      const sent = await sendChatPrompt(prompt, { behavior: "followUp" });
      if (sent) {
        setFeedbackText("");
        setFeedbackOpen(false);
      }
    } finally {
      setSendingFeedback(false);
    }
  };

  return (
    <div className="pid-wb-pane pid-wb-browser-pane" data-feature-pane="web-preview">
      <form className="pid-wb-pane-header pid-wb-browser-header" onSubmit={handleSubmit}>
        <div className="pid-wb-browser-urlbar">
          <Globe size={14} className="pid-wb-search-icon" />
          <input
            type="text"
            className="pid-wb-search-input"
            aria-label="浏览器预览地址"
            placeholder="输入网址（如 localhost:5173）"
            value={draftUrl}
            onChange={(event) => setDraftUrl(event.target.value)}
          />
        </div>
        <div className="pid-wb-pane-actions">
          <button type="button" className="pid-wb-icon-btn" disabled={!canGoBack} title="后退" aria-label="后退" onClick={() => handleStepHistory(-1)}>
            <ChevronLeft size={14} />
          </button>
          <button type="button" className="pid-wb-icon-btn" disabled={!canGoForward} title="前进" aria-label="前进" onClick={() => handleStepHistory(1)}>
            <ChevronRight size={14} />
          </button>
          <button type="button" className="pid-wb-icon-btn" disabled={activeUrl === ""} title="重新加载预览" aria-label="重新加载预览" onClick={() => setReloadNonce((n) => n + 1)}>
            <RotateCw size={13} />
          </button>
          <button
            type="button"
            className="pid-wb-icon-btn"
            disabled={activeUrl === ""}
            title="在外部浏览器中打开"
            aria-label="在外部浏览器中打开"
            onClick={() => { if (activeUrl !== "") void workspaceService?.openExternal(activeUrl); }}
          >
            <ExternalLink size={13} />
          </button>
          <div className="pid-wb-menu-anchor">
            <button
              type="button"
              className={`pid-wb-icon-btn${menuOpen ? " active" : ""}`}
              title="预览视口与反馈选项"
              aria-label="预览更多选项"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreHorizontal size={14} />
            </button>
            <div className="pid-wb-pane-popover" hidden={!menuOpen} role="menu" aria-label="预览选项">
              <div className="pid-wb-popover-label">视口尺寸</div>
              <button type="button" role="menuitemradio" aria-checked={viewportMode === "responsive"} onClick={() => { setViewportMode("responsive"); setMenuOpen(false); }}>
                <Maximize2 size={12} />
                <span>自适应</span>
              </button>
              <button type="button" role="menuitemradio" aria-checked={viewportMode === "mobile"} onClick={() => { setViewportMode("mobile"); setMenuOpen(false); }}>
                <Smartphone size={12} />
                <span>移动 (390px)</span>
              </button>
              <button type="button" role="menuitemradio" aria-checked={viewportMode === "desktop"} onClick={() => { setViewportMode("desktop"); setMenuOpen(false); }}>
                <Monitor size={12} />
                <span>桌面 (1280px)</span>
              </button>
              <div className="pid-wb-popover-sep" />
              <button type="button" role="menuitem" onClick={() => { setFeedbackOpen((open) => !open); setMenuOpen(false); }}>
                <MessageSquarePlus size={12} />
                <span>{feedbackOpen ? "隐藏反馈栏" : "反馈预览问题"}</span>
              </button>
              <button type="button" role="menuitem" onClick={() => void handleDetectDevServer()}>
                <Globe size={12} />
                <span>检测开发服务器</span>
              </button>
            </div>
          </div>
          <button
            type="button"
            className="pid-wb-icon-btn"
            title={maximized ? "还原宽度" : "最大化工作台"}
            aria-label={maximized ? "还原宽度" : "最大化工作台"}
            onClick={() => workbenchService?.toggleMaximizePane("preview")}
          >
            {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button
            type="button"
            className="pid-wb-icon-btn"
            title="关闭浏览器预览"
            aria-label="关闭浏览器预览"
            onClick={() => { if (onClose !== undefined) onClose(); else workbenchService?.closePane("preview"); }}
          >
            <X size={13} />
          </button>
        </div>
      </form>

      {feedbackOpen && (
        <PreviewFeedbackBar
          feedbackText={feedbackText}
          sending={sendingFeedback}
          onChangeText={setFeedbackText}
          onAppendChip={(chip) => setFeedbackText((prev) => (prev.trim() !== "" ? `${prev.trim()}，${chip}` : chip))}
          onClose={() => setFeedbackOpen(false)}
          onPrefill={() => void handleSendFeedback(true)}
          onSend={() => void handleSendFeedback(false)}
        />
      )}

      <div className={`pid-wb-preview-stage is-${viewportMode}`}>
        {isBlockedCandidate ? (
          <div className="pid-wb-empty error">
            <ShieldAlert size={22} className="pid-wb-empty-icon" />
            <p>已拦截不安全的预览地址：仅允许独立的 http:// 或 https:// 页面（禁止伪协议、内部 IPC 域名或宿主同源地址）。</p>
          </div>
        ) : activeUrl !== "" ? (
          <div className={`pid-wb-preview-frame-wrap is-${viewportMode}`}>
            <iframe
              key={`${activeUrl}:${reloadNonce}`}
              className="pid-wb-iframe"
              src={activeUrl}
              title="Web 预览"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          </div>
        ) : (
          <div className="pid-wb-empty pid-wb-claude-empty">
            <div className="pid-wb-empty-halo">
              <Globe size={20} strokeWidth={1.5} />
            </div>
            <strong>与 Agent 协同浏览</strong>
            <p>输入网址或让 Agent 打开页面，支持实时查看、点击与交互验证。</p>
            <div className="pid-wb-empty-hint-row">
              <span>需要预览本地应用？</span>
              <button
                type="button"
                className="pid-wb-inline-strong-btn"
                disabled={detectingServer}
                onClick={() => void handleDetectDevServer()}
              >
                {detectingServer ? "正在检测…" : "检测开发服务器"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
