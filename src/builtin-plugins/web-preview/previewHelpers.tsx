/**
 * URL sanitization, dev-server detection helpers, and feedback bar for
 * `web-preview` (`src/builtin-plugins/web-preview/previewHelpers.tsx`, ADR 0023).
 */
import type { ReactElement } from "react";
import { Send, X } from "lucide-react";

export type PreviewViewportMode = "responsive" | "mobile" | "desktop";

const FEEDBACK_QUICK_CHIPS = ["样式错位", "点击无响应", "白屏/报错"] as const;

export function normalizePreviewUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return trimmed;
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}

/**
 * Validate a candidate preview URL before embedding in a sandboxed iframe.
 * Allows only `http:` / `https:`, blocks internal Tauri/WebView2 IPC pseudo-hosts,
 * and blocks same-origin with the Qianji renderer shell.
 */
export function sanitizePreviewUrl(raw: string, hostOrigin?: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "" ||
    hostname === "tauri.localhost" ||
    hostname === "ipc.localhost" ||
    hostname === "asset.localhost" ||
    hostname.endsWith(".tauri.localhost") ||
    hostname.endsWith(".ipc.localhost") ||
    hostname.endsWith(".asset.localhost")
  ) {
    return null;
  }
  const effectiveHostOrigin =
    hostOrigin ?? (typeof window !== "undefined" && window.location !== undefined ? window.location.origin : undefined);
  if (
    effectiveHostOrigin !== undefined &&
    effectiveHostOrigin !== "" &&
    effectiveHostOrigin !== "null" &&
    parsed.origin.toLowerCase() === effectiveHostOrigin.toLowerCase()
  ) {
    return null;
  }
  return trimmed;
}

export function inferDevServerPort(pkgRaw: string): number {
  const portFlag = /--port(?:=|\s+)(\d{2,5})/.exec(pkgRaw) ?? /-p\s+(\d{2,5})/.exec(pkgRaw);
  if (portFlag?.[1] !== undefined) {
    const parsed = Number.parseInt(portFlag[1], 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) return parsed;
  }
  if (/astro/i.test(pkgRaw)) return 4321;
  if (/next\b|nuxt|react-scripts/i.test(pkgRaw)) return 3000;
  if (/webpack-dev-server/i.test(pkgRaw)) return 8080;
  return 5173;
}

export function PreviewFeedbackBar({
  feedbackText,
  sending,
  onChangeText,
  onAppendChip,
  onClose,
  onPrefill,
  onSend,
}: {
  readonly feedbackText: string;
  readonly sending: boolean;
  readonly onChangeText: (text: string) => void;
  readonly onAppendChip: (chip: string) => void;
  readonly onClose: () => void;
  readonly onPrefill: () => void;
  readonly onSend: () => void;
}): ReactElement {
  return (
    <div className="pid-wb-preview-feedback" role="region" aria-label="预览问题反馈">
      <div className="pid-wb-preview-feedback-chips">
        {FEEDBACK_QUICK_CHIPS.map((chip) => (
          <button key={chip} type="button" className="pid-wb-pill" onClick={() => onAppendChip(chip)}>
            {chip}
          </button>
        ))}
        <button type="button" className="pid-wb-icon-btn" style={{ marginLeft: "auto" }} title="关闭反馈栏" onClick={onClose}>
          <X size={12} />
        </button>
      </div>
      <div className="pid-wb-preview-feedback-row">
        <input
          type="text"
          className="pid-wb-preview-feedback-input"
          placeholder="描述你在预览中看到的问题或修改建议…"
          value={feedbackText}
          onChange={(event) => onChangeText(event.target.value)}
        />
        <button type="button" className="pid-wb-btn small" disabled={feedbackText.trim() === ""} onClick={onPrefill}>
          填入输入框
        </button>
        <button type="button" className="pid-wb-btn small primary" disabled={feedbackText.trim() === "" || sending} onClick={onSend}>
          <Send size={11} />
          <span>{sending ? "发送中…" : "发给 Agent"}</span>
        </button>
      </div>
    </div>
  );
}
