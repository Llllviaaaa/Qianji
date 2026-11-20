/**
 * Un-overridable emergency Safe Mode recovery banner (ADR 0023 §5.2).
 *
 * Rendered outside `<SlotRoot />` directly by the microkernel host shell so no
 * user or workspace plugin can hide, override, or crash this recovery bar.
 */
import type { ReactNode } from "react";
import { requestOpenSettings } from "../../lib/shellBridge";
import {
  safeModeController,
  useSafeMode,
  type SafeModeController,
  type SafeModeReason,
} from "./safeMode";

export interface SafeModeBannerProps {
  /** Optional custom SafeModeController (defaults to singleton `safeModeController`). */
  readonly controller?: SafeModeController;
  /** Optional handler for opening Settings -> Plugins (defaults to `requestOpenSettings("plugins")`). */
  readonly onOpenPlugins?: () => void;
  /** Optional handler for exiting Safe Mode (defaults to `controller.disable()`). */
  readonly onExitSafeMode?: () => void;
}

export function describeSafeModeReason(reason: SafeModeReason | null): string {
  switch (reason) {
    case "query":
      return "通过 URL 参数 (?safeMode=1) 进入安全模式，已暂停全部用户与工作区客户端插件。";
    case "window-flag":
      return "通过启动参数 (--safe-mode) 进入安全模式，已暂停全部用户与工作区客户端插件。";
    case "session-storage":
      return "当前会话处于安全模式，已暂停全部用户与工作区客户端插件。";
    case "hotkey":
      return "已通过急救快捷键 (Ctrl+Shift+Alt+R) 进入安全模式，已暂停外部客户端插件。";
    case "manual":
    case null:
      return "已手动开启安全模式，仅运行内置核心层以确保界面可恢复。";
  }
}

/** Emergency Safe Mode banner mounted outside `<SlotRoot />`. */
export function SafeModeBanner({
  controller = safeModeController,
  onOpenPlugins,
  onExitSafeMode,
}: SafeModeBannerProps): ReactNode {
  const safeMode = useSafeMode(controller);
  if (!safeMode.active) {
    return null;
  }

  const handleOpenPlugins = (): void => {
    if (onOpenPlugins !== undefined) {
      onOpenPlugins();
      return;
    }
    requestOpenSettings("plugins");
  };

  const handleExitSafeMode = (): void => {
    if (onExitSafeMode !== undefined) {
      onExitSafeMode();
      return;
    }
    controller.disable();
  };

  return (
    <div
      role="alert"
      data-testid="safe-mode-banner"
      data-qj-safe-mode-reason={safeMode.reason ?? "manual"}
      style={{
        position: "relative",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: "12px",
        padding: "8px 16px",
        background: "var(--qj-status-warning-bg, rgba(245, 158, 11, 0.16))",
        color: "var(--qj-text-primary, #1f2937)",
        borderBottom: "1px solid var(--qj-status-warning-border, rgba(245, 158, 11, 0.45))",
        fontSize: "13px",
        lineHeight: 1.4,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
        <strong
          style={{
            color: "var(--qj-status-warning, #b45309)",
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          安全模式已启用
        </strong>
        <span data-testid="safe-mode-reason-text">{describeSafeModeReason(safeMode.reason)}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
        <button
          type="button"
          data-testid="safe-mode-open-plugins"
          onClick={handleOpenPlugins}
          style={{
            padding: "4px 10px",
            borderRadius: "6px",
            border: "1px solid var(--qj-border-default, rgba(120, 120, 120, 0.35))",
            background: "var(--qj-bg-elevated, #ffffff)",
            color: "var(--qj-text-primary, #1f2937)",
            fontSize: "12px",
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          打开插件管理排查
        </button>
        <button
          type="button"
          data-testid="safe-mode-exit"
          onClick={handleExitSafeMode}
          style={{
            padding: "4px 10px",
            borderRadius: "6px",
            border: "1px solid var(--qj-status-warning-border, rgba(245, 158, 11, 0.55))",
            background: "var(--qj-status-warning, #d97706)",
            color: "#ffffff",
            fontSize: "12px",
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          退出安全模式恢复外部插件
        </button>
      </div>
    </div>
  );
}
