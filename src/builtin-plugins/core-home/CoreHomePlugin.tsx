import { useCallback, useState, useSyncExternalStore, type ReactNode } from "react";
import { ShieldAlert, ShieldCheck, Sparkles } from "lucide-react";
import {
  useClientContributions,
  useFrontendService,
  useNavigationState,
  useSessionState,
  useWorkspaceState,
  type AttachmentPayload,
  type HomeQuickActionSlotContext,
} from "@qianji/client";
import {
  SlotHost,
  SlotKernelErrorBoundary,
  type CoreShellStageProps,
  type HomeHeroSlotProps,
  type SlotComponentProps,
} from "@qianji/client-slots";

const NOOP_UNSUB = (): void => undefined;

function extractWorkspaceName(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  if (trimmed === "" || trimmed.toLowerCase().endsWith("quick-chat")) return "";
  return trimmed.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

function LegacyQuickActionBody({
  renderFn,
  context,
}: {
  readonly renderFn: (ctx: HomeQuickActionSlotContext) => ReactNode;
  readonly context: HomeQuickActionSlotContext;
}): ReactNode {
  return renderFn(context);
}

export function CoreHomeHero(props: SlotComponentProps<HomeHeroSlotProps, "root">) {
  const { ctx } = props;
  const sessionSnap = useSessionState(ctx);
  const workspaceSnap = useWorkspaceState(ctx);

  const cwd = props.cwd ?? workspaceSnap?.cwd ?? sessionSnap?.cwd ?? "";
  const workspaceName = extractWorkspaceName(cwd);
  const headline = workspaceName === "" ? "接下来聊些什么？" : `接下来在 ${workspaceName} 做什么？`;
  const lastError = sessionSnap?.lastError ?? null;

  return (
    <>
      <h1 className="new-task-heading">{headline}</h1>
      {lastError !== null && lastError !== "" && <p className="new-task-error">{lastError}</p>}
    </>
  );
}

function HomeWorkspaceTrustBanner({
  workspace,
  trusted,
  hasProjectPlugins,
  hasProjectConfig,
  pluginIds,
  onTrust,
  onOpenPlugins,
}: {
  readonly workspace: string;
  readonly trusted: boolean;
  readonly hasProjectPlugins: boolean;
  readonly hasProjectConfig: boolean;
  readonly pluginIds: readonly string[];
  readonly onTrust: () => Promise<void>;
  readonly onOpenPlugins: () => void;
}) {
  const [dismissedWorkspace, setDismissedWorkspace] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (
    workspace.trim() === "" ||
    dismissedWorkspace === workspace ||
    trusted ||
    (!hasProjectPlugins && !hasProjectConfig)
  ) {
    return null;
  }

  const summary =
    pluginIds.length > 0
      ? `检测到当前项目包含 ${pluginIds.length} 个项目级插件（${pluginIds.join("、")}），出于安全保护默认暂未运行。`
      : "检测到当前项目包含项目级插件配置（.qianji/harness.json），出于安全保护默认暂未生效。";

  return (
    <div className="workspace-trust-banner" role="region" aria-label="工作区插件信任提示">
      <div className="workspace-trust-copy">
        <ShieldAlert size={16} />
        <span>{summary}</span>
      </div>
      <div className="workspace-trust-actions">
        <button type="button" className="plugin-mini-button" onClick={onOpenPlugins}>
          查看详情
        </button>
        <button
          type="button"
          className="plugin-mini-button"
          onClick={() => setDismissedWorkspace(workspace)}
        >
          暂不信任
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={pending}
          onClick={() => {
            setPending(true);
            void onTrust().finally(() => setPending(false));
          }}
        >
          <ShieldCheck size={14} />
          <span>{pending ? "正在启用…" : "信任并启用项目插件"}</span>
        </button>
      </div>
    </div>
  );
}

function DefaultHomeComposerFallback({
  onSend,
}: {
  readonly onSend: (text: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  return (
    <form
      className="composer-fallback-form"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = draft.trim();
        if (trimmed === "") return;
        setDraft("");
        void onSend(trimmed);
      }}
    >
      <textarea
        className="composer-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="输入任务或问题开始对话…"
        aria-label="输入任务"
      />
    </form>
  );
}

export function CoreHomeStage(props: SlotComponentProps<CoreShellStageProps, "session-maybe">) {
  const { renderSlot, ctx } = props;
  const navigationService = useFrontendService("navigationService", ctx);
  const sessionService = useFrontendService("sessionService", ctx);
  const workspaceService = useFrontendService("workspaceService", ctx);
  const composerService = useFrontendService("composerService", ctx);

  useNavigationState(ctx);
  const sessionSnap = useSessionState(ctx);
  const workspaceSnap = useWorkspaceState(ctx);
  const contributions = useClientContributions();

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

  const effectiveCwd = props.cwd ?? workspaceSnap?.cwd ?? sessionSnap?.cwd ?? "";
  const sessionFile = props.sessionFile !== undefined ? props.sessionFile : (sessionSnap?.sessionFile ?? null);
  const workspaceOptions = workspaceSnap?.workspaceOptions ?? [];
  const trust = workspaceSnap?.trust;
  const hasQuickActionsSlot = (slotsRegistry?.getEntries("home.quickActions").length ?? 0) > 0;
  const showQuickActions = hasQuickActionsSlot || contributions.homeQuickActions.length > 0;

  const handleSendFromHome = useCallback(
    async (text: string, attachments?: AttachmentPayload[]): Promise<boolean> => {
      const trimmed = text.trim();
      if (trimmed === "" || sessionService === undefined) return false;
      navigationService?.setDraftMode(false);
      return sessionService.sendMessage(trimmed, attachments);
    },
    [navigationService, sessionService],
  );

  const quickCtx: HomeQuickActionSlotContext = {
    cwd: effectiveCwd,
    sessionFile,
    prefillComposer: (prompt: string) => {
      composerService?.prefill(prompt);
    },
    sendPrompt: (prompt: string) => {
      void handleSendFromHome(prompt);
    },
  };

  return (
    <>
      {trust !== undefined && (
        <HomeWorkspaceTrustBanner
          workspace={effectiveCwd}
          trusted={trust.trusted}
          hasProjectPlugins={trust.hasProjectPlugins}
          hasProjectConfig={trust.hasProjectConfig}
          pluginIds={trust.pluginIds}
          onOpenPlugins={() => navigationService?.navigate({ kind: "hub", view: "plugins" })}
          onTrust={async () => {
            if (workspaceService === undefined) return;
            try {
              await workspaceService.setWorkspaceTrust(effectiveCwd, true);
              navigationService?.showToast("已信任工作区并启用项目级插件", "info");
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              navigationService?.showToast(`信任工作区失败：${message}`, "error");
            }
          }}
        />
      )}

      <div className="conversation-scroll new-task-scroll" data-core-plugin="core-home">
        <div className="conversation new-task-conversation">
          <div className="new-task-screen codex-home vetta-home dsh-claude-home">
            <div className="minimal-home-core">
              {renderSlot("home.hero", {
                cwd: effectiveCwd,
                workspaceOptions,
              })}

              <div className="dsh-claude-home-composer-wrap">
                <SlotHost
                  slotKey="composer.main"
                  kind="chain"
                  scope="session-maybe"
                  props={{
                    cwd: effectiveCwd,
                    sessionFile,
                    variant: "task-start",
                    isStreaming: sessionSnap?.isStreaming ?? false,
                    onSend: handleSendFromHome,
                  }}
                  fallback={<DefaultHomeComposerFallback onSend={handleSendFromHome} />}
                />
              </div>

              {showQuickActions && (
                <div className="dsh-home-starters" aria-label="快捷指令建议">
                  {renderSlot("home.quickActions", quickCtx)}
                  {contributions.homeQuickActions.map((item) => {
                    if (typeof item.render === "function") {
                      const resolvedPluginId = item.pluginId ?? "builtin";
                      return (
                        <div
                          key={item.id}
                          data-qj-plugin={resolvedPluginId}
                          data-qj-legacy-slot="home.quickActions"
                          style={{ display: "contents" }}
                        >
                          <SlotKernelErrorBoundary
                            pluginId={resolvedPluginId}
                            entryId={`legacy:home.quickActions:${item.id}`}
                            slotKey="home.quickActions"
                            compact
                          >
                            <LegacyQuickActionBody renderFn={item.render} context={quickCtx} />
                          </SlotKernelErrorBoundary>
                        </div>
                      );
                    }
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className="dsh-home-starter-pill"
                        data-qj-plugin={item.pluginId ?? "builtin"}
                        onClick={() => {
                          try {
                            if (typeof item.onSelect === "function") {
                              item.onSelect(quickCtx);
                            } else if (typeof item.prompt === "string" && item.prompt.trim() !== "") {
                              quickCtx.prefillComposer(item.prompt);
                            }
                          } catch (error) {
                            console.error(`[core-home] homeQuickAction "${item.id}" failed:`, error);
                          }
                        }}
                      >
                        {item.icon ?? <Sparkles size={13} strokeWidth={1.8} />}
                        <span>{item.label ?? item.id}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              {renderSlot("home.sections", {
                cwd: effectiveCwd,
                sessionFile,
              })}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
