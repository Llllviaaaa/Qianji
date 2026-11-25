import { useState, type KeyboardEvent } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { callHostRpc, useActiveSession, useHostRpcQuery } from "@qianji/client";
import type { SlotComponentProps, SlotPropsOf } from "@qianji/client-slots";
import {
  Check,
  LoaderCircle,
  Lock,
  MessageSquareReply,
  RefreshCw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import {
  parseConfirmDiffSegments,
  parsePermissionEnvelopeFromRequest,
  parseRequestPermissionResult,
  serializePermissionResponse,
  type PermissionDecisionKind,
  type PermissionInspectResult,
  type PermissionPromptEnvelope,
} from "./shared.ts";
import { PERMISSION_SCOPED_CSS } from "./styles.ts";

export const name = "permission";
export const inject = ["slots", "styles"];

type ApprovalProps = SlotComponentProps<
  SlotPropsOf<"conversation.approvalDialog">,
  "session",
  unknown,
  PermissionPromptEnvelope
>;

type ToolCallProps = SlotComponentProps<SlotPropsOf<"conversation.toolCall">, "session">;
type SettingsSectionProps = SlotComponentProps<SlotPropsOf<"settings.sections">, "root">;

function diffLineClass(line: string): string {
  if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("@@")) {
    return "qj-perm-diff-line is-meta";
  }
  if (line.startsWith("+")) return "qj-perm-diff-line is-add";
  if (line.startsWith("-")) return "qj-perm-diff-line is-del";
  return "qj-perm-diff-line";
}

export function PermissionApprovalCard({ request, onAnswer, selected }: ApprovalProps) {
  const envelope = selected ?? parsePermissionEnvelopeFromRequest(request);
  const requestId = typeof request.id === "string" ? request.id : "";

  const [trackedId, setTrackedId] = useState(requestId);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackDraft, setFeedbackDraft] = useState("");

  if (trackedId !== requestId) {
    setTrackedId(requestId);
    setFeedbackOpen(false);
    setFeedbackDraft("");
  }

  if (!envelope) return null;

  const respond = (decision: PermissionDecisionKind) => {
    const trimmedFeedback = feedbackDraft.trim();
    const payload = serializePermissionResponse({
      decision,
      ...(decision === "deny" && trimmedFeedback !== "" ? { feedback: trimmedFeedback } : {}),
    });
    onAnswer(requestId, { value: payload });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      respond("deny");
      return;
    }
    if (feedbackOpen || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Enter") {
      event.preventDefault();
      respond("allow_once");
    } else if ((event.key === "s" || event.key === "S") && envelope.allowSessionOption) {
      event.preventDefault();
      respond("allow_session");
    } else if ((event.key === "a" || event.key === "A") && envelope.allowAlwaysOption) {
      event.preventDefault();
      respond("allow_always");
    }
  };

  const parsedDiff = parseConfirmDiffSegments(envelope.message);
  const isAgentRequest = envelope.source === "agent_request";
  const RiskIcon = envelope.riskLevel === "high" ? ShieldAlert : envelope.riskLevel === "low" ? ShieldCheck : Shield;

  return (
    <section
      className={`qj-perm-card is-${envelope.riskLevel}`}
      data-qj-plugin="permission"
      data-permission-dialog=""
      data-risk-level={envelope.riskLevel}
      role="dialog"
      aria-label={envelope.title}
      onKeyDown={handleKeyDown}
    >
      <header className="qj-perm-head">
        <div className="qj-perm-head-left">
          <span className="qj-perm-kind-badge">
            <RiskIcon size={13.5} />
            <span>{isAgentRequest ? "智能体申请权限" : "需要确认"}</span>
          </span>
          {envelope.showRiskBadge && (
            <span className={`qj-perm-risk-pill is-${envelope.riskLevel}`}>{envelope.riskLabel}</span>
          )}
        </div>
        <span className="qj-perm-shortcut">
          {envelope.allowSessionOption ? "Enter 允许一次 · S 本会话允许 · Esc 拒绝" : "Enter 批准 · Esc 拒绝"}
        </span>
      </header>

      <h2 className="qj-perm-title">{envelope.title}</h2>

      {(envelope.toolName || envelope.requestedPermission || envelope.targetPath) && (
        <div className="qj-perm-meta-chips">
          {envelope.toolName && (
            <span className="qj-perm-chip">
              <Terminal size={11.5} />
              <span>{envelope.toolName}</span>
            </span>
          )}
          {envelope.requestedAgentMode && (
            <span className="qj-perm-chip">模式: {envelope.requestedAgentMode}</span>
          )}
          {envelope.requestedPermission && (
            <span className="qj-perm-chip">
              <Lock size={11} />
              <span>权限: {envelope.requestedPermission}</span>
            </span>
          )}
          {envelope.targetPath && <span className="qj-perm-chip">{envelope.targetPath}</span>}
        </div>
      )}

      {envelope.reason && <div className="qj-perm-reason">申请理由：{envelope.reason}</div>}

      {parsedDiff.diffLines !== null ? (
        <div>
          {parsedDiff.before !== "" && (
            <p style={{ margin: "0 0 6px", fontSize: "12.5px", color: "var(--qj-text-secondary)" }}>
              {parsedDiff.before}
            </p>
          )}
          <div className="qj-perm-diff" role="region" aria-label="变更预览">
            {parsedDiff.diffLines.map((line, idx) => (
              <div key={`${idx}-${line.slice(0, 10)}`} className={diffLineClass(line)}>
                {line || " "}
              </div>
            ))}
          </div>
          {parsedDiff.after !== "" && (
            <p style={{ margin: "6px 0 0", fontSize: "12.5px", color: "var(--qj-text-secondary)" }}>
              {parsedDiff.after}
            </p>
          )}
        </div>
      ) : (
        envelope.message.trim() !== "" && <pre className="qj-perm-codebox">{envelope.message}</pre>
      )}

      {envelope.suggestedGrant && (envelope.allowSessionOption || envelope.allowAlwaysOption) && (
        <div className="qj-perm-scope-hint">
          同类匹配范围：<strong>{envelope.suggestedGrant.label}</strong>
        </div>
      )}

      {feedbackOpen && envelope.allowDenyFeedback && (
        <div className="qj-perm-feedback-box">
          <input
            type="text"
            className="qj-perm-feedback-input"
            value={feedbackDraft}
            placeholder="告诉智能体拒绝原因或替代做法（按 Enter 直接附言拒绝）…"
            onChange={(e) => setFeedbackDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent?.isComposing) return;
              e.preventDefault();
              e.stopPropagation();
              respond("deny");
            }}
          />
        </div>
      )}

      <footer className="qj-perm-footer">
        <div className="qj-perm-footer-left">
          <button type="button" className="qj-perm-btn is-danger" onClick={() => respond("deny")}>
            <X size={13.5} />
            <span>{feedbackDraft.trim() !== "" ? "附言拒绝" : "拒绝"}</span>
          </button>

          {envelope.allowDenyFeedback && !feedbackOpen && (
            <button
              type="button"
              className="qj-perm-btn is-ghost"
              onClick={() => setFeedbackOpen(true)}
              title="附带拒绝原因或修改建议反馈给智能体"
            >
              <MessageSquareReply size={13} />
              <span>附言说明</span>
            </button>
          )}
        </div>

        <div className="qj-perm-footer-right">
          {envelope.allowAlwaysOption && (
            <button
              type="button"
              className="qj-perm-btn"
              title={`永久允许 ${envelope.suggestedGrant?.label ?? "此类操作"}（可在设置中随时移除）`}
              onClick={() => respond("allow_always")}
            >
              <ShieldCheck size={13.5} />
              <span>始终允许</span>
            </button>
          )}

          {envelope.allowSessionOption && (
            <button
              type="button"
              className="qj-perm-btn is-session"
              title={`当前会话内自动放行 ${envelope.suggestedGrant?.label ?? "同类操作"}`}
              onClick={() => respond("allow_session")}
            >
              <Shield size={13.5} />
              <span>本会话允许</span>
            </button>
          )}

          <button type="button" className="qj-perm-btn is-primary" onClick={() => respond("allow_once")}>
            <Check size={13.5} />
            <span>{isAgentRequest && !envelope.allowSessionOption ? "批准切换" : "允许一次"}</span>
          </button>
        </div>
      </footer>
    </section>
  );
}

export function PermissionToolCallCard({ call, state }: ToolCallProps) {
  const rawArgs = (typeof call.args === "object" && call.args !== null ? call.args : {}) as Record<string, unknown>;
  const parsed = parseRequestPermissionResult(call.result);
  const reason = parsed?.reason ?? (typeof rawArgs.reason === "string" ? rawArgs.reason : "申请执行权限");

  const targetSummary =
    parsed?.grantLabel ??
    (parsed?.requestedPermission
      ? `${parsed.requestedAgentMode ?? "agent"} · ${parsed.requestedPermission}`
      : typeof rawArgs.requestedPermission === "string"
        ? `${typeof rawArgs.requestedAgentMode === "string" ? rawArgs.requestedAgentMode : "agent"} · ${rawArgs.requestedPermission}`
        : typeof rawArgs.commandPrefix === "string"
          ? `命令前缀 "${rawArgs.commandPrefix}"`
          : typeof rawArgs.toolName === "string"
            ? rawArgs.toolName
            : "会话权限");

  const badge =
    state === "running"
      ? { label: "等待审批…", cls: "is-running" }
      : parsed?.status === "granted"
        ? {
            label:
              parsed.decision === "allow_always"
                ? "已始终允许"
                : parsed.decision === "allow_session"
                  ? "本会话已允许"
                  : "已批准",
            cls: "",
          }
        : { label: "已拒绝", cls: "is-denied" };

  return (
    <div className="qj-perm-tool-card" data-qj-plugin="permission" data-tool-card="request_permission">
      <div className="qj-perm-tool-main">
        {state === "running" ? <LoaderCircle size={13.5} /> : <ShieldCheck size={14} />}
        <span className="qj-perm-tool-text" title={`${targetSummary} — ${reason}`}>
          <strong>权限申请（{targetSummary}）</strong>：{reason}
          {parsed?.feedback ? `（反馈：${parsed.feedback}）` : ""}
        </span>
      </div>
      <span className={`qj-perm-tool-pill ${badge.cls}`}>{badge.label}</span>
    </div>
  );
}

export function PermissionGrantsSettingsSection({ page }: SettingsSectionProps) {
  const activeSession = useActiveSession();
  const sessionId = activeSession.sessionId?.trim() ?? "";
  const [busy, setBusy] = useState(false);

  const shouldRender = page === "plugins" || page === "general";
  const { data, refetch } = useHostRpcQuery<PermissionInspectResult>(
    "permissionPlugin.inspect",
    sessionId !== "" ? { sessionId } : {},
    { enabled: shouldRender },
  );

  if (!shouldRender) return null;

  const sessionGrants = data?.sessionGrants ?? [];
  const alwaysRules = data?.alwaysRules ?? [];

  if (page === "general" && sessionGrants.length === 0 && alwaysRules.length === 0) {
    return null;
  }

  const revokeSession = async (grantId?: string) => {
    if (sessionId === "" || busy) return;
    setBusy(true);
    try {
      await callHostRpc("permissionPlugin.revokeSessionGrant", {
        sessionId,
        ...(grantId === undefined ? {} : { grantId }),
      });
      await refetch();
    } finally {
      setBusy(false);
    }
  };

  const removeAlways = async (ruleId?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await callHostRpc("permissionPlugin.removeAlwaysRule", ruleId === undefined ? {} : { ruleId });
      await refetch();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="settings-layered-section settings-plugin-section"
      data-qj-plugin="permission"
      data-testid="permission-grants-settings-section"
    >
      <div className="qj-perm-settings">
        <div className="qj-perm-settings-head">
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <ShieldCheck size={15} style={{ color: "var(--qj-brand-primary)" }} />
            <strong style={{ fontSize: "13px" }}>会话临时授权与持久允许规则</strong>
          </div>
          <button type="button" className="qj-perm-btn" disabled={busy} onClick={() => void refetch()}>
            <RefreshCw size={12} />
            <span>刷新</span>
          </button>
        </div>

        {sessionGrants.length === 0 && alwaysRules.length === 0 ? (
          <div style={{ fontSize: "12px", color: "var(--qj-text-secondary)" }}>
            暂无已记录的「本会话允许」或「始终允许」规则。在工具审批弹窗中点击对应按钮即可在此集中查看或撤销。
          </div>
        ) : (
          <div className="qj-perm-rule-list">
            {sessionGrants.map((item) => (
              <div key={item.id} className="qj-perm-rule-row">
                <span>
                  <strong>[本会话]</strong> {item.label}
                </span>
                <button
                  type="button"
                  className="qj-perm-btn is-danger"
                  disabled={busy}
                  onClick={() => void revokeSession(item.id)}
                >
                  <Trash2 size={12} />
                  <span>撤销</span>
                </button>
              </div>
            ))}
            {alwaysRules.map((item) => (
              <div key={item.id} className="qj-perm-rule-row">
                <span>
                  <strong>[始终允许]</strong> {item.label}
                </span>
                <button
                  type="button"
                  className="qj-perm-btn is-danger"
                  disabled={busy}
                  onClick={() => void removeAlways(item.id)}
                >
                  <Trash2 size={12} />
                  <span>移除</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export function apply(ctx: Context): void {
  ctx.styles.inject(PERMISSION_SCOPED_CSS, "permission:styles");

  ctx.slots.register<"conversation.approvalDialog", unknown, PermissionPromptEnvelope>(
    "conversation.approvalDialog",
    {
      id: "permission:approval-dialog",
      priority: 25,
      select: (props) => parsePermissionEnvelopeFromRequest(props.request) ?? false,
      component: PermissionApprovalCard,
    },
  );

  ctx.slots.register("conversation.toolCall", {
    id: "permission:tool-call",
    key: ["request_permission"],
    priority: 20,
    component: PermissionToolCallCard,
  });

  ctx.slots.register("settings.sections", {
    id: "permission:settings-grants",
    order: 45,
    component: PermissionGrantsSettingsSection,
  });
}

export default {
  name,
  inject,
  apply,
};
