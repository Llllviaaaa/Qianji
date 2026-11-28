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
import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type {
  ClientSlotsService,
  SlotComponentProps,
  SlotFactorySpec,
  SlotRegistry,
} from "@qianji/client-slots";
import { IntelligentUiCard } from "../../components/IntelligentUiCard";
import { ModelPicker } from "../../components/ModelPicker";
import { ModelsPage } from "../../components/ModelsPage";
import { PluginsHubPage } from "../../components/PluginsHubPage";
import { PluginsSettingsPanel } from "../../components/PluginsSettingsPanel";
import { ScheduledTasksPage } from "../../components/ScheduledTasksPage";
import { AppearancePage } from "../../components/settings/AppearanceSettingsPage";
import { GeneralPage } from "../../components/settings/GeneralSettingsPage";
import { SideChatTab as HostSideChatTab } from "../../components/SideChatTab";
import { CodeWorkspacePane } from "../../components/workbench/CodeWorkspacePane";
import { IntelligentUiCanvasTab as HostIntelligentUiCanvasTab } from "../../components/workbench/IntelligentUiCanvasTab";
import { useSyncOnChange } from "../../hooks/useSyncOnChange";
import { agent } from "../../lib/agent";
import { mergeAppearanceCatalog } from "../../lib/appearanceCatalog";
import { useClientContributions } from "../../lib/clientContributions";
import { describeError } from "../../lib/errors";
import {
  deriveSessionIntelligentUis,
  normalizeWidgetId,
} from "../../lib/intelligentUi";
import { filterHiddenModels } from "../../lib/modelProviders";
import { groupTranscriptMessages } from "../../lib/transcriptTurns";
import { useAppStore } from "../../store";
import type { ModelInfo, UiToolCall } from "../../types";
import type { SessionHandle } from "../services/sessionHandle";
import { installIntelligentUiAutoOpenSync } from "./hostIntelligentUiSync";

export { installIntelligentUiAutoOpenSync };
import {
  registerHostConversationFactories,
  type HostAssistantMessageFactoryProps,
  type HostProcessGroupFactoryProps,
  type HostToolCallFactoryProps,
  type HostUserMessageFactoryProps,
} from "./hostConversationFactories";
import { useLiveAppSettingsForm } from "./hostSettingsForm";
import { registerHostComposerFactories } from "./hostComposerFactories";
import { registerHostShellFactories } from "./hostShellFactories";
import { registerHostWorkbenchFactories } from "./hostWorkbenchFactories";

export type {
  HostAssistantMessageFactoryProps,
  HostProcessGroupFactoryProps,
  HostToolCallFactoryProps,
  HostUserMessageFactoryProps,
};

export interface HostSettingsPageFactoryProps {
  readonly cwd?: string;
  readonly onClose?: () => void;
  readonly initialExpandPluginId?: string;
  readonly hideDefaultPreferences?: boolean;
}

export interface HostHubPluginsFactoryProps {
  readonly cwd?: string;
  readonly onReturnToChat?: () => void;
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

declare module "@qianji/client-slots" {
  interface SlotFactoryMap {
    "host.settings.general": SlotFactorySpec<HostSettingsPageFactoryProps, "root">;
    "host.settings.appearance": SlotFactorySpec<HostSettingsPageFactoryProps, "root">;
    "host.settings.providers": SlotFactorySpec<HostSettingsPageFactoryProps, "root">;
    "host.settings.plugins": SlotFactorySpec<HostSettingsPageFactoryProps, "root">;
    "host.composer.modelPicker": SlotFactorySpec<HostComposerModelPickerFactoryProps, "root">;
    "host.hub.scheduled": SlotFactorySpec<HostScheduledHubFactoryProps, "root">;
    "host.hub.plugins": SlotFactorySpec<HostHubPluginsFactoryProps, "root">;
    "host.workbench.codeWorkspace": SlotFactorySpec<HostCodeWorkspaceFactoryProps, "root">;
    "host.workbench.sideChat": SlotFactorySpec<HostSideChatFactoryProps, "root">;
    "host.intelligentUi.inlineCard": SlotFactorySpec<HostIntelligentUiInlineFactoryProps, "root">;
    "host.intelligentUi.canvas": SlotFactorySpec<Record<string, never>, "root">;
  }
}

const HOST_FACTORIES_PLUGIN_ID = "core-host-factories";

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

function HostProvidersSettingsFactory(
  props: SlotComponentProps<HostSettingsPageFactoryProps, "root">,
): ReactElement {
  const { form, update } = useLiveAppSettingsForm();
  return createElement(ModelsPage, {
    form,
    update,
    ...(props.hideDefaultPreferences === true ? { hideDefaultPreferences: true } : {}),
  });
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
    ...(props.onClose === undefined ? {} : { onDismissHub: props.onClose }),
    ...(props.initialExpandPluginId === undefined
      ? {}
      : { initialExpandPluginId: props.initialExpandPluginId }),
  });
}

function HostHubPluginsFactory(
  props: SlotComponentProps<HostHubPluginsFactoryProps, "root">,
): ReactElement {
  const storeCwd = useAppStore((s) => s.cwd);
  return createElement(PluginsHubPage, {
    cwd: props.cwd ?? storeCwd,
    ...(props.onReturnToChat === undefined ? {} : { onReturnToChat: props.onReturnToChat }),
  });
}

function HostComposerModelPickerFactory(
  props: SlotComponentProps<HostComposerModelPickerFactoryProps, "root">,
): ReactElement {
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const settings = useAppStore((s) => s.settings);
  const storeModel = useAppStore((s) => s.model);
  const storeModels = useAppStore((s) => s.availableModels);
  const storeThinking = useAppStore((s) => s.thinkingLevel);
  const storeThinkingLevels = useAppStore((s) => s.availableThinkingLevels);
  const isSwitchingModel = useAppStore((s) => s.isSwitchingModel);

  useSyncOnChange([isSwitchingModel], () => {
    if (isSwitchingModel) setOpen(false);
  });

  useEffect(() => {
    if (!open || typeof document === "undefined") return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target !== null && hostRef.current !== null && hostRef.current.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

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

  return (
    <div ref={hostRef} style={{ display: "inline-flex", alignItems: "center" }}>
      <ModelPicker
        model={model}
        models={models}
        thinkingLevel={thinkingLevel}
        thinkingLevels={thinkingLevels}
        isSwitchingModel={isSwitchingModel}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        onClose={() => setOpen(false)}
        onModelChange={handleModelChange}
        onThinkingChange={handleThinkingChange}
      />
    </div>
  );
}

function HostScheduledHubFactory(
  props: SlotComponentProps<HostScheduledHubFactoryProps, "root">,
): ReactElement {
  const cwd = useAppStore((s) => s.cwd);
  const defaultWorkspace = useAppStore((s) => s.settings?.defaultWorkspace?.trim() ?? "");
  const sessions = useAppStore((s) => s.sessions);
  const workspaces = useMemo(() => {
    const provided = props.workspaces ?? [];
    const merged = [...provided, props.cwd ?? "", cwd, ...sessions.map((s) => s.cwd)].filter(Boolean);
    return [...new Set(merged)];
  }, [cwd, props.cwd, props.workspaces, sessions]);

  return createElement(ScheduledTasksPage, {
    workspaces,
    defaultWorkspace,
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
  const onAddToChat = useCallback(
    (path: string) => {
      const base = props.cwd || useAppStore.getState().cwd;
      if (base === "") return;
      const resolved = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path)
        ? path
        : `${base.replace(/[\\/]+$/, "")}\\${path.replace(/\//g, "\\")}`;
      void agent
        .readAttachment(resolved)
        .then((attachment) => {
          props.ctx?.get("composerService")?.addAttachments([attachment]);
          useAppStore.getState().showToast(`${attachment.fileName} 已添加到聊天`, "info");
        })
        .catch((error) => {
          useAppStore.getState().showToast(describeError(error), "error");
        });
    },
    [props.ctx, props.cwd],
  );
  return createElement(CodeWorkspacePane, { cwd: props.cwd, onAddToChat });
}

function HostSideChatFactory(
  props: SlotComponentProps<HostSideChatFactoryProps, "root">,
): ReactElement {
  const sessionFile = props.sessionFile ?? "";
  return createElement(HostSideChatTab, {
    key: sessionFile || "draft",
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
  const rawId =
    (typeof props.call.details?.id === "string" && props.call.details.id.trim() !== ""
      ? props.call.details.id
      : typeof props.call.args?.id === "string"
        ? props.call.args.id
        : "");
  const widgetId = rawId.trim() !== "" ? normalizeWidgetId(rawId) : "";
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
    target.registerFactory("host.hub.plugins", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:hub-plugins`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostHubPluginsFactory,
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
    ...registerHostConversationFactories(target),
    ...registerHostComposerFactories(target),
    ...registerHostShellFactories(target),
    ...registerHostWorkbenchFactories(target),
  ];

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of disposers) dispose();
  };
}
