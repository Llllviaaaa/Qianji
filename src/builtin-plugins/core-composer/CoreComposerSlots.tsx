/**
 * Built-in default child slot components for `composer.banners`,
 * `composer.attachments`, `composer.toolbar`, and `composer.status`
 * (ADR 0023 `core-composer`).
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  CircleCheck,
  File,
  Image as ImageIcon,
  ListChecks,
  MessageCircleQuestion,
  Paperclip,
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
  legacySlotName,
  renderFn,
  context,
  className,
  compact = false,
}: {
  readonly id: string;
  readonly pluginId?: string;
  readonly slotKey: string;
  readonly legacySlotName?: string;
  readonly renderFn: (ctx: WorkbenchSlotContext) => ReactNode;
  readonly context: WorkbenchSlotContext;
  readonly className?: string;
  readonly compact?: boolean;
}): ReactNode {
  const ownerPlugin = pluginId ?? "builtin";
  const resolvedSlot = legacySlotName ?? slotKey;
  if (className === undefined) {
    return (
      <div
        data-qj-plugin={ownerPlugin}
        data-qj-slot={resolvedSlot}
        data-qj-entry={id}
        style={{ display: "contents" }}
      >
        <SlotKernelErrorBoundary pluginId={ownerPlugin} entryId={id} slotKey={slotKey} compact={compact}>
          <LegacyComposerContribRunner renderFn={renderFn} context={context} />
        </SlotKernelErrorBoundary>
      </div>
    );
  }
  return (
    <span className={className} data-qj-plugin={ownerPlugin} data-qj-slot={resolvedSlot} data-qj-entry={id}>
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
  isolated = false,
}: SlotComponentProps<ComposerSlotBaseProps, "session-maybe">): ReactNode {
  const contributions = useClientContributions();
  if (isolated || contributions.composerBanners.length === 0) return null;

  const ctx: WorkbenchSlotContext = { cwd, sessionFile, variant };
  return (
    <>
      {contributions.composerBanners.map((banner) => {
        const ownerPlugin = banner.pluginId ?? "builtin";
        return (
          <div
            key={banner.id}
            className="composer-plugin-banner"
            data-qj-plugin={ownerPlugin}
            data-qj-slot="composerBanners"
            data-qj-entry={banner.id}
          >
            <SlotKernelErrorBoundary
              pluginId={ownerPlugin}
              entryId={banner.id}
              slotKey="composer.banners"
            >
              <LegacyComposerContribRunner renderFn={banner.render} context={ctx} />
            </SlotKernelErrorBoundary>
          </div>
        );
      })}
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
  sessionKey,
  isolated = false,
  sessionId,
}: SlotComponentProps<ComposerSlotBaseProps, "session-maybe">): ReactNode {
  const composerService = useFrontendService("composerService");
  const sessionService = useFrontendService("sessionService");
  const sessionState = useSessionState();
  const { handle, snapshot: handleSnap } = useSessionHandle(sessionId);
  const contributions = useClientContributions();
  const [actionsOpen, setActionsOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const actionsWrapRef = useRef<HTMLDivElement>(null);
  const permissionWrapRef = useRef<HTMLDivElement>(null);
  const resolvedSessionKey = resolveComposerSessionKey(sessionKey, sessionId, sessionFile);

  useEffect(() => {
    if ((!actionsOpen && !permissionOpen) || typeof document === "undefined") return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target === null) return;
      if (
        actionsOpen &&
        !target.closest(".composer-actions-menu, .composer-add-trigger, .chip-agent-mode") &&
        (actionsWrapRef.current === null || !actionsWrapRef.current.contains(target))
      ) {
        setActionsOpen(false);
      }
      if (
        permissionOpen &&
        (permissionWrapRef.current === null || !permissionWrapRef.current.contains(target))
      ) {
        setPermissionOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (actionsOpen) {
        setActionsOpen(false);
        event.stopPropagation();
      } else if (permissionOpen) {
        setPermissionOpen(false);
        event.stopPropagation();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [actionsOpen, permissionOpen]);

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
          title={`当前工作模式：${agentMode === "plan" ? "计划（只读梳理方案）" : "问答（只读回答问题）"}`}
        >
          {agentMode === "plan" ? <ListChecks size={13} strokeWidth={1.8} /> : <MessageCircleQuestion size={13} strokeWidth={1.8} />}
          <span>{agentMode === "plan" ? "计划模式" : "问答模式"}</span>
        </button>
      )}

      <div className="permission-context-wrap" ref={permissionWrapRef}>
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
        <div className="composer-actions-menu" role="menu" aria-label="添加附件与工作模式" ref={actionsWrapRef}>
          <div className="composer-actions-heading">添加</div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setActionsOpen(false);
              void composerService?.pickAttachments(resolvedSessionKey);
            }}
          >
            <Paperclip size={14} />
            <span>文件或图片</span>
            <small className="composer-actions-hint">可直接粘贴或拖入</small>
          </button>
          <div className="composer-actions-separator" role="separator" />
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

      {!isolated &&
        contributions.composerToolbar.map((action) => (
          <LegacyComposerContribBox
            key={action.id}
            id={action.id}
            pluginId={action.pluginId}
            slotKey="composer.toolbar"
            legacySlotName="composerToolbar"
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
  isolated = false,
  sessionId,
}: SlotComponentProps<ComposerStatusSlotProps, "session-maybe">): ReactNode {
  const sessionState = useSessionState();
  const { snapshot: handleSnap } = useSessionHandle(sessionId);
  const contributions = useClientContributions();
  const contribCtx: WorkbenchSlotContext = { cwd, sessionFile, variant };

  const matchedContribs = isolated
    ? []
    : contributions.composerStatus.filter((item) =>
        position === "before-model" ? item.position === "before-model" : item.position !== "before-model",
      );

  const stats = variant === "follow-up" ? (handleSnap?.stats ?? sessionState?.stats ?? null) : null;
  const metrics = computeContextUsageMetrics(stats?.contextUsage);
  const showBuiltInTelemetry =
    position === "before-model" && (isolated || contributions.composerStatus.length === 0);
  const tokens = stats?.tokens;
  const costTitle =
    tokens !== undefined
      ? `会话预估成本 · 输入 ${tokens.input.toLocaleString()} / 输出 ${tokens.output.toLocaleString()}${
          tokens.reasoning ? `（推理 ${tokens.reasoning.toLocaleString()}）` : ""
        }`
      : "会话预估成本";

  return (
    <>
      {matchedContribs.map((item) => (
        <LegacyComposerContribBox
          key={item.id}
          id={item.id}
          pluginId={item.pluginId}
          slotKey="composer.status"
          legacySlotName="composerStatus"
          renderFn={item.render}
          context={contribCtx}
          className="composer-plugin-status"
          compact
        />
      ))}

      {showBuiltInTelemetry && stats !== null && stats.cost > 0 && (
        <span className="composer-session-cost" title={costTitle}>
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
            aria-describedby="composer-context-usage-tooltip"
            style={{ "--context-percent": `${metrics.normalizedContextPercent}%` } as CSSProperties}
          />
          <span id="composer-context-usage-tooltip" className="composer-context-tooltip" role="tooltip">
            <span className="composer-context-tooltip-label">上下文窗口：</span>
            <span
              className={
                metrics.normalizedContextPercent >= 50 ? "composer-context-tooltip-muted" : undefined
              }
            >
              {metrics.normalizedContextPercent >= 50
                ? `${metrics.normalizedContextPercent}% 已用`
                : `${metrics.normalizedContextPercent}% 已用（剩余 ${metrics.remainingContextPercent}%）`}
            </span>
            {metrics.contextUsedThousands !== null && metrics.contextWindowThousands !== null && (
              <span>
                已用 {metrics.contextUsedThousands}K token，共 {metrics.contextWindowThousands}K
              </span>
            )}
          </span>
        </span>
      )}
    </>
  );
}
