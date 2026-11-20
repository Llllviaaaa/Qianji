/**
 * Built-in default child slot components for `composer.banners`,
 * `composer.attachments`, `composer.toolbar`, and `composer.status`
 * (ADR 0023 `core-composer`).
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  CircleCheck,
  File,
  Image as ImageIcon,
  ListChecks,
  MessageCircleQuestion,
  Plus,
  X,
} from "lucide-react";
import {
  useClientContributions,
  useFrontendService,
  useSessionHandle,
  useSessionState,
  type WorkbenchSlotContext,
} from "@qianji/client";
import {
  SlotKernelErrorBoundary,
  type ComposerAttachmentsSlotProps,
  type ComposerSlotBaseProps,
  type ComposerStatusSlotProps,
  type SlotComponentProps,
} from "@qianji/client-slots";
import {
  AGENT_MODE_OPTIONS,
  computeContextUsageMetrics,
  PERMISSION_OPTIONS,
  resolveComposerSessionKey,
} from "./composerHelpers";

/* ── Fault-isolated bridge helper for legacy ctx.contributions composer slots ── */

function LegacyComposerContribRunner({
  renderFn,
  context,
}: {
  readonly renderFn: (ctx: WorkbenchSlotContext) => ReactNode;
  readonly context: WorkbenchSlotContext;
}): ReactNode {
  return renderFn(context);
}

function LegacyComposerContribBox({
  id,
  pluginId,
  slotKey,
  renderFn,
  context,
  className,
  compact = false,
}: {
  readonly id: string;
  readonly pluginId?: string;
  readonly slotKey: string;
  readonly renderFn: (ctx: WorkbenchSlotContext) => ReactNode;
  readonly context: WorkbenchSlotContext;
  readonly className?: string;
  readonly compact?: boolean;
}): ReactNode {
  const ownerPlugin = pluginId ?? "legacy-plugin";
  return (
    <span className={className} data-qj-plugin={ownerPlugin}>
      <SlotKernelErrorBoundary pluginId={ownerPlugin} entryId={id} slotKey={slotKey} compact={compact}>
        <LegacyComposerContribRunner renderFn={renderFn} context={context} />
      </SlotKernelErrorBoundary>
    </span>
  );
}

/* ── composer.banners (legacy ctx.contributions.composerBanners bridge) ── */

export function CoreComposerBanners({
  cwd = "",
  sessionFile = null,
  variant = "follow-up",
}: SlotComponentProps<ComposerSlotBaseProps, "session-maybe">): ReactNode {
  const contributions = useClientContributions();
  if (contributions.composerBanners.length === 0) return null;

  const ctx: WorkbenchSlotContext = { cwd, sessionFile, variant };
  return (
    <>
      {contributions.composerBanners.map((banner) => (
        <div key={banner.id} className="composer-plugin-banner">
          <LegacyComposerContribBox
            id={banner.id}
            pluginId={banner.pluginId}
            slotKey="composer.banners"
            renderFn={banner.render}
            context={ctx}
          />
        </div>
      ))}
    </>
  );
}

/* ── composer.attachments ── */

export function CoreComposerAttachments({
  attachments,
  sessionKey,
  sessionFile,
  sessionId,
  onRemove,
}: SlotComponentProps<ComposerAttachmentsSlotProps, "session-maybe">): ReactNode {
  const composerService = useFrontendService("composerService");
  const resolvedKey = resolveComposerSessionKey(sessionKey, sessionId, sessionFile);

  if (attachments.length === 0) return null;

  return (
    <div className="attachment-strip" data-slot="composer.attachments">
      {attachments.map((attachment, index) => (
        <div className="attachment-chip" key={attachment.path}>
          {attachment.kind === "image" ? <ImageIcon size={14} /> : <File size={14} />}
          <span>{attachment.fileName}</span>
          <button
            type="button"
            title="移除附件"
            aria-label={`移除附件 ${attachment.fileName}`}
            onClick={() => {
              if (onRemove !== undefined) {
                onRemove(index);
              } else {
                composerService?.removeAttachment(attachment.path, resolvedKey);
              }
            }}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

/* ── composer.toolbar ── */

export function CoreComposerToolbar({
  cwd = "",
  sessionFile = null,
  variant = "follow-up",
  sessionId,
}: SlotComponentProps<ComposerSlotBaseProps, "session-maybe">): ReactNode {
  const sessionService = useFrontendService("sessionService");
  const sessionState = useSessionState();
  const { handle, snapshot: handleSnap } = useSessionHandle(sessionId);
  const contributions = useClientContributions();
  const [actionsOpen, setActionsOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);

  const permissionMode = handleSnap?.permissionMode ?? sessionState?.permissionMode ?? "ask";
  const agentMode = handleSnap?.agentMode ?? sessionState?.agentMode ?? "agent";
  const activePermission = PERMISSION_OPTIONS.find((opt) => opt.value === permissionMode) ?? PERMISSION_OPTIONS[1];
  const contribCtx: WorkbenchSlotContext = { cwd, sessionFile, variant };

  const setPermission = (mode: (typeof PERMISSION_OPTIONS)[number]["value"]) => {
    setPermissionOpen(false);
    if (handle !== null) {
      void handle.setPermissionMode(mode);
    } else {
      void sessionService?.setPermissionMode(mode);
    }
  };

  const setAgentMode = (mode: (typeof AGENT_MODE_OPTIONS)[number]["value"]) => {
    setActionsOpen(false);
    if (handle !== null) {
      void handle.setAgentMode(mode);
    } else {
      void sessionService?.setAgentMode(mode);
    }
  };

  return (
    <>
      <button
        type="button"
        className="composer-icon-button composer-add-trigger dsh-input-add-btn"
        data-dsh-claude-control="commands"
        title="添加附件与切换模式"
        aria-label="添加附件与切换模式"
        aria-expanded={actionsOpen}
        onClick={() => {
          setPermissionOpen(false);
          setActionsOpen((value) => !value);
        }}
      >
        <Plus size={16} strokeWidth={1.9} />
      </button>

      {agentMode !== "agent" && (
        <button
          type="button"
          className="chip chip-agent-mode"
          onClick={() => {
            setPermissionOpen(false);
            setActionsOpen((value) => !value);
          }}
        >
          {agentMode === "plan" ? <ListChecks size={13} strokeWidth={1.8} /> : <MessageCircleQuestion size={13} strokeWidth={1.8} />}
          <span>{agentMode === "plan" ? "计划模式" : "问答模式"}</span>
        </button>
      )}

      <div className="permission-context-wrap">
        <button
          type="button"
          className={`chip chip-permission ${permissionOpen ? "active" : ""}`}
          title={`权限模式：${activePermission?.label ?? ""} · ${activePermission?.description ?? ""}`}
          aria-label={`权限模式：${activePermission?.label ?? ""}`}
          aria-haspopup="menu"
          aria-expanded={permissionOpen}
          onClick={() => {
            setActionsOpen(false);
            setPermissionOpen((value) => !value);
          }}
        >
          <CircleCheck size={13} strokeWidth={1.75} />
          <span>{activePermission?.label}</span>
          <ChevronDown size={11} strokeWidth={1.75} />
        </button>
        {permissionOpen && (
          <div className="permission-menu" role="menu" aria-label="权限模式">
            <div className="permission-menu-heading">执行权限</div>
            {PERMISSION_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={permissionMode === option.value}
                className={permissionMode === option.value ? "active" : ""}
                onClick={() => setPermission(option.value)}
              >
                <div className="permission-menu-copy">
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </div>
                {permissionMode === option.value && <Check size={14} />}
              </button>
            ))}
          </div>
        )}
      </div>

      {actionsOpen && (
        <div className="composer-actions-menu" role="menu" aria-label="工作模式">
          <div className="composer-actions-heading">工作模式</div>
          {AGENT_MODE_OPTIONS.map((option) => {
            const Icon = option.value === "plan" ? ListChecks : option.value === "ask" ? MessageCircleQuestion : Bot;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={agentMode === option.value}
                className={agentMode === option.value ? "active" : ""}
                onClick={() => setAgentMode(option.value)}
              >
                <Icon size={14} />
                <span>{option.label}</span>
                <small className="composer-actions-hint">{option.description}</small>
                {agentMode === option.value && <Check className="composer-actions-check" size={14} />}
              </button>
            );
          })}
        </div>
      )}

      {contributions.composerToolbar.map((action) => (
        <LegacyComposerContribBox
          key={action.id}
          id={action.id}
          pluginId={action.pluginId}
          slotKey="composer.toolbar"
          renderFn={action.render}
          context={contribCtx}
          className="composer-plugin-action"
          compact
        />
      ))}
    </>
  );
}

/* ── composer.status ── */

export function CoreComposerStatus({
  cwd = "",
  sessionFile = null,
  variant = "follow-up",
  position = "after-model",
  sessionId,
}: SlotComponentProps<ComposerStatusSlotProps, "session-maybe">): ReactNode {
  const sessionState = useSessionState();
  const { snapshot: handleSnap } = useSessionHandle(sessionId);
  const contributions = useClientContributions();
  const contribCtx: WorkbenchSlotContext = { cwd, sessionFile, variant };

  const matchedContribs = contributions.composerStatus.filter((item) =>
    position === "before-model" ? item.position === "before-model" : item.position !== "before-model",
  );

  const stats = variant === "follow-up" ? (handleSnap?.stats ?? sessionState?.stats ?? null) : null;
  const metrics = computeContextUsageMetrics(stats?.contextUsage);
  const showBuiltInTelemetry = position === "before-model" && matchedContribs.length === 0;

  return (
    <>
      {matchedContribs.map((item) => (
        <LegacyComposerContribBox
          key={item.id}
          id={item.id}
          pluginId={item.pluginId}
          slotKey="composer.status"
          renderFn={item.render}
          context={contribCtx}
          className="composer-plugin-status"
          compact
        />
      ))}

      {showBuiltInTelemetry && stats !== null && stats.cost > 0 && (
        <span className="composer-session-cost" title="会话预估成本">
          {stats.cost < 0.01 ? `$${stats.cost.toFixed(4)}` : `$${stats.cost.toFixed(2)}`}
        </span>
      )}

      {showBuiltInTelemetry && metrics.normalizedContextPercent !== null && (
        <span className="composer-context-usage">
          <span
            className="composer-context-indicator"
            role="img"
            tabIndex={0}
            aria-label={`上下文用量：${metrics.normalizedContextPercent}%`}
            style={{ "--context-percent": `${metrics.normalizedContextPercent}%` } as CSSProperties}
          />
        </span>
      )}
    </>
  );
}
