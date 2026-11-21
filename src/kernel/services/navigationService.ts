/**
 * Frontend Cordis `navigationService` (ADR 0023 Phase 2).
 *
 * Owns main-stage route state (`home` / `session` / `hub` / `plugin-page`),
 * back/forward navigation history, settings modal/page state, primary sidebar
 * visibility/width, and mirrors `toasts`, `notifications`, `extensionRequest`,
 * and `extensionWidgets` from Qianji's store.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import {
  clampSize,
  readStoredSidebarPinned,
  readStoredSize,
  SIDEBAR_BOUNDS,
  SIDEBAR_WIDTH_KEY,
  writeStoredSidebarPinned,
  writeStoredSize,
} from "../../lib/panelLayout";
import { normalizeLocalPath } from "../../lib/pathIdentity";
import {
  requestOpenHubPage,
  requestOpenSettings,
  resolveSettingsPageId,
  type SettingsPageId,
} from "../../lib/shellBridge";
import { useAppStore } from "../../store";
import type {
  AppNotification,
  ExtensionUIRequest,
  Toast,
} from "../../types";
import { ServiceEmitter, shallowEqualObject, trackContextEffect } from "./shared";

export type { SettingsPageId };

declare module "@deepseek-ai/cordis" {
  interface Context {
    navigationService: NavigationService;
  }
}

export type NavigationHubView = "scheduled" | "plugins" | `plugin:${string}`;

export type NavigationRoute =
  | { readonly kind: "home"; readonly workspace: string }
  | { readonly kind: "session"; readonly cwd: string; readonly file: string }
  | { readonly kind: "hub"; readonly view: NavigationHubView }
  | { readonly kind: "plugin-page"; readonly pageId: string };

export interface NavigationSnapshot {
  readonly activeRoute: NavigationRoute;
  readonly hubView: NavigationHubView | null;
  readonly newTask: boolean;
  readonly draftMode: boolean;
  readonly settingsOpen: boolean;
  readonly settingsPage: SettingsPageId;
  readonly sidebarVisible: boolean;
  readonly sidebarWidth: number;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly toasts: readonly Toast[];
  readonly notifications: readonly AppNotification[];
  readonly extensionRequest: ExtensionUIRequest | null;
  readonly extensionWidgets: Readonly<Record<string, string[]>>;
}

export interface NavigationServiceOptions {
  /** Optional hook invoked when navigating to a session route; defaults to `useAppStore.getState().switchSession`. */
  onSwitchSession?: (cwd: string, file: string) => void | Promise<void>;
}

function routeKey(route: NavigationRoute): string {
  switch (route.kind) {
    case "home":
      return `home:${normalizeLocalPath(route.workspace)}`;
    case "session":
      return `session:${normalizeLocalPath(route.file)}`;
    case "hub":
      return `hub:${route.view}`;
    case "plugin-page":
      return `plugin-page:${route.pageId}`;
  }
}

function normalizePluginPageId(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("plugin:") ? trimmed.slice("plugin:".length) : trimmed;
}

interface NavigationInternalState {
  activeRoute: NavigationRoute;
  hubView: NavigationHubView | null;
  draftMode: boolean;
  settingsOpen: boolean;
  settingsPage: SettingsPageId;
  sidebarVisible: boolean;
  sidebarWidth: number;
  backStack: NavigationRoute[];
  forwardStack: NavigationRoute[];
  forwardingShellBridge: boolean;
  readonly onSwitchSession: (cwd: string, file: string) => void | Promise<void>;
  snapshot: NavigationSnapshot;
  readonly emitter: ServiceEmitter;
}

export class NavigationService extends Service {
  static provide = "navigationService";
  private readonly internal: NavigationInternalState;

  constructor(ctx: Context, options?: NavigationServiceOptions) {
    super(ctx, "navigationService");
    const app = useAppStore.getState();
    const initialDraft = app.sessionFile === null;
    const initialRoute: NavigationRoute = app.sessionFile === null
      ? { kind: "home", workspace: app.cwd }
      : { kind: "session", cwd: app.cwd, file: app.sessionFile };

    this.internal = {
      activeRoute: initialRoute,
      hubView: null,
      draftMode: initialDraft,
      settingsOpen: false,
      settingsPage: "general",
      sidebarVisible: readStoredSidebarPinned(),
      sidebarWidth: typeof window !== "undefined"
        ? readStoredSize(SIDEBAR_WIDTH_KEY, SIDEBAR_BOUNDS)
        : SIDEBAR_BOUNDS.fallback,
      backStack: [],
      forwardStack: [],
      forwardingShellBridge: false,
      onSwitchSession: options?.onSwitchSession
        ?? ((cwd, file) => useAppStore.getState().switchSession(cwd, file)),
      snapshot: null as unknown as NavigationSnapshot,
      emitter: new ServiceEmitter("navigationService"),
    };
    this.internal.snapshot = this.computeSnapshot();
    writeStoredSidebarPinned(this.internal.sidebarVisible);

    const offStore = useAppStore.subscribe(() => {
      const app = useAppStore.getState();
      if (!this.internal.draftMode && this.internal.hubView === null && app.sessionFile !== null) {
        if (
          this.internal.activeRoute.kind !== "session"
          || this.internal.activeRoute.file !== app.sessionFile
          || this.internal.activeRoute.cwd !== app.cwd
        ) {
          this.internal.activeRoute = { kind: "session", cwd: app.cwd, file: app.sessionFile };
        }
      }
      this.publish();
    });

    ctx.effect(() => () => {
      offStore();
      this.internal.emitter.clear();
    });
  }

  private computeSnapshot(): NavigationSnapshot {
    const app = useAppStore.getState();
    return {
      activeRoute: this.internal.activeRoute,
      hubView: this.internal.hubView,
      newTask: this.internal.draftMode,
      draftMode: this.internal.draftMode,
      settingsOpen: this.internal.settingsOpen,
      settingsPage: this.internal.settingsPage,
      sidebarVisible: this.internal.sidebarVisible,
      sidebarWidth: this.internal.sidebarWidth,
      canGoBack: this.internal.backStack.length > 0,
      canGoForward: this.internal.forwardStack.length > 0,
      toasts: app.toasts,
      notifications: app.notifications,
      extensionRequest: app.extensionRequest,
      extensionWidgets: app.extensionWidgets,
    };
  }

  private publish(): void {
    const next = this.computeSnapshot();
    if (!shallowEqualObject(this.internal.snapshot, next)) {
      this.internal.snapshot = next;
      this.internal.emitter.emit();
    }
  }

  private syncDraftWorkspace(workspace: string): void {
    const trimmed = workspace.trim();
    if (trimmed === "") return;
    const ws = (this.ctx as { get?(name: string): unknown }).get?.("workspaceService") as
      | { syncDraftWorkspace?(path: string): void }
      | undefined;
    ws?.syncDraftWorkspace?.(trimmed);
  }

  private resolveDraftWorkspace(): string {
    const ws = (this.ctx as { get?(name: string): unknown }).get?.("workspaceService") as
      | { getSnapshot?(): { draftWorkspace: string; cwd: string } }
      | undefined;
    const snap = ws?.getSnapshot?.();
    return snap?.draftWorkspace || snap?.cwd || useAppStore.getState().cwd || "";
  }

  private applyRoute(target: NavigationRoute, syncStore: boolean): void {
    switch (target.kind) {
      case "home":
        this.internal.activeRoute = { kind: "home", workspace: target.workspace };
        this.internal.hubView = null;
        this.internal.draftMode = true;
        this.syncDraftWorkspace(target.workspace);
        if (syncStore) {
          useAppStore.getState().prepareNewTask();
        }
        break;
      case "session":
        this.internal.activeRoute = { kind: "session", cwd: target.cwd, file: target.file };
        this.internal.hubView = null;
        this.internal.draftMode = false;
        this.syncDraftWorkspace(target.cwd);
        if (syncStore) {
          const current = useAppStore.getState();
          if (current.sessionFile !== target.file || current.connection !== "running") {
            void Promise.resolve(this.internal.onSwitchSession(target.cwd, target.file)).catch(() => undefined);
          }
        }
        break;
      case "hub":
        if (target.view.startsWith("plugin:")) {
          const pageId = normalizePluginPageId(target.view);
          this.internal.activeRoute = { kind: "plugin-page", pageId };
          this.internal.hubView = `plugin:${pageId}`;
        } else {
          this.internal.activeRoute = { kind: "hub", view: target.view };
          this.internal.hubView = target.view;
        }
        break;
      case "plugin-page": {
        const pageId = normalizePluginPageId(target.pageId);
        this.internal.activeRoute = { kind: "plugin-page", pageId };
        this.internal.hubView = `plugin:${pageId}`;
        this.internal.settingsOpen = false;
        break;
      }
    }
    this.publish();
  }

  getSnapshot(): NavigationSnapshot {
    return this.internal.snapshot;
  }

  subscribe(listener: () => void): () => void {
    const rawUnsub = this.internal.emitter.add(listener);
    return trackContextEffect(this.ctx, rawUnsub);
  }

  navigate(target: NavigationRoute, options?: { syncStore?: boolean }): void {
    const current = this.internal.activeRoute;
    const normalized: NavigationRoute = target.kind === "hub" && target.view.startsWith("plugin:")
      ? { kind: "plugin-page", pageId: normalizePluginPageId(target.view) }
      : target.kind === "plugin-page"
        ? { kind: "plugin-page", pageId: normalizePluginPageId(target.pageId) }
        : target;
    if (routeKey(current) === routeKey(normalized)) return;
    this.internal.backStack = [...this.internal.backStack, current];
    this.internal.forwardStack = [];
    this.applyRoute(normalized, options?.syncStore !== false);
  }

  goBack(options?: { syncStore?: boolean }): boolean {
    if (this.internal.backStack.length === 0) return false;
    const nextBack = [...this.internal.backStack];
    const target = nextBack.pop();
    if (!target) return false;
    this.internal.backStack = nextBack;
    this.internal.forwardStack = [...this.internal.forwardStack, this.internal.activeRoute];
    this.applyRoute(target, options?.syncStore !== false);
    return true;
  }

  goForward(options?: { syncStore?: boolean }): boolean {
    if (this.internal.forwardStack.length === 0) return false;
    const nextForward = [...this.internal.forwardStack];
    const target = nextForward.pop();
    if (!target) return false;
    this.internal.forwardStack = nextForward;
    this.internal.backStack = [...this.internal.backStack, this.internal.activeRoute];
    this.applyRoute(target, options?.syncStore !== false);
    return true;
  }

  forgetSessions(sessionFiles: readonly string[]): void {
    if (sessionFiles.length === 0) return;
    const dropped = new Set(sessionFiles.map(normalizeLocalPath));
    const keep = (route: NavigationRoute) =>
      route.kind !== "session" || !dropped.has(normalizeLocalPath(route.file));
    this.internal.backStack = this.internal.backStack.filter(keep);
    this.internal.forwardStack = this.internal.forwardStack.filter(keep);
    this.publish();
  }

  openSettings(page?: string): void {
    const resolved = resolveSettingsPageId(page);
    this.internal.settingsPage = resolved;
    this.internal.settingsOpen = true;
    this.publish();
    if (!this.internal.forwardingShellBridge) {
      this.internal.forwardingShellBridge = true;
      try {
        requestOpenSettings(resolved);
      } finally {
        this.internal.forwardingShellBridge = false;
      }
    }
  }

  closeSettings(): void {
    if (!this.internal.settingsOpen) return;
    this.internal.settingsOpen = false;
    this.publish();
  }

  openPluginPage(pageId: string): boolean {
    const cleanId = normalizePluginPageId(pageId);
    if (cleanId === "") return false;
    this.internal.settingsOpen = false;
    this.navigate({ kind: "plugin-page", pageId: cleanId });
    this.publish();
    if (!this.internal.forwardingShellBridge) {
      this.internal.forwardingShellBridge = true;
      try {
        requestOpenHubPage(cleanId);
      } finally {
        this.internal.forwardingShellBridge = false;
      }
    }
    return true;
  }

  setHubView(view: NavigationHubView | null): void {
    if (view === null) {
      const app = useAppStore.getState();
      this.internal.hubView = null;
      this.internal.activeRoute = !this.internal.draftMode && app.sessionFile !== null
        ? { kind: "session", cwd: app.cwd, file: app.sessionFile }
        : { kind: "home", workspace: this.resolveDraftWorkspace() };
      this.publish();
      return;
    }
    this.navigate({ kind: "hub", view });
  }

  setDraftMode(draftMode: boolean): void {
    this.internal.draftMode = draftMode;
    const app = useAppStore.getState();
    if (draftMode) {
      this.internal.hubView = null;
      this.internal.activeRoute = { kind: "home", workspace: this.resolveDraftWorkspace() };
    } else if (this.internal.hubView === null) {
      this.internal.activeRoute = { kind: "session", cwd: app.cwd, file: app.sessionFile ?? "" };
    }
    this.publish();
  }

  setSidebarVisible(visible: boolean): void {
    if (this.internal.sidebarVisible === visible) return;
    this.internal.sidebarVisible = visible;
    writeStoredSidebarPinned(visible);
    this.publish();
  }

  toggleSidebar(): void {
    this.setSidebarVisible(!this.internal.sidebarVisible);
  }

  setSidebarWidth(width: number): void {
    const clamped = clampSize(width, SIDEBAR_BOUNDS);
    if (this.internal.sidebarWidth === clamped) return;
    this.internal.sidebarWidth = clamped;
    if (typeof window !== "undefined") {
      writeStoredSize(SIDEBAR_WIDTH_KEY, clamped);
    }
    this.publish();
  }

  showToast(message: string, kind: Toast["kind"] | "success" = "info"): void {
    useAppStore.getState().showToast(message, kind === "success" ? "info" : kind);
  }

  dismissToast(id: string): void {
    useAppStore.getState().dismissToast(id);
  }

  markNotificationRead(id: string): void {
    useAppStore.getState().markNotificationRead(id);
  }

  markAllNotificationsRead(): void {
    useAppStore.getState().markAllNotificationsRead();
  }

  dismissNotification(id: string): void {
    useAppStore.getState().dismissNotification(id);
  }

  async answerExtension(response: {
    value?: string;
    confirmed?: boolean;
    cancelled?: true;
  }): Promise<void> {
    await useAppStore.getState().answerExtension(response);
  }
}
