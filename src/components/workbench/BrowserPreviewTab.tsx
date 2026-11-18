import { useEffect, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Globe,
  Maximize2,
  MessageSquarePlus,
  Monitor,
  MoreHorizontal,
  RotateCw,
  Send,
  ShieldAlert,
  Smartphone,
  X,
} from "lucide-react";
import { useSyncOnChange } from "../../hooks/useSyncOnChange";
import { agent } from "../../lib/agent";
import { useAppStore } from "../../store";
import { dispatchWorkbenchPrompt } from "../../stores/workbenchLayoutStore";
import { resolveWorkspacePreviewUrl, useWorkbenchStore } from "../../stores/workbenchStore";

function looksLikeWorkspaceHtmlPath(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return false;
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed)) return false;
  if (trimmed.startsWith("./") || trimmed.startsWith("../")) return true;
  return /\.(?:html?|svg)(?:[?#].*)?$/i.test(trimmed);
}

function normalizePreviewUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return trimmed;
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}

/**
 * Validate a candidate preview URL before embedding in a `sandbox="allow-scripts allow-same-origin"` iframe.
 * Allows only `http:` / `https:`, blocks internal Tauri/WebView2 IPC pseudo-hosts, and blocks same-origin with
 * the Qianji renderer shell so untrusted pages cannot access `window.parent`.
 */
export function sanitizePreviewUrl(raw: string, hostOrigin?: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const hostname = parsed.hostname.toLowerCase();
  if (
    !hostname
    || hostname === "tauri.localhost"
    || hostname === "ipc.localhost"
    || hostname === "asset.localhost"
    || hostname.endsWith(".tauri.localhost")
    || hostname.endsWith(".ipc.localhost")
    || hostname.endsWith(".asset.localhost")
  ) {
    return null;
  }
  const effectiveHostOrigin = hostOrigin ?? (
    typeof window !== "undefined" && window.location ? window.location.origin : undefined
  );
  if (
    effectiveHostOrigin
    && effectiveHostOrigin !== "null"
    && parsed.origin.toLowerCase() === effectiveHostOrigin.toLowerCase()
  ) {
    return null;
  }
  return trimmed;
}

function inferDevServerPort(pkgRaw: string): number {
  const portFlag = /--port(?:=|\s+)(\d{2,5})/.exec(pkgRaw) || /-p\s+(\d{2,5})/.exec(pkgRaw);
  if (portFlag?.[1]) {
    const parsed = Number.parseInt(portFlag[1], 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) return parsed;
  }
  if (/astro/i.test(pkgRaw)) return 4321;
  if (/next\b|nuxt|react-scripts/i.test(pkgRaw)) return 3000;
  if (/webpack-dev-server/i.test(pkgRaw)) return 8080;
  return 5173;
}

type PreviewViewportMode = "responsive" | "mobile" | "desktop";

const FEEDBACK_QUICK_CHIPS = ["样式错位", "点击无响应", "白屏/报错"] as const;

export interface BrowserPreviewTabProps {
  cwd?: string;
  paneControls?: ReactNode;
  draggableHeader?: boolean;
  onHeaderDragStart?: (event: DragEvent<HTMLElement>) => void;
  onHeaderDragEnd?: () => void;
}

export function BrowserPreviewTab({
  cwd = "",
  paneControls,
  draggableHeader,
  onHeaderDragStart,
  onHeaderDragEnd,
}: BrowserPreviewTabProps) {
  const previewUrl = useWorkbenchStore((state) => state.previewUrl);
  const setPreviewUrl = useWorkbenchStore((state) => state.setPreviewUrl);
  const agentBrowser = useAppStore((state) => state.agentBrowser);

  const [draftUrl, setDraftUrl] = useState(() => previewUrl);
  const [urlHistory, setUrlHistory] = useState<string[]>(() => (previewUrl.trim() ? [previewUrl.trim()] : []));
  const [historyIdx, setHistoryIdx] = useState(() => (previewUrl.trim() ? 0 : -1));
  const [reloadNonce, setReloadNonce] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [viewportMode, setViewportMode] = useState<PreviewViewportMode>("responsive");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [sendingFeedback, setSendingFeedback] = useState(false);
  const [detectingServer, setDetectingServer] = useState(false);

  useSyncOnChange([previewUrl], () => {
    setDraftUrl(previewUrl);
    const trimmed = previewUrl.trim();
    if (!trimmed) return;
    setUrlHistory((prev) => {
      if (prev[historyIdx] === trimmed) return prev;
      const sliced = prev.slice(0, Math.max(0, historyIdx + 1));
      const next = [...sliced, trimmed];
      setHistoryIdx(next.length - 1);
      return next;
    });
  });

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".pid-wb-menu-anchor")) return;
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const rawCandidate = previewUrl.trim() || (agentBrowser?.url?.trim() ?? "");
  const activeUrl = sanitizePreviewUrl(rawCandidate) ?? "";
  const isBlockedCandidate = previewUrl.trim() !== "" && sanitizePreviewUrl(previewUrl) === null;
  const safeAgentBrowserUrl = agentBrowser?.url ? sanitizePreviewUrl(agentBrowser.url) : null;
  const canGoBack = historyIdx > 0;
  const canGoForward = historyIdx >= 0 && historyIdx < urlHistory.length - 1;

  const navigateUrl = (nextUrl: string) => {
    setDraftUrl(nextUrl);
    setPreviewUrl(nextUrl);
  };

  const handleStepHistory = (delta: -1 | 1) => {
    const nextIdx = historyIdx + delta;
    const target = urlHistory[nextIdx];
    if (!target) return;
    setHistoryIdx(nextIdx);
    setDraftUrl(target);
    setPreviewUrl(target);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const raw = draftUrl.trim();
    if (!raw) {
      setPreviewUrl("");
      return;
    }
    if (cwd && looksLikeWorkspaceHtmlPath(raw)) {
      const cleanPath = raw.replace(/^(?:\.\/)+/, "").replace(/[?#].*$/, "");
      void resolveWorkspacePreviewUrl(cwd, cleanPath).then((resolved) => {
        navigateUrl(resolved ?? normalizePreviewUrl(raw));
      });
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
      if (cwd) {
        try {
          const pkg = await agent.readWorkspaceFile(cwd, "package.json");
          if (pkg.text) port = inferDevServerPort(pkg.text);
        } catch {
          // Non-Node workspace: fall back to Vite default port 5173.
        }
      }
      navigateUrl(`http://localhost:${port}`);
    } finally {
      setDetectingServer(false);
    }
  };

  const buildFeedbackPrompt = () => {
    const urlPart = activeUrl || draftUrl.trim();
    const viewportLabel = viewportMode === "mobile" ? "移动端 390px" : viewportMode === "desktop" ? "桌面端 1280px" : "自适应";
    return [
      urlPart
        ? `关于预览页面（${urlPart} · 视口 ${viewportLabel}）的视觉/交互反馈：`
        : `关于预览页面（视口 ${viewportLabel}）的视觉/交互反馈：`,
      feedbackText.trim(),
    ].join("\n\n");
  };

  const handleSendFeedback = async (prefillOnly = false) => {
    if (!feedbackText.trim() || sendingFeedback) return;
    const prompt = buildFeedbackPrompt();
    if (prefillOnly) {
      await dispatchWorkbenchPrompt(prompt, { prefillOnly: true });
      return;
    }
    setSendingFeedback(true);
    try {
      const sent = await dispatchWorkbenchPrompt(prompt);
      if (sent) {
        setFeedbackText("");
        setFeedbackOpen(false);
      }
    } finally {
      setSendingFeedback(false);
    }
  };

  return (
    <div className="pid-wb-pane pid-wb-browser-pane">
      <form
        className="pid-wb-pane-header pid-wb-browser-header"
        draggable={draggableHeader}
        onDragStart={onHeaderDragStart}
        onDragEnd={onHeaderDragEnd}
        onSubmit={handleSubmit}
      >
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
          <button
            type="button"
            className="pid-wb-icon-btn"
            disabled={!canGoBack}
            title="后退"
            aria-label="后退"
            onClick={() => handleStepHistory(-1)}
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            className="pid-wb-icon-btn"
            disabled={!canGoForward}
            title="前进"
            aria-label="前进"
            onClick={() => handleStepHistory(1)}
          >
            <ChevronRight size={14} />
          </button>
          <button
            type="button"
            className="pid-wb-icon-btn"
            disabled={!activeUrl}
            title="重新加载预览"
            aria-label="重新加载预览"
            onClick={() => setReloadNonce((value) => value + 1)}
          >
            <RotateCw size={13} />
          </button>
          <button
            type="button"
            className="pid-wb-icon-btn"
            disabled={!activeUrl}
            title="在外部浏览器中打开"
            aria-label="在外部浏览器中打开"
            onClick={() => {
              if (activeUrl) void openUrl(activeUrl);
            }}
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
              <button
                type="button"
                role="menuitemradio"
                aria-checked={viewportMode === "responsive"}
                className={viewportMode === "responsive" ? "active" : undefined}
                onClick={() => { setViewportMode("responsive"); setMenuOpen(false); }}
              >
                <Maximize2 size={12} />
                <span>自适应</span>
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={viewportMode === "mobile"}
                className={viewportMode === "mobile" ? "active" : undefined}
                onClick={() => { setViewportMode("mobile"); setMenuOpen(false); }}
              >
                <Smartphone size={12} />
                <span>移动 (390px)</span>
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={viewportMode === "desktop"}
                className={viewportMode === "desktop" ? "active" : undefined}
                onClick={() => { setViewportMode("desktop"); setMenuOpen(false); }}
              >
                <Monitor size={12} />
                <span>桌面 (1280px)</span>
              </button>
              <div className="pid-wb-popover-sep" />
              <button
                type="button"
                role="menuitem"
                onClick={() => { setFeedbackOpen((open) => !open); setMenuOpen(false); }}
              >
                <MessageSquarePlus size={12} />
                <span>{feedbackOpen ? "隐藏反馈栏" : "反馈预览问题"}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => void handleDetectDevServer()}
              >
                <Globe size={12} />
                <span>检测开发服务器</span>
              </button>
            </div>
          </div>
          {paneControls}
        </div>
      </form>

      {feedbackOpen && (
        <div className="pid-wb-preview-feedback" role="region" aria-label="预览问题反馈">
          <div className="pid-wb-preview-feedback-chips">
            {FEEDBACK_QUICK_CHIPS.map((chip) => (
              <button
                key={chip}
                type="button"
                className="pid-wb-pill"
                onClick={() => setFeedbackText((prev) => (prev.trim() ? `${prev.trim()}，${chip}` : chip))}
              >
                {chip}
              </button>
            ))}
            <button
              type="button"
              className="pid-wb-icon-btn"
              style={{ marginLeft: "auto" }}
              title="关闭反馈栏"
              onClick={() => setFeedbackOpen(false)}
            >
              <X size={12} />
            </button>
          </div>
          <div className="pid-wb-preview-feedback-row">
            <input
              type="text"
              className="pid-wb-preview-feedback-input"
              placeholder="描述你在预览中看到的问题或修改建议…"
              value={feedbackText}
              onChange={(event) => setFeedbackText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSendFeedback(false);
                }
              }}
            />
            <button
              type="button"
              className="pid-wb-btn small"
              disabled={!feedbackText.trim()}
              onClick={() => void handleSendFeedback(true)}
            >
              填入输入框
            </button>
            <button
              type="button"
              className="pid-wb-btn small primary"
              disabled={!feedbackText.trim() || sendingFeedback}
              onClick={() => void handleSendFeedback(false)}
            >
              <Send size={11} />
              <span>{sendingFeedback ? "发送中…" : "发给 Agent"}</span>
            </button>
          </div>
        </div>
      )}

      {agentBrowser?.screenshot && (
        <div className="pid-wb-browser-snapshot">
          <div className="pid-wb-section-header">
            <span>Agent 浏览器最新快照：{agentBrowser.title}</span>
            {safeAgentBrowserUrl && (
              <button
                type="button"
                className="pid-wb-btn small"
                onClick={() => navigateUrl(safeAgentBrowserUrl)}
              >
                载入此地址
              </button>
            )}
          </div>
          <img
            className="pid-wb-browser-shot-img"
            src={`data:${agentBrowser.screenshot.mimeType};base64,${agentBrowser.screenshot.data}`}
            alt={agentBrowser.title}
          />
        </div>
      )}

      <div className={`pid-wb-preview-stage is-${viewportMode}`}>
        {isBlockedCandidate ? (
          <div className="pid-wb-empty error">
            <ShieldAlert size={22} className="pid-wb-empty-icon" />
            <p>已拦截不安全的预览地址：仅允许独立的 http:// 或 https:// 页面（禁止伪协议、内部 IPC 域名或宿主同源地址）。</p>
          </div>
        ) : activeUrl ? (
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
