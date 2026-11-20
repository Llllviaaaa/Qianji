/**
 * Frontend Safe Mode emergency controller (ADR 0023 §5.2).
 *
 * Reads initial state from:
 *   1. URL query parameter `?safeMode=1` (or `?safeMode=true`)
 *   2. `window.__QIANJI_SAFE_MODE__` (injected by Tauri `--safe-mode` CLI flag)
 *   3. `sessionStorage["qianji:safe-mode"]`
 *
 * Installs an un-overridable window capture listener for `Ctrl+Shift+Alt+R`
 * (`Cmd+Shift+Alt+R` on macOS) that toggles Safe Mode immediately. While active,
 * all `user` and `workspace` external client plugins are paused while the builtin
 * core layer stays active so the app can never brick on a faulty plugin.
 */
import { useSyncExternalStore } from "react";
import type { PluginChangedNotification, PluginInfo } from "@qianji/protocol";

export const SAFE_MODE_STORAGE_KEY = "qianji:safe-mode";

export type SafeModeReason = "query" | "window-flag" | "session-storage" | "hotkey" | "manual";

export interface SafeModeSnapshot {
  readonly active: boolean;
  readonly enabled: boolean;
  readonly reason: SafeModeReason | null;
  readonly toggledCount: number;
}

export interface SafeModeStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SafeModeKeyEventLike {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly repeat?: boolean;
  preventDefault(): void;
  stopImmediatePropagation?(): void;
  stopPropagation?(): void;
}

export interface SafeModeWindowLike {
  __QIANJI_SAFE_MODE__?: boolean;
  readonly location?: { readonly search?: string };
  readonly navigator?: { readonly platform?: string; readonly userAgent?: string };
  readonly sessionStorage?: SafeModeStorageLike;
  addEventListener(
    type: string,
    listener: (event: SafeModeKeyEventLike) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: SafeModeKeyEventLike) => void,
    options?: boolean | EventListenerOptions,
  ): void;
}

export interface SafeModeControllerOptions {
  readonly windowLike?: SafeModeWindowLike | null;
  readonly storage?: SafeModeStorageLike | null;
  readonly search?: string;
  readonly isMac?: boolean;
}

function detectMacPlatform(win?: SafeModeWindowLike | null): boolean {
  const nav = win?.navigator ?? (typeof navigator !== "undefined" ? navigator : undefined);
  const hint = `${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`;
  return /mac|iphone|ipad|ipod/i.test(hint);
}

/** Match the reserved Safe Mode shortcut: `Ctrl+Shift+Alt+R` (`Cmd+Shift+Alt+R` on macOS). */
export function isSafeModeHotkeyEvent(event: SafeModeKeyEventLike, isMac?: boolean): boolean {
  if (event.repeat === true) return false;
  if (!event.shiftKey || !event.altKey) return false;
  const mac = isMac ?? detectMacPlatform();
  const primaryModifier = mac ? event.metaKey || event.ctrlKey : event.ctrlKey;
  if (!primaryModifier) return false;
  return event.code === "KeyR" || event.key.toLowerCase() === "r";
}

function readTruthyFlag(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function detectInitialSafeMode(
  win: SafeModeWindowLike | null,
  storage: SafeModeStorageLike | null,
  explicitSearch?: string,
): { enabled: boolean; reason: SafeModeReason | null } {
  const search = explicitSearch ?? win?.location?.search ?? "";
  if (search !== "") {
    try {
      const params = new URLSearchParams(search);
      if (readTruthyFlag(params.get("safeMode"))) {
        return { enabled: true, reason: "query" };
      }
    } catch {
      // Ignore malformed query strings.
    }
  }
  if (win?.__QIANJI_SAFE_MODE__ === true) {
    return { enabled: true, reason: "window-flag" };
  }
  if (storage !== null) {
    try {
      if (readTruthyFlag(storage.getItem(SAFE_MODE_STORAGE_KEY))) {
        return { enabled: true, reason: "session-storage" };
      }
    } catch {
      // Storage may be disabled in restricted WebView contexts.
    }
  }
  return { enabled: false, reason: null };
}

export class SafeModeController {
  private readonly win: SafeModeWindowLike | null;
  private readonly storage: SafeModeStorageLike | null;
  private readonly isMacOverride: boolean | undefined;
  private readonly explicitSearch: string | undefined;
  private readonly listeners = new Set<() => void>();
  private snapshot: SafeModeSnapshot;
  private installed = false;
  private keydownHandler: ((event: SafeModeKeyEventLike) => void) | null = null;

  constructor(options: SafeModeControllerOptions = {}) {
    const defaultWin = typeof window !== "undefined" ? (window as unknown as SafeModeWindowLike) : null;
    this.win = options.windowLike === undefined ? defaultWin : options.windowLike;
    this.storage = options.storage === undefined ? (this.win?.sessionStorage ?? null) : options.storage;
    this.isMacOverride = options.isMac;
    this.explicitSearch = options.search;
    const initial = detectInitialSafeMode(this.win, this.storage, this.explicitSearch);
    this.snapshot = {
      active: initial.enabled,
      enabled: initial.enabled,
      reason: initial.reason,
      toggledCount: 0,
    };
  }

  /** Register the un-overridable window capture listener for the Safe Mode hotkey. */
  install(): () => void {
    if (this.installed || this.win === null) {
      return () => this.uninstall();
    }
    const mac = this.isMacOverride ?? detectMacPlatform(this.win);
    const handler = (event: SafeModeKeyEventLike): void => {
      if (!isSafeModeHotkeyEvent(event, mac)) return;
      event.preventDefault();
      event.stopImmediatePropagation?.();
      event.stopPropagation?.();
      this.toggle("hotkey");
    };
    this.keydownHandler = handler;
    this.win.addEventListener("keydown", handler, { capture: true });
    this.installed = true;
    return () => this.uninstall();
  }

  uninstall(): void {
    if (!this.installed || this.win === null || this.keydownHandler === null) return;
    this.win.removeEventListener("keydown", this.keydownHandler, { capture: true });
    this.keydownHandler = null;
    this.installed = false;
  }

  isEnabled(): boolean {
    return this.snapshot.enabled;
  }

  getSnapshot = (): SafeModeSnapshot => this.snapshot;

  setEnabled(enabled: boolean, reason: SafeModeReason = "manual"): void {
    if (this.snapshot.enabled === enabled) return;
    this.persistStorage(enabled);
    this.snapshot = {
      active: enabled,
      enabled,
      reason: enabled ? reason : null,
      toggledCount: this.snapshot.toggledCount + 1,
    };
    this.emit();
  }

  enable(reason: SafeModeReason = "manual"): void {
    this.setEnabled(true, reason);
  }

  disable(): void {
    this.setEnabled(false, "manual");
  }

  toggle(reason: SafeModeReason = "manual"): boolean {
    const next = !this.snapshot.enabled;
    this.setEnabled(next, reason);
    return next;
  }

  /** Re-sync initial detection from query / window flag / sessionStorage (useful in tests). */
  refreshFromEnvironment(): void {
    const detected = detectInitialSafeMode(this.win, this.storage, this.explicitSearch);
    if (detected.enabled === this.snapshot.enabled && detected.reason === this.snapshot.reason) {
      return;
    }
    this.snapshot = {
      active: detected.enabled,
      enabled: detected.enabled,
      reason: detected.reason,
      toggledCount: this.snapshot.toggledCount,
    };
    this.emit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private persistStorage(enabled: boolean): void {
    if (this.storage === null) return;
    try {
      if (enabled) {
        this.storage.setItem(SAFE_MODE_STORAGE_KEY, "1");
      } else {
        this.storage.removeItem(SAFE_MODE_STORAGE_KEY);
      }
    } catch {
      // Ignore storage write failures in restricted environments.
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function createSafeModeController(options?: SafeModeControllerOptions): SafeModeController {
  return new SafeModeController(options);
}

export const safeModeController = new SafeModeController();

export function useSafeMode(controller: SafeModeController = safeModeController): SafeModeSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}

export interface SafeModeTransportLike {
  list(workspace?: string): Promise<PluginInfo[]>;
  onChanged(listener: (payload?: PluginChangedNotification) => void): () => void;
}

/**
 * Wrap a client plugin runtime transport so that whenever Safe Mode is active,
 * all `user` and `workspace` external client plugins are paused (`hasClient: false`)
 * while `builtin` plugins continue running unimpeded. Toggling Safe Mode emits a
 * change notification so the runtime reconciles immediately without reloading.
 */
export function createSafeModeGatedTransport<T extends SafeModeTransportLike>(
  transport: T,
  controller: SafeModeController = safeModeController,
  onPluginsListed?: (plugins: readonly PluginInfo[]) => void,
): T {
  return {
    ...transport,
    async list(workspace?: string): Promise<PluginInfo[]> {
      const plugins = await transport.list(workspace);
      onPluginsListed?.(plugins);
      if (!controller.isEnabled()) {
        return plugins;
      }
      return plugins.map((item) =>
        item.tier === "builtin"
          ? item
          : { ...item, hasClient: false },
      );
    },
    onChanged(listener: (payload?: PluginChangedNotification) => void): () => void {
      const offTransport = transport.onChanged(listener);
      const offSafeMode = controller.subscribe(() => {
        listener(undefined);
      });
      return () => {
        offTransport();
        offSafeMode();
      };
    },
  };
}
