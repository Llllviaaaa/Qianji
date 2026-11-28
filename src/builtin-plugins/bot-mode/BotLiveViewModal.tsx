/**
 * Real interactive Live View & Manual Takeover modal (`查看实时画面`) for Qianji Bot Mode.
 *
 * Tab 1: Live `1280×900` CDP screenshot stream of Bot's isolated browser profile with real
 *        URL navigation, click-coordinate forwarding, scroll forwarding, and keyboard input.
 * Tab 2: Live WSL2 / Remote SSH container state, mounts, cgroup limits & interactive terminal check.
 */
import { useEffect, useState, type FormEvent, type MouseEvent, type ReactElement, type WheelEvent } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { useFrontendService } from "@qianji/client";
import type { BotLiveViewExecDiagResult, BotLiveViewSnapshot } from "@qianji/protocol";
import { BotIcon } from "./BotAvatarArt";
import { openBotModal, patchBotUi, useBotSnapshot, useBotUiState } from "./botStore";

const QUICK_DIAG_COMMANDS = [
  "uname -a && id",
  "ls -la /mnt/c 2>&1 || true",
  "cat /sys/fs/cgroup/qianji-bot/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/qianji-bot/memory.limit_in_bytes 2>/dev/null || echo no-cgroup",
  "df -h /workspace",
];

export function BotLiveViewModal({
  ctx,
  onClose,
}: {
  readonly ctx?: Context;
  readonly onClose: () => void;
}): ReactElement {
  const rpcService = useFrontendService("rpcService", ctx);
  const botSnap = useBotSnapshot();
  const ui = useBotUiState();

  const [initialTargetUrl] = useState<string | null>(() => ui.liveViewTargetUrl);
  const [tab, setTab] = useState<"browser" | "container">("browser");
  const [liveSnap, setLiveSnap] = useState<BotLiveViewSnapshot | null>(null);
  const [urlInput, setUrlInput] = useState(() => ui.liveViewTargetUrl || "https://example.com");
  const [typeInput, setTypeInput] = useState("");
  const [busy, setBusy] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [diagCmd, setDiagCmd] = useState("uname -a && id");
  const [diagRes, setDiagRes] = useState<BotLiveViewExecDiagResult | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);

  useEffect(() => {
    if (!rpcService) return undefined;
    let cancelled = false;
    const req = initialTargetUrl
      ? rpcService.call<BotLiveViewSnapshot>("bot.liveView.navigate", { url: initialTargetUrl })
      : rpcService.call<BotLiveViewSnapshot>("bot.liveView.snapshot", {});
    req
      .then((res) => {
        if (cancelled) return;
        setLiveSnap(res);
        if (res.url && res.url !== "about:qianji-live-view") setUrlInput(res.url);
        setErrorMsg(null);
        if (initialTargetUrl) {
          patchBotUi({ liveViewTargetUrl: null });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialTargetUrl, rpcService]);

  const callViewRpc = async (method: string, params: Record<string, unknown>) => {
    if (!rpcService || busy) return;
    setBusy(true);
    try {
      const next = await rpcService.call<BotLiveViewSnapshot>(method, params);
      setLiveSnap(next);
      if (next.url && next.url !== "about:qianji-live-view") setUrlInput(next.url);
      setErrorMsg(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleNavigate = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = urlInput.trim();
    if (trimmed === "") return;
    void callViewRpc("bot.liveView.navigate", { url: trimmed });
  };

  const handleScreenClick = (e: MouseEvent<HTMLImageElement>) => {
    if (!liveSnap || busy) return;
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const cssWidth = liveSnap.viewport.width;
    const cssHeight =
      img.naturalWidth > 0
        ? Math.round(img.naturalHeight * (cssWidth / img.naturalWidth))
        : liveSnap.viewport.height;
    const x = Math.round(((e.clientX - rect.left) / rect.width) * cssWidth);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * cssHeight);
    void callViewRpc("bot.liveView.click", { x, y });
  };

  const handleScreenWheel = (e: WheelEvent<HTMLImageElement>) => {
    if (busy || (e.deltaX === 0 && e.deltaY === 0)) return;
    void callViewRpc("bot.liveView.scroll", { deltaX: Math.round(e.deltaX), deltaY: Math.round(e.deltaY) });
  };

  const runDiagCommand = async (cmdOverride?: string) => {
    if (!rpcService || diagBusy) return;
    const cmd = (cmdOverride ?? diagCmd).trim();
    if (cmd === "") return;
    setDiagCmd(cmd);
    setDiagBusy(true);
    try {
      const res = await rpcService.call<BotLiveViewExecDiagResult>("bot.liveView.execDiag", { command: cmd });
      setDiagRes(res);
    } catch (err) {
      setDiagRes({ stdout: "", stderr: err instanceof Error ? err.message : String(err), exitCode: 1 });
    } finally {
      setDiagBusy(false);
    }
  };

  const summary = liveSnap?.containerSummary;

  return (
    <div className="qj-bot-modal-backdrop" onClick={onClose} data-testid="bot-liveview-modal">
      <div
        className="qj-bot-dialog"
        style={{ width: 860, maxWidth: "95vw", maxHeight: "90vh", padding: 20, display: "flex", flexDirection: "column", gap: 14 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header + Mode Tabs */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 16, fontWeight: 600 }}>虚拟服务器实时画面与接管</span>
            <div style={{ display: "inline-flex", gap: 4, padding: 3, borderRadius: 9999, background: "var(--muse-soft-fill)" }}>
              <button
                type="button"
                onClick={() => setTab("browser")}
                style={{
                  border: 0,
                  borderRadius: 9999,
                  padding: "4px 12px",
                  fontSize: 12,
                  fontWeight: 520,
                  cursor: "pointer",
                  background: tab === "browser" ? "var(--qj-bg-surface)" : "transparent",
                  color: "var(--qj-text-primary)",
                }}
              >
                受控浏览器画面
              </button>
              <button
                type="button"
                onClick={() => setTab("container")}
                style={{
                  border: 0,
                  borderRadius: 9999,
                  padding: "4px 12px",
                  fontSize: 12,
                  fontWeight: 520,
                  cursor: "pointer",
                  background: tab === "container" ? "var(--qj-bg-surface)" : "transparent",
                  color: "var(--qj-text-primary)",
                }}
              >
                容器内核与终端核验
              </button>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              className="qj-soft-btn"
              style={{ height: 30, padding: "0 12px", fontSize: 12 }}
              onClick={() => openBotModal("settings", "server")}
            >
              虚拟服务器设置
            </button>
            <button
              type="button"
              aria-label="关闭画面"
              onClick={onClose}
              style={{ width: 30, height: 30, borderRadius: 9999, border: 0, background: "transparent", color: "var(--qj-text-secondary)", cursor: "pointer", display: "grid", placeItems: "center" }}
            >
              <BotIcon name="closeX" />
            </button>
          </div>
        </div>

        {tab === "browser" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0 }}>
            <form onSubmit={handleNavigate} style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                aria-label="隔离浏览器地址栏"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="输入网址直接访问或接管登录（如 https://github.com/login）"
                style={{
                  flex: 1,
                  padding: "7px 12px",
                  borderRadius: 12,
                  border: "1px solid var(--qj-border-default)",
                  background: "var(--muse-soft-fill)",
                  color: "var(--qj-text-primary)",
                  fontFamily: "var(--qj-font-mono)",
                  fontSize: 12.5,
                  outline: "none",
                }}
              />
              <button type="submit" className="qj-primary-pill-btn" style={{ height: 34, padding: "0 14px", fontSize: 12 }} disabled={busy}>
                前往
              </button>
              <button type="button" className="qj-soft-btn" style={{ height: 34, padding: "0 12px", fontSize: 12 }} disabled={busy} onClick={() => void callViewRpc("bot.liveView.snapshot", {})}>
                刷新
              </button>
            </form>

            {errorMsg && (
              <div style={{ padding: 12, borderRadius: 12, background: "var(--muse-soft-fill)", color: "var(--qj-status-error)", fontSize: 12 }}>
                {errorMsg}
              </div>
            )}

            <div
              style={{
                borderRadius: 14,
                overflow: "hidden",
                border: "1px solid var(--qj-border-default)",
                background: "#111214",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                maxHeight: 430,
              }}
            >
              {liveSnap?.screenshotBase64 ? (
                <img
                  src={`data:image/png;base64,${liveSnap.screenshotBase64}`}
                  alt={liveSnap.title}
                  onClick={handleScreenClick}
                  onWheel={handleScreenWheel}
                  style={{ width: "auto", height: "auto", maxWidth: "100%", maxHeight: 430, cursor: busy ? "wait" : "crosshair", display: "block" }}
                />
              ) : (
                <div style={{ height: 320, display: "grid", placeItems: "center", color: "#9ca3af", fontSize: 13 }}>
                  {busy ? "正在启动隔离浏览器实时画面…" : "点击「刷新」启动受控隔离浏览器"}
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="text"
                aria-label="向焦点元素输入文本"
                value={typeInput}
                onChange={(e) => setTypeInput(e.target.value)}
                placeholder="先点击上方画面中的输入框，再在此输入文本发送（不会泄露到宿主机浏览器）…"
                style={{
                  flex: 1,
                  padding: "7px 12px",
                  borderRadius: 12,
                  border: 0,
                  background: "var(--muse-soft-fill)",
                  color: "var(--qj-text-primary)",
                  fontSize: 12.5,
                  outline: "none",
                }}
              />
              <button
                type="button"
                className="qj-soft-btn"
                style={{ height: 32, padding: "0 12px", fontSize: 12 }}
                disabled={busy || typeInput === ""}
                onClick={() => {
                  const text = typeInput;
                  setTypeInput("");
                  void callViewRpc("bot.liveView.type", { text });
                }}
              >
                发送输入
              </button>
              <button
                type="button"
                className="qj-soft-btn"
                style={{ height: 32, padding: "0 10px", fontSize: 12 }}
                disabled={busy}
                onClick={() => void callViewRpc("bot.liveView.type", { key: "Enter" })}
              >
                Enter
              </button>
              <button
                type="button"
                className="qj-soft-btn"
                style={{ height: 32, padding: "0 10px", fontSize: 12 }}
                disabled={busy}
                onClick={() => void callViewRpc("bot.liveView.type", { key: "Tab" })}
              >
                Tab
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 12.5 }}>
            <div style={{ padding: 14, borderRadius: 16, background: "var(--muse-soft-fill)", display: "flex", flexDirection: "column", gap: 6 }}>
              <div><strong>运行底座：</strong>{summary?.engine ?? (botSnap.virtualServer.mode === "remote" ? "远端 SSH 虚拟服务器" : "WSL2 容器")}</div>
              <div><strong>内核 / 主机：</strong><span style={{ fontFamily: "var(--qj-font-mono)" }}>{summary?.kernelOrHost ?? botSnap.virtualServer.local.kernelVersion ?? "-"}</span></div>
              <div><strong>资源配额：</strong><span style={{ fontFamily: "var(--qj-font-mono)" }}>{summary?.cgroupSummary ?? `${botSnap.virtualServer.local.cpuCores} 核 · ${botSnap.virtualServer.local.memoryLimitGb} GB`}</span></div>
              <div><strong>命名空间挂载：</strong><span style={{ fontFamily: "var(--qj-font-mono)" }}>{(summary?.mounts ?? ["/workspace -> bot-workspace (rw)"]).join(" | ")}</span></div>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {QUICK_DIAG_COMMANDS.map((cmd) => (
                <button
                  key={cmd}
                  type="button"
                  className="qj-soft-btn"
                  style={{ padding: "4px 10px", fontSize: 11.5, fontFamily: "var(--qj-font-mono)" }}
                  onClick={() => void runDiagCommand(cmd)}
                >
                  {cmd.split(" ")[0]} {cmd.split(" ")[1] ?? ""}
                </button>
              ))}
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                aria-label="容器诊断命令"
                value={diagCmd}
                onChange={(e) => setDiagCmd(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runDiagCommand();
                }}
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  borderRadius: 12,
                  border: 0,
                  background: "var(--muse-soft-fill)",
                  color: "var(--qj-text-primary)",
                  fontFamily: "var(--qj-font-mono)",
                  fontSize: 12.5,
                  outline: "none",
                }}
              />
              <button type="button" className="qj-primary-pill-btn" style={{ height: 34, padding: "0 14px", fontSize: 12 }} disabled={diagBusy} onClick={() => void runDiagCommand()}>
                {diagBusy ? "执行中…" : "在容器内执行"}
              </button>
            </div>

            <pre
              style={{
                margin: 0,
                minHeight: 160,
                maxHeight: 240,
                overflow: "auto",
                padding: 12,
                borderRadius: 14,
                background: "#111214",
                color: "#e5e7eb",
                fontFamily: "var(--qj-font-mono)",
                fontSize: 12,
                lineHeight: 1.55,
                whiteSpace: "pre-wrap",
              }}
            >
              {diagRes
                ? `${diagRes.stdout}${diagRes.stderr ? `\n[stderr] ${diagRes.stderr}` : ""}\n[exit: ${diagRes.exitCode}]`
                : "点击「在容器内执行」或上方快捷指令，实时验证 WSL2 / SSH 隔离环境。"}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
