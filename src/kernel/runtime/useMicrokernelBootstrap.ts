/**
 * Microkernel host runtime bootstrap hook (`src/kernel/runtime/useMicrokernelBootstrap.ts`).
 *
 * Keeps `src/App.tsx` a pure microkernel entry stub (`<= 150` lines) while preserving
 * Tauri runtime recovery, E2E stub bootstrap, dev fixtures, plugin runtime workspace
 * sync, shell navigation & rewind bridges, scheduled task notifications, and file
 * opener providers shared across core and external plugins.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { Context } from "@deepseek-ai/cordis";
import { preferredEditorFor } from "../../lib/workspaceEditors";
import { useRuntimeBootstrap } from "../../hooks/useRuntimeBootstrap";
import { agent } from "../../lib/agent";
import { clientContributions } from "../../lib/clientContributions";
import { ensureClientPluginRuntime, getClientRootContext } from "../../lib/clientPluginBootstrap";
import { describeError } from "../../lib/errors";
import { harnessRuntimes } from "../../lib/harnessRuntime";
import { installPluginKeybindings } from "../../lib/pluginKeybindings";
import { hasActiveStreamingTasks } from "../../lib/quitGuard";
import { rewindController } from "../../lib/rewindController";
import { scheduleClient } from "../../lib/scheduleClient";
import { bindShellNavigation } from "../../lib/shellBridge";
import { useAppStore } from "../../store";
import { useIntelligentUiStore } from "../../stores/intelligentUiStore";
import { bindWorkbenchNotifications, useWorkbenchStore } from "../../stores/workbenchStore";
import type { WorkspaceEditorInfo } from "../../types";
import { useSafeMode, type SafeModeSnapshot } from "./safeMode";

const DEV_CONVERSATION_FIXTURES = new Set([
  "thread",
  "performance",
  "stream",
  "queue",
  "title",
  "diagrams",
  "goal",
]);

const NOOP_UNSUB = (): void => undefined;

export interface MicrokernelFileActionsConfig {
  readonly workspace: string;
  readonly editors: WorkspaceEditorInfo[];
  readonly preferredEditor: WorkspaceEditorInfo | null;
  readonly onOpenPreview: (path: string, line?: number) => void;
  readonly onAddToChat: (path: string) => void;
  readonly onNotify: (message: string, tone: "info" | "error") => void;
}

export interface MicrokernelBootstrapResult {
  readonly root: Context;
  readonly safeMode: SafeModeSnapshot;
  readonly fileActions: MicrokernelFileActionsConfig;
}

function getBootedRootContext(): Context {
  ensureClientPluginRuntime();
  const root = getClientRootContext();
  if (root === undefined) {
    throw new Error("Microkernel root context failed to initialize");
  }
  return root;
}

function activeComposerKey(): string {
  const state = useAppStore.getState();
  return state.sessionId ?? state.sessionFile ?? "__draft__";
}

export function useMicrokernelBootstrap(): MicrokernelBootstrapResult {
  const root = useMemo(() => getBootedRootContext(), []);
  const safeMode = useSafeMode();
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  const navSnap = useSyncExternalStore(
    useCallback(
      (listener: () => void) => root.navigationService?.subscribe(listener) ?? NOOP_UNSUB,
      [root],
    ),
    useCallback(() => root.navigationService?.getSnapshot(), [root]),
    useCallback(() => root.navigationService?.getSnapshot(), [root]),
  );

  const wsSnap = useSyncExternalStore(
    useCallback(
      (listener: () => void) => root.workspaceService?.subscribe(listener) ?? NOOP_UNSUB,
      [root],
    ),
    useCallback(() => root.workspaceService?.getSnapshot(), [root]),
    useCallback(() => root.workspaceService?.getSnapshot(), [root]),
  );

  const connection = useAppStore((s) => s.connection);
  const sessions = useAppStore((s) => s.sessions);
  const settings = useAppStore((s) => s.settings);
  const runtimeId = useAppStore((s) => s.runtimeId);
  const cwd = useAppStore((s) => s.cwd);
  const sessionFile = useAppStore((s) => s.sessionFile);
  const isStreaming = useAppStore((s) => s.isStreaming);
  const isCompacting = useAppStore((s) => s.isCompacting);
  const runtimes = useAppStore((s) => s.runtimes);
  const setViewedSession = useAppStore((s) => s.setViewedSession);

  const adapterStreamingIds = useSyncExternalStore(
    harnessRuntimes.subscribeStreaming,
    harnessRuntimes.getStreamingRuntimeIdsSnapshot,
    harnessRuntimes.getStreamingRuntimeIdsSnapshot,
  );
  const anyTaskStreaming = useMemo(
    () => hasActiveStreamingTasks({ runtimeId, isStreaming, isCompacting, runtimes }, adapterStreamingIds),
    [runtimeId, isStreaming, isCompacting, runtimes, adapterStreamingIds],
  );

  const draftMode = navSnap?.draftMode ?? true;
  const hubView = navSnap?.hubView ?? null;
  const settingsOpen = navSnap?.settingsOpen ?? false;
  const effectiveWorkspace = wsSnap?.cwd || cwd;
  const activeWorkspaceRef = useRef(effectiveWorkspace);
  useEffect(() => {
    activeWorkspaceRef.current = effectiveWorkspace;
  }, [effectiveWorkspace]);

  const handleDraftModeChange = useCallback(
    (nextDraft: boolean) => {
      root.navigationService?.setDraftMode(nextDraft);
    },
    [root],
  );
  const handleDraftWorkspaceChange = useCallback(
    (nextWorkspace: string) => {
      root.workspaceService?.selectWorkspace(nextWorkspace);
    },
    [root],
  );

  const { runtimeRecoveryDone, startupAutoConnectRef } = useRuntimeBootstrap({
    isTauri,
    connection,
    sessions,
    autoConnect: settings?.autoConnect ?? false,
    runtimeId,
    cwd,
    sessionFile,
    draftMode,
    onDraftModeChange: handleDraftModeChange,
    onDraftWorkspaceChange: handleDraftWorkspaceChange,
  });

  // Pre-connect the draft workspace after Tauri runtime recovery so models, slash commands,
  // and workspace status are ready immediately on the home screen.
  useEffect(() => {
    const targetWorkspace = (wsSnap?.draftWorkspace || settings?.defaultWorkspace || "").trim();
    if (!isTauri || targetWorkspace === "") return;
    if (!runtimeRecoveryDone || !draftMode || hubView !== null || connection !== "disconnected" || startupAutoConnectRef.current) {
      return;
    }
    void useAppStore.getState().connect(targetWorkspace).catch(() => undefined);
  }, [connection, draftMode, hubView, isTauri, runtimeRecoveryDone, settings?.defaultWorkspace, startupAutoConnectRef, wsSnap?.draftWorkspace]);

  // Preserve dev fixture conversation routes (`?fixture=thread|performance|stream|...`).
  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === "undefined") return;
    const fixture = new URLSearchParams(window.location.search).get("fixture");
    if (fixture !== null && DEV_CONVERSATION_FIXTURES.has(fixture)) {
      root.navigationService?.setDraftMode(false);
    }
  }, [root]);

  // Browser-only fallback when Tauri runtime recovery does not run.
  useEffect(() => {
    if (isTauri) return;
    void useAppStore.getState().loadSettings();
  }, [isTauri]);

  // Keep client plugin runtime and workspace metadata aligned with the active workspace.
  const hostConnected = wsSnap?.hostConnected === true;
  useEffect(() => {
    ensureClientPluginRuntime().setWorkspace(effectiveWorkspace || undefined);
    if (!isTauri || effectiveWorkspace === "") return;
    void root.workspaceService?.refreshTrust(effectiveWorkspace).catch(() => undefined);
    if (connection !== "running") {
      void root.workspaceService?.refreshGit(effectiveWorkspace).catch(() => undefined);
    }
  }, [connection, effectiveWorkspace, hostConnected, isTauri, root]);

  useEffect(() => {
    if (!isTauri || !runtimeRecoveryDone) return;
    void root.workspaceService?.refreshProjects().catch(() => undefined);
  }, [isTauri, root, runtimeRecoveryDone]);

  // Bind shell navigation, workbench notifications, legacy keybindings, rewind bridges, and Intelligent UI dispatcher.
  useEffect(() => {
    const offShellNav = bindShellNavigation({
      openSettings: (page) => {
        root.navigationService?.openSettings(page);
      },
      openHubPage: (id) => {
        root.navigationService?.openPluginPage(id);
      },
    });
    const offWorkbenchNotif = bindWorkbenchNotifications(() => ({ cwd: activeWorkspaceRef.current }));
    const offLegacyKeys = installPluginKeybindings({
      getKeybindings: () => clientContributions.getSnapshot().keybindings,
      getContext: () => ({ cwd: activeWorkspaceRef.current, sessionFile: useAppStore.getState().sessionFile }),
    });
    const offTextBridge = rewindController.bindTextBridge({
      getText: () => root.composerService?.getDraft(activeComposerKey()) ?? "",
      setText: (text, focus) => {
        const key = activeComposerKey();
        root.composerService?.setDraft(text, key);
        if (focus === true && typeof document !== "undefined") {
          const input = document.querySelector<HTMLTextAreaElement>(".composer-input");
          input?.focus();
        }
      },
    });
    const offAttachBridge = rewindController.bindAttachmentBridge({
      getAttachments: () => [...(root.composerService?.getSnapshot(activeComposerKey()).attachments ?? [])],
      setAttachments: (next) => {
        const key = activeComposerKey();
        root.composerService?.clearAttachments(key);
        if (next.length > 0) {
          root.composerService?.addAttachments(next, key);
        }
      },
    });
    useIntelligentUiStore.getState().setPromptDispatcher(async (prompt) => {
      const current = useAppStore.getState();
      const targetCwd = current.cwd || activeWorkspaceRef.current;
      if (current.connection !== "running" && targetCwd !== "") {
        root.navigationService?.setDraftMode(false);
        await current.connect(targetCwd);
      }
      root.navigationService?.setDraftMode(false);
      return useAppStore.getState().sendMessage(prompt, undefined, "followUp");
    });

    return () => {
      useIntelligentUiStore.getState().setPromptDispatcher(null);
      offAttachBridge();
      offTextBridge();
      offLegacyKeys();
      offWorkbenchNotif();
      offShellNav();
    };
  }, [root]);

  // Tauri streaming quit guard & scheduled task completion notifications.
  useEffect(() => {
    if (!isTauri) return;
    void invoke("set_streaming_guard", { active: anyTaskStreaming }).catch(() => undefined);
  }, [anyTaskStreaming, isTauri]);

  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void scheduleClient
      .onRunUpdated((run) => {
        if (run.status === "running") return;
        void useAppStore.getState().refreshSessions();
        useAppStore.getState().showToast(
          run.status === "success"
            ? `计划任务“${run.taskName}”已完成`
            : `计划任务“${run.taskName}”${run.status === "interrupted" ? "已中断" : "失败"}`,
          run.status === "success" ? "info" : "error",
        );
        useAppStore.getState().addNotification({
          id: `scheduled:${run.id}:${run.status}`,
          kind: "completion",
          title: run.status === "success" ? "计划任务已完成" : "计划任务未完成",
          body: run.taskName,
          cwd: run.cwd,
          sessionFile: run.sessionFile ?? null,
        });
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isTauri]);

  // Mark viewed session for unread notification clearing.
  useEffect(() => {
    const viewed = !draftMode && hubView === null && !settingsOpen ? sessionFile : null;
    setViewedSession(viewed);
    const markViewed = () => setViewedSession(viewed);
    window.addEventListener("focus", markViewed);
    return () => {
      window.removeEventListener("focus", markViewed);
      setViewedSession(null);
    };
  }, [draftMode, hubView, sessionFile, setViewedSession, settingsOpen]);

  // Host file opener context shared by Markdown, ToolCall, and Workbench file viewers.
  const [workspaceEditors, setWorkspaceEditors] = useState<WorkspaceEditorInfo[]>([]);
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    void agent
      .listWorkspaceEditors()
      .then((list) => {
        if (!cancelled) setWorkspaceEditors(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isTauri]);

  const preferredEditor = useMemo(
    () => preferredEditorFor(effectiveWorkspace, workspaceEditors, settings?.defaultFileOpener),
    [effectiveWorkspace, settings?.defaultFileOpener, workspaceEditors],
  );

  const onOpenPreview = useCallback(
    (path: string, line?: number) => {
      root.navigationService?.setHubView(null);
      const workspace = activeWorkspaceRef.current;
      if (workspace === "") return;
      void useWorkbenchStore.getState().openFile(workspace, path, line !== undefined ? { line } : undefined);
    },
    [root],
  );

  const onAddToChat = useCallback(
    (path: string) => {
      const base = activeWorkspaceRef.current;
      if (base === "") return;
      const resolved = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path)
        ? path
        : `${base.replace(/[\\/]+$/, "")}\\${path.replace(/\//g, "\\")}`;
      void agent
        .readAttachment(resolved)
        .then((attachment) => {
          root.composerService?.addAttachments([attachment], activeComposerKey());
          useAppStore.getState().showToast(`${attachment.fileName} 已添加到聊天`, "info");
        })
        .catch((error) => {
          useAppStore.getState().showToast(describeError(error), "error");
        });
    },
    [root],
  );

  const onNotify = useCallback((message: string, tone: "info" | "error") => {
    useAppStore.getState().showToast(message, tone);
  }, []);

  const fileActions = useMemo<MicrokernelFileActionsConfig>(
    () => ({
      workspace: effectiveWorkspace,
      editors: workspaceEditors,
      preferredEditor,
      onOpenPreview,
      onAddToChat,
      onNotify,
    }),
    [effectiveWorkspace, onAddToChat, onNotify, onOpenPreview, preferredEditor, workspaceEditors],
  );

  return { root, safeMode, fileActions };
}
