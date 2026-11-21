import { useCallback, useState, useSyncExternalStore, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { BotHandoffCompleteResult } from "@qianji/protocol";
import {
  useClientContributions,
  useFrontendService,
  useNavigationState,
  useRpcState,
  useThemeState,
} from "@qianji/client";
import type { BoundRenderSlotFn } from "@qianji/client-slots";
import { LegacyContributionHost } from "./shellHelpers";

const NOOP_UNSUB = (): void => undefined;

export function useBotStageAvailable(ctx?: Context): boolean {
  const slotsRegistry = ctx?.slots?.registry;
  const subscribeSlots = useCallback(
    (listener: () => void) => (slotsRegistry === undefined ? NOOP_UNSUB : slotsRegistry.subscribe(listener)),
    [slotsRegistry],
  );
  const getSlotsVersion = useCallback(
    () => (slotsRegistry === undefined ? 0 : slotsRegistry.getVersion()),
    [slotsRegistry],
  );
  useSyncExternalStore(subscribeSlots, getSlotsVersion, getSlotsVersion);
  return (slotsRegistry?.getFactoryCandidates("bot.stage").length ?? 0) > 0;
}

/**
 * Top-right `[ Agent | Bot ]` spring-gliding capsule switcher (`#mode-pill`).
 * Stays anchored at identical coordinates across Agent & Bot modes.
 */
export function CoreShellModeSwitch({ ctx }: { readonly ctx?: Context }): ReactElement | null {
  const botAvailable = useBotStageAvailable(ctx);
  const navigationService = useFrontendService("navigationService", ctx);
  const navSnap = useNavigationState(ctx);
  const themeSnap = useThemeState(ctx);

  if (!botAvailable) {
    return null;
  }

  const mode = navSnap?.shellMode === "bot" ? "bot" : "agent";
  const shortcut = themeSnap?.shortcutToggleShellMode || "Ctrl+Shift+M";

  return (
    <div
      id="mode-pill"
      className="qj-mode-pill"
      data-mode={mode}
      role="tablist"
      aria-label={`切换 Agent 与 Bot 形态 (${shortcut})`}
      title={`切换 Agent / Bot 形态 (${shortcut})`}
    >
      <span id="mode-pill-thumb" className="qj-mode-pill-thumb" aria-hidden="true" />
      <button
        type="button"
        role="tab"
        aria-selected={mode === "agent"}
        data-mode-tab="agent"
        className={`qj-mode-pill-btn${mode === "agent" ? " active" : ""}`}
        onClick={() => navigationService?.setShellMode("agent")}
      >
        <span className="qj-mode-pill-dot" aria-hidden="true" />
        <span>Agent</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === "bot"}
        data-mode-tab="bot"
        className={`qj-mode-pill-btn${mode === "bot" ? " active" : ""}`}
        onClick={() => navigationService?.setShellMode("bot")}
      >
        <span className="qj-mode-pill-dot" aria-hidden="true" />
        <span>Bot</span>
      </button>
    </div>
  );
}

/**
 * Context handoff return bar rendered inside `CoreShellTopbar` when an active
 * Bot -> Agent task handoff is in flight.
 */
export function BotHandoffReturnChip({ ctx }: { readonly ctx?: Context }): ReactElement | null {
  const navigationService = useFrontendService("navigationService", ctx);
  const rpcService = useFrontendService("rpcService", ctx);
  const navSnap = useNavigationState(ctx);
  const [submitting, setSubmitting] = useState(false);

  const handoff = navSnap?.activeBotHandoff ?? null;
  if (handoff === null) {
    return null;
  }

  const handleReturn = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await rpcService?.call<BotHandoffCompleteResult>("bot.handoff.complete", {
        handoffId: handoff.id,
        title: handoff.title,
        summary: handoff.summary || `已在 Agent 工作台完成深度核验与变更审查：${handoff.title}`,
      });
    } catch {
      // Allow smooth return even when running in offline/mock UI environments.
    } finally {
      setSubmitting(false);
      navigationService?.finishBotHandoff(`已回传任务摘要 · ${handoff.title}`);
    }
  };

  return (
    <div className="qj-handoff-return-bar" data-testid="bot-handoff-return">
      <button
        type="button"
        className="qj-handoff-return-btn"
        disabled={submitting}
        onClick={() => void handleReturn()}
      >
        ← 完成并回传 Bot
      </button>
      <span className="qj-handoff-task-badge" title={handoff.summary}>
        来自 Bot · {handoff.title}
      </span>
    </div>
  );
}

export function CoreShellStatusbar({
  effectiveCwd,
  sessionFile,
  renderSlot,
  hasSlotStatusbarItems,
}: {
  readonly effectiveCwd: string;
  readonly sessionFile: string | null;
  readonly renderSlot: BoundRenderSlotFn;
  readonly hasSlotStatusbarItems: boolean;
}): ReactElement | null {
  const contributions = useClientContributions();
  const leftLegacyStatusItems = contributions.statusBarItems.filter((item) => item.align !== "right");
  const rightLegacyStatusItems = contributions.statusBarItems.filter((item) => item.align === "right");
  const showStatusbar = hasSlotStatusbarItems || contributions.statusBarItems.length > 0;

  if (!showStatusbar) return null;

  return (
    <footer className="qj-workspace-statusbar" role="status" aria-label="工作区状态栏">
      <div style={{ display: "inline-flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
        {renderSlot("shell.statusbar", { cwd: effectiveCwd, sessionFile, align: "left" })}
        {leftLegacyStatusItems.map((item) => (
          <LegacyContributionHost
            key={item.id}
            id={item.id}
            pluginId={item.pluginId}
            slotKey="status.bar"
            renderFn={item.render}
            context={{ cwd: effectiveCwd, sessionFile }}
            compact
          />
        ))}
      </div>
      <div style={{ display: "inline-flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
        {renderSlot("shell.statusbar", { cwd: effectiveCwd, sessionFile, align: "right" })}
        {rightLegacyStatusItems.map((item) => (
          <LegacyContributionHost
            key={item.id}
            id={item.id}
            pluginId={item.pluginId}
            slotKey="status.bar"
            renderFn={item.render}
            context={{ cwd: effectiveCwd, sessionFile }}
            compact
          />
        ))}
      </div>
    </footer>
  );
}

export function CoreShellGlobalChrome({
  ctx,
  effectiveCwd,
  sessionFile,
  renderSlot,
}: {
  readonly ctx?: Context;
  readonly effectiveCwd: string;
  readonly sessionFile: string | null;
  readonly renderSlot: BoundRenderSlotFn;
}): ReactElement {
  const navigationService = useFrontendService("navigationService", ctx);
  const rpcService = useFrontendService("rpcService", ctx);
  const navSnap = useNavigationState(ctx);
  const rpcSnap = useRpcState(ctx);
  const contributions = useClientContributions();

  const toasts = navSnap?.toasts ?? [];
  const handoffBannerText = navSnap?.handoffBannerText ?? null;

  return (
    <>
      {handoffBannerText !== null && (
        <div id="handoff-ribbon" className="qj-handoff-ribbon visible" role="status" aria-live="polite">
          <span className="qj-handoff-ribbon-dot" aria-hidden="true" />
          <span>{handoffBannerText}</span>
        </div>
      )}

      {/* Global overlays slot root enforces pointer-events: none (ADR 0016 / ADR 0023) */}
      <div
        className="client-plugin-overlay-slot"
        data-slot="shell.overlays"
        style={{ pointerEvents: "none" }}
      >
        {renderSlot("shell.overlays", { cwd: effectiveCwd, sessionFile })}
        {contributions.overlays.map((overlay) => (
          <LegacyContributionHost
            key={overlay.id}
            id={overlay.id}
            pluginId={overlay.pluginId}
            slotKey="overlays"
            renderFn={overlay.render}
            context={{ cwd: effectiveCwd, sessionFile }}
          />
        ))}
      </div>

      {renderSlot("shell.modals", { cwd: effectiveCwd, sessionFile })}

      {rpcSnap !== undefined && rpcSnap.hostStatus !== "connected" && (
        <div
          className={`host-status-banner${rpcSnap.hostStatus === "failed" ? " failed" : ""}`}
          role="status"
        >
          <span>
            {rpcSnap.hostStatus === "failed"
              ? "Harness 多次崩溃，已停止自动重启"
              : "Harness 已断开，正在重连…"}
          </span>
          {rpcSnap.hostStatus === "failed" && (
            <button type="button" onClick={() => void rpcService?.restartHost()}>
              重新启动
            </button>
          )}
        </div>
      )}

      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <button
            key={toast.id}
            type="button"
            className={`toast ${toast.kind}`}
            onClick={() => navigationService?.dismissToast(toast.id)}
          >
            {toast.message}
          </button>
        ))}
      </div>
    </>
  );
}
