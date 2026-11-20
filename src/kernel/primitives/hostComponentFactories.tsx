/**
 * Host-owned production UI factories registered into `@qianji/client-slots`'s
 * `SlotFactoryMap` (`src/kernel/primitives/hostComponentFactories.tsx`, ADR 0023).
 *
 * Bridges Qianji's full-featured production host views (Settings pages,
 * ModelPicker, ScheduledTasksPage, CodeWorkspacePane, SideChatTab,
 * IntelligentUiCard, IntelligentUiCanvasTab, and ProcessGroup) into built-in
 * core/feature plugins via `renderFactory(...)` with zero ESLint boundary
 * violations and full user-plugin override support.
 */
import { createElement, useCallback, useMemo, useState, type ReactElement, type ReactNode } from "react";
import type {
  ClientSlotsService,
  SlotComponentProps,
  SlotFactorySpec,
  SlotRegistry,
} from "@qianji/client-slots";
import { IntelligentUiCard } from "../../components/IntelligentUiCard";
import { IconChevronDown } from "../../components/DshIcons";
import { ProcessGroup, ReasoningRow } from "../../components/message/MessageProcessBlocks";
import { buildProcessSummary, summarizeProcessGroup } from "../../components/message/messageHelpers";
import { ModelPicker } from "../../components/ModelPicker";
import { ModelsPage } from "../../components/ModelsPage";
import { PluginsSettingsPanel } from "../../components/PluginsSettingsPanel";
import { ScheduledTasksPage } from "../../components/ScheduledTasksPage";
import { DEFAULTS } from "../../components/settings/settingsPrimitives";
import { AppearancePage } from "../../components/settings/AppearanceSettingsPage";
import { GeneralPage } from "../../components/settings/GeneralSettingsPage";
import { SideChatTab as HostSideChatTab } from "../../components/SideChatTab";
import { CodeWorkspacePane } from "../../components/workbench/CodeWorkspacePane";
import { IntelligentUiCanvasTab as HostIntelligentUiCanvasTab } from "../../components/workbench/IntelligentUiCanvasTab";
import { mergeAppearanceCatalog } from "../../lib/appearanceCatalog";
import { useClientContributions } from "../../lib/clientContributions";
import { describeError } from "../../lib/errors";
import { deriveSessionIntelligentUis, INTELLIGENT_UI_CANVAS_TAB_ID } from "../../lib/intelligentUi";
import { filterHiddenModels } from "../../lib/modelProviders";
import { groupTranscriptMessages } from "../../lib/transcriptTurns";
import { useAppStore } from "../../store";
import { useIntelligentUiStore } from "../../stores/intelligentUiStore";
import { useWorkbenchStore } from "../../stores/workbenchStore";
import type { AppSettings, ModelInfo, UiMessage, UiToolCall } from "../../types";
import { isWorkbenchPaneAvailable } from "../runtime/featureSlotQueries";
import type { SessionHandle } from "../services/sessionHandle";

export interface HostSettingsPageFactoryProps {
  readonly cwd?: string;
}

export interface HostComposerModelPickerFactoryProps {
  readonly handle?: SessionHandle | null;
  readonly sessionId?: string | null;
}

export interface HostScheduledHubFactoryProps {
  readonly cwd?: string;
  readonly workspaces?: readonly string[];
  readonly onOpenSession?: (workspace: string, file: string) => void;
  readonly onError?: (message: string) => void;
}

export interface HostCodeWorkspaceFactoryProps {
  readonly cwd: string;
}

export interface HostSideChatFactoryProps {
  readonly cwd: string;
  readonly sessionFile: string | null;
  readonly active: boolean;
}

export interface HostIntelligentUiInlineFactoryProps {
  readonly call: UiToolCall;
  readonly messageId?: string;
}

export interface HostProcessGroupFactoryProps {
  readonly message: UiMessage;
  readonly thinking: string;
  readonly working: boolean;
  readonly toolNodes?: ReactNode;
}

declare module "@qianji/client-slots" {
  interface SlotFactoryMap {
    "host.settings.general": SlotFactorySpec<HostSettingsPageFactoryProps, "root">;
    "host.settings.appearance": SlotFactorySpec<HostSettingsPageFactoryProps, "root">;
    "host.settings.providers": SlotFactorySpec<HostSettingsPageFactoryProps, "root">;
    "host.settings.plugins": SlotFactorySpec<HostSettingsPageFactoryProps, "root">;
    "host.composer.modelPicker": SlotFactorySpec<HostComposerModelPickerFactoryProps, "root">;
    "host.hub.scheduled": SlotFactorySpec<HostScheduledHubFactoryProps, "root">;
    "host.workbench.codeWorkspace": SlotFactorySpec<HostCodeWorkspaceFactoryProps, "root">;
    "host.workbench.sideChat": SlotFactorySpec<HostSideChatFactoryProps, "root">;
    "host.intelligentUi.inlineCard": SlotFactorySpec<HostIntelligentUiInlineFactoryProps, "root">;
    "host.intelligentUi.canvas": SlotFactorySpec<Record<string, never>, "root">;
    "host.conversation.processGroup": SlotFactorySpec<HostProcessGroupFactoryProps, "root">;
  }
}

const HOST_FACTORIES_PLUGIN_ID = "core-host-factories";

function useLiveAppSettingsForm(): {
  form: AppSettings;
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
} {
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const form = useMemo<AppSettings>(
    () => ({ ...DEFAULTS, ...settings, language: "zh-CN" }),
    [settings],
  );

  const update = useCallback(
    <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      const current = useAppStore.getState().settings;
      const next: AppSettings = { ...DEFAULTS, ...current, [key]: value, language: "zh-CN" };
      useAppStore.setState({ settings: next });
      void saveSettings(next).catch(() => undefined);
    },
    [saveSettings],
  );

  return { form, update };
}

function HostGeneralSettingsFactory(): ReactElement {
  const { form, update } = useLiveAppSettingsForm();
  return createElement(GeneralPage, { form, update });
}

function HostAppearanceSettingsFactory(): ReactElement {
  const { form, update } = useLiveAppSettingsForm();
  const contributions = useClientContributions();
  const catalog = useMemo(() => mergeAppearanceCatalog(contributions.themes), [contributions.themes]);
  return createElement(AppearancePage, { form, update, catalog });
}

function HostProvidersSettingsFactory(): ReactElement {
  const { form, update } = useLiveAppSettingsForm();
  return createElement(ModelsPage, { form, update });
}

function HostPluginsSettingsFactory(
  props: SlotComponentProps<HostSettingsPageFactoryProps, "root">,
): ReactElement {
  const { form, update } = useLiveAppSettingsForm();
  const storeCwd = useAppStore((s) => s.cwd);
  return createElement(PluginsSettingsPanel, {
    cwd: props.cwd ?? storeCwd,
    form,
    onSyncAppSetting: update,
  });
}

function HostComposerModelPickerFactory(
  props: SlotComponentProps<HostComposerModelPickerFactoryProps, "root">,
): ReactElement {
  const [open, setOpen] = useState(false);
  const settings = useAppStore((s) => s.settings);
  const storeModel = useAppStore((s) => s.model);
  const storeModels = useAppStore((s) => s.availableModels);
  const storeThinking = useAppStore((s) => s.thinkingLevel);
  const storeThinkingLevels = useAppStore((s) => s.availableThinkingLevels);
  const isSwitchingModel = useAppStore((s) => s.isSwitchingModel);

  const handle = props.handle ?? null;
  const handleSnap = handle?.getSnapshot() ?? null;
  const model = handleSnap?.model ?? storeModel;
  const rawModels = handleSnap?.availableModels ?? storeModels;
  const models = useMemo(
    () => filterHiddenModels([...rawModels], settings?.hiddenModels, model),
    [model, rawModels, settings?.hiddenModels],
  );
  const thinkingLevel = handleSnap?.thinkingLevel ?? storeThinking;
  const thinkingLevels = useMemo(
    () => [...(handleSnap?.availableThinkingLevels ?? storeThinkingLevels)],
    [handleSnap?.availableThinkingLevels, storeThinkingLevels],
  );

  const handleModelChange = useCallback(
    (next: ModelInfo) => {
      if (handle !== null) {
        void handle.setModel(next);
        return;
      }
      void useAppStore.getState().setModel(next).catch((error) => {
        useAppStore.getState().appendLog(`切换模型失败：${describeError(error)}`);
      });
    },
    [handle],
  );

  const handleThinkingChange = useCallback(
    (level: string) => {
      if (handle !== null) {
        void handle.setThinkingLevel(level);
        return;
      }
      void useAppStore.getState().setThinkingLevel(level).catch((error) => {
        useAppStore.getState().showToast(`设置推理等级失败：${describeError(error)}`, "error");
      });
    },
    [handle],
  );

  return createElement(ModelPicker, {
    model,
    models,
    thinkingLevel,
    thinkingLevels,
    isSwitchingModel,
    open,
    onToggle: () => setOpen((v) => !v),
    onClose: () => setOpen(false),
    onModelChange: handleModelChange,
    onThinkingChange: handleThinkingChange,
  });
}

function HostScheduledHubFactory(
  props: SlotComponentProps<HostScheduledHubFactoryProps, "root">,
): ReactElement {
  const cwd = useAppStore((s) => s.cwd);
  const sessions = useAppStore((s) => s.sessions);
  const workspaces = useMemo(() => {
    const provided = props.workspaces ?? [];
    const merged = [...provided, props.cwd ?? "", cwd, ...sessions.map((s) => s.cwd)].filter(Boolean);
    return [...new Set(merged)];
  }, [cwd, props.cwd, props.workspaces, sessions]);

  return createElement(ScheduledTasksPage, {
    workspaces,
    defaultWorkspace: props.cwd || cwd,
    onTasksChanged: () => {
      void useAppStore.getState().refreshSessions();
    },
    onOpenSession: (workspace: string, file: string) => {
      if (props.onOpenSession !== undefined) {
        props.onOpenSession(workspace, file);
      } else {
        void useAppStore.getState().switchSession(workspace, file);
      }
    },
    onError: (msg: string) => {
      if (props.onError !== undefined) {
        props.onError(msg);
      } else {
        useAppStore.getState().showToast(msg, "error");
      }
    },
  });
}

function HostCodeWorkspaceFactory(
  props: SlotComponentProps<HostCodeWorkspaceFactoryProps, "root">,
): ReactElement {
  return createElement(CodeWorkspacePane, { cwd: props.cwd });
}

function HostSideChatFactory(
  props: SlotComponentProps<HostSideChatFactoryProps, "root">,
): ReactElement {
  const sessionFile = props.sessionFile ?? "";
  return createElement(HostSideChatTab, {
    sessionFile,
    fallbackCwd: props.cwd,
    tabId: `side:${sessionFile || props.cwd || "active"}`,
    visible: props.active,
  });
}

function HostIntelligentUiInlineFactory(
  props: SlotComponentProps<HostIntelligentUiInlineFactoryProps, "root">,
): ReactElement | null {
  const messages = useAppStore((s) => s.messages);
  const summary = useMemo(
    () => deriveSessionIntelligentUis(groupTranscriptMessages([...messages])),
    [messages],
  );
  const widgetId = typeof props.call.args?.id === "string" ? props.call.args.id.trim() : "";
  const group = widgetId !== "" ? summary.groupsById.get(widgetId) : undefined;
  if (group === undefined) return null;
  const turnRefs = props.messageId !== undefined ? summary.turnWidgetsByMessageId.get(props.messageId) : undefined;
  const matchedVersion = turnRefs?.find((ref) => ref.id === widgetId)?.version ?? group.latest.version;
  return createElement(IntelligentUiCard, {
    group,
    defaultVersion: matchedVersion,
    mode: "inline",
  });
}

function HostIntelligentUiCanvasFactory(): ReactElement {
  return createElement(HostIntelligentUiCanvasTab);
}

function HostProcessGroupFactory(
  props: SlotComponentProps<HostProcessGroupFactoryProps, "root">,
): ReactElement | null {
  const { message, thinking, working, toolNodes } = props;
  const [processOpen, setProcessOpen] = useState<boolean | null>(null);
  const hasThinking = thinking.trim() !== "";
  const toolCalls = (message.toolCalls ?? []).filter(
    (call) => call.name !== "render_ui" && call.name !== "update_ui",
  );
  if (!hasThinking && toolCalls.length === 0) return null;

  const isExpanded = processOpen ?? working;
  const summary = buildProcessSummary(hasThinking ? 1 : 0, 0, toolCalls.length);
  const groupTitle = summarizeProcessGroup(hasThinking ? 1 : 0, toolCalls);

  return (
    <div className="dshc-process-wrap">
      {!working && (
        <button
          type="button"
          className="dshc-turn-process"
          data-open={isExpanded || undefined}
          aria-expanded={isExpanded}
          onClick={() => setProcessOpen(!isExpanded)}
        >
          <span className="dshc-turn-process-label">{summary || "查看处理过程"}</span>
          <IconChevronDown />
        </button>
      )}
      {isExpanded && (
        <ProcessGroup
          grouped
          live={working}
          autoOpen={working}
          summary={groupTitle}
          activity={hasThinking ? "thinking" : "shell"}
        >
          {hasThinking && (
            <ReasoningRow text={thinking} running={working && toolCalls.length === 0} settledPreview={!working} />
          )}
          {toolNodes}
        </ProcessGroup>
      )}
    </div>
  );
}

/**
 * Subscribe synchronously to `useAppStore` so live streaming HTML `render_ui`
 * widgets auto-open Right Workbench Canvas (`intelligent-ui-canvas`) while
 * historical artifacts loaded during idle session switches stay quiet.
 * Strictly gated by live `SlotRegistry` availability of `"intelligent-ui-canvas"`.
 */
export function installIntelligentUiAutoOpenSync(): () => void {
  let trackedSessionFile: string | null = useAppStore.getState().sessionFile;
  let seenHtmlKeys = new Set<string>();
  let lastMessagesRef = useAppStore.getState().messages;

  const collectHtmlKeys = (messages: readonly UiMessage[]) => {
    const summary = deriveSessionIntelligentUis(groupTranscriptMessages([...messages]));
    const entries: Array<{ key: string; widgetId: string }> = [];
    for (const grp of summary.orderedGroups) {
      for (const ver of grp.versions) {
        if (ver.engine === "html") {
          entries.push({ key: `${grp.id}:v${ver.version}`, widgetId: grp.id });
        }
      }
    }
    return entries;
  };

  for (const item of collectHtmlKeys(lastMessagesRef)) {
    seenHtmlKeys.add(item.key);
  }

  return useAppStore.subscribe((state) => {
    if (state.sessionFile !== trackedSessionFile) {
      trackedSessionFile = state.sessionFile;
      seenHtmlKeys = new Set(collectHtmlKeys(state.messages).map((item) => item.key));
      lastMessagesRef = state.messages;
      return;
    }
    if (state.messages === lastMessagesRef) return;
    lastMessagesRef = state.messages;

    const currentItems = collectHtmlKeys(state.messages);
    const newlyArrived = currentItems.filter((item) => !seenHtmlKeys.has(item.key));
    for (const item of newlyArrived) {
      seenHtmlKeys.add(item.key);
    }

    if (newlyArrived.length === 0 || !state.isStreaming) return;
    if (!useIntelligentUiStore.getState().pluginEnabled) return;
    if (!isWorkbenchPaneAvailable(INTELLIGENT_UI_CANVAS_TAB_ID)) return;

    const latest = newlyArrived[newlyArrived.length - 1];
    if (latest !== undefined) {
      useIntelligentUiStore.getState().setSelectedWidgetId(latest.widgetId);
      useWorkbenchStore.getState().openTab(INTELLIGENT_UI_CANVAS_TAB_ID);
    }
  });
}

/** Register Qianji's production host component factories (`tier: "builtin", priority: 0`). */
export function registerHostComponentFactories(
  target: Pick<SlotRegistry, "registerFactory"> | Pick<ClientSlotsService, "registerFactory">,
): () => void {
  const disposers = [
    target.registerFactory("host.settings.general", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:settings-general`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostGeneralSettingsFactory,
    }),
    target.registerFactory("host.settings.appearance", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:settings-appearance`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostAppearanceSettingsFactory,
    }),
    target.registerFactory("host.settings.providers", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:settings-providers`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostProvidersSettingsFactory,
    }),
    target.registerFactory("host.settings.plugins", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:settings-plugins`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostPluginsSettingsFactory,
    }),
    target.registerFactory("host.composer.modelPicker", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:composer-model-picker`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostComposerModelPickerFactory,
    }),
    target.registerFactory("host.hub.scheduled", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:hub-scheduled`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostScheduledHubFactory,
    }),
    target.registerFactory("host.workbench.codeWorkspace", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:workbench-code-workspace`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostCodeWorkspaceFactory,
    }),
    target.registerFactory("host.workbench.sideChat", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:workbench-side-chat`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostSideChatFactory,
    }),
    target.registerFactory("host.intelligentUi.inlineCard", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:intelligent-ui-inline`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostIntelligentUiInlineFactory,
    }),
    target.registerFactory("host.intelligentUi.canvas", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:intelligent-ui-canvas`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostIntelligentUiCanvasFactory,
    }),
    target.registerFactory("host.conversation.processGroup", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:conversation-process-group`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostProcessGroupFactory,
    }),
  ];

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of disposers) dispose();
  };
}
