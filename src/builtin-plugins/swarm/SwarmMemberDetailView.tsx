/**
 * Member Detail Inspector (`src/builtin-plugins/swarm/SwarmMemberDetailView.tsx`).
 *
 * - Streamlined toolbar: `返回` + Pixel Bee + `@name` + role tag + inline Model `<Select>`
 *   + `合并变更 (N)` primary button + `终止` icon button with confirmation `<Dialog>`.
 * - Sub-tabs (`实时对话` | `代码变更 N`): mounts `renderFactory("conversation.surface", ...)`
 *   or displays clickable file pills, line-numbered unified Git diff, and inline review bar.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  ArrowLeft,
  FileCode2,
  GitBranch,
  GitMerge,
  MessageSquare,
  RefreshCw,
  Send,
  Trash2,
} from "lucide-react";
import { useFrontendService, useSessionState } from "@qianji/client";
import { Button, Dialog, IconButton, Select, type SelectOption } from "@qianji/client-primitives";
import type { BoundRenderFactoryFn } from "@qianji/client-slots";
import type { SwarmMemberInfo, SwarmSnapshotResult } from "@qianji/protocol";
import { SwarmPixelBee } from "./SwarmPixelBee";
import { MEMBER_ROLE_LABELS, parseUnifiedDiffRows, WORKSPACE_MODE_LABELS } from "./swarmLabels";
import {
  decodeRoleModelValue,
  encodeRoleModelValue,
  patchSwarmUi,
  selectSwarmMember,
  swarmMemberDiffKey,
  useSwarmData,
  useSwarmUi,
  type SwarmInspectorTab,
} from "./swarmStore";
import { useSwarmController } from "./useSwarmController";

export interface SwarmMemberDetailViewProps {
  readonly snapshot: SwarmSnapshotResult;
  readonly member: SwarmMemberInfo;
  readonly renderFactory: BoundRenderFactoryFn;
  readonly ctx?: Context;
}

function InspectorSessionFallback({ member }: { readonly member: SwarmMemberInfo }): ReactElement {
  return (
    <div className="qj-swarm-inspector-fallback" data-testid="swarm-inspector-session-fallback">
      <MessageSquare size={18} />
      <strong>@{member.name} 实时对话</strong>
      <span>会话 ID：{member.sessionId || "待分配"}</span>
      {member.brief !== "" && <p className="qj-swarm-brief-preview">{member.brief}</p>}
    </div>
  );
}

export function SwarmMemberDetailView({
  snapshot,
  member,
  renderFactory,
  ctx,
}: SwarmMemberDetailViewProps): ReactElement {
  const data = useSwarmData();
  const ui = useSwarmUi();
  const sessionSnap = useSessionState(ctx);
  const workbenchService = useFrontendService("workbenchService", ctx);
  const controller = useSwarmController(ctx);
  const { loadConfig, loadWorktreeDiff } = controller;

  const [reviewFeedback, setReviewFeedback] = useState("");
  const [confirmKillOpen, setConfirmKillOpen] = useState(false);
  const [syncedMember, setSyncedMember] = useState(member.name);
  const autoFetchedDiffKeyRef = useRef("");
  const loadedCatalogRef = useRef(false);

  if (syncedMember !== member.name) {
    setSyncedMember(member.name);
    setReviewFeedback("");
    setConfirmKillOpen(false);
  }

  const swarmId = snapshot.run.id;
  const diffKey = swarmMemberDiffKey(swarmId, member.name);
  const cachedDiff = data.diffsByMemberKey[diffKey];

  useEffect(() => {
    if (!loadedCatalogRef.current && data.availableModels.length === 0) {
      loadedCatalogRef.current = true;
      void loadConfig(swarmId);
    }
  }, [data.availableModels.length, loadConfig, swarmId]);

  useEffect(() => {
    if (ui.inspectorTab !== "diff") {
      autoFetchedDiffKeyRef.current = "";
      return undefined;
    }
    const requestKey = `${swarmId}:${member.name}`;
    if (cachedDiff === undefined && autoFetchedDiffKeyRef.current !== requestKey) {
      autoFetchedDiffKeyRef.current = requestKey;
      void loadWorktreeDiff(swarmId, member.name);
    }
    return undefined;
  }, [cachedDiff, loadWorktreeDiff, member.name, swarmId, ui.inspectorTab]);

  const currentEncodedModel = encodeRoleModelValue({
    provider: member.provider ?? "",
    model: member.model,
  });

  const modelOptions = useMemo<SelectOption[]>(() => {
    const list: SelectOption[] = [];
    const seen = new Set<string>();
    const catalog =
      data.availableModels.length > 0
        ? data.availableModels
        : (sessionSnap?.availableModels ?? []).map((m) => ({
            provider: m.provider,
            providerName: m.provider,
            id: m.id,
            name: m.name || m.id,
            reasoning: m.reasoning === true,
          }));

    for (const item of catalog) {
      const val = encodeRoleModelValue({ provider: item.provider, model: item.id });
      if (val !== "" && !seen.has(val)) {
        seen.add(val);
        list.push({ value: val, label: item.name || item.id });
      }
    }
    if (currentEncodedModel !== "" && !seen.has(currentEncodedModel)) {
      const short = member.model.split("/").pop() ?? member.model;
      list.unshift({ value: currentEncodedModel, label: short });
    }
    if (list.length === 0) {
      list.push({ value: "", label: "默认模型" });
    }
    return list;
  }, [currentEncodedModel, data.availableModels, member.model, sessionSnap?.availableModels]);

  const changeCount = Math.max(member.changedFileCount, cachedDiff?.changedFiles.length ?? 0);
  const hasUnmergedChanges =
    member.workspaceMode !== "inherit" &&
    (changeCount > 0 || (cachedDiff !== undefined && !cachedDiff.empty));
  const diffRows = useMemo(
    () => (cachedDiff?.diffText ? parseUnifiedDiffRows(cachedDiff.diffText) : []),
    [cachedDiff],
  );
  const isQueen = member.role === "coordinator" || member.name === "coordinator";

  const handleModelSwitch = (encoded: string) => {
    if (encoded === "" || encoded === currentEncodedModel) return;
    const decoded = decodeRoleModelValue(encoded);
    if (decoded === null) return;
    void controller.controlMember(swarmId, member.name, "switchModel", {
      ...(decoded.provider !== "" ? { provider: decoded.provider } : {}),
      model: decoded.model,
    });
  };

  const handleReviewSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = reviewFeedback.trim();
    if (trimmed === "") return;
    const res = await controller.controlMember(swarmId, member.name, "nudge", {
      message: `[代码审查意见] ${trimmed}`,
    });
    if (res !== null) setReviewFeedback("");
  };

  const setSubTab = (tab: SwarmInspectorTab) => {
    patchSwarmUi({ inspectorTab: tab });
  };

  return (
    <section className="qj-swarm-member-detail" data-testid="swarm-member-detail" data-member={member.name}>
      <header className="qj-swarm-detail-head">
        <div className="qj-swarm-detail-ident">
          <button
            type="button"
            className="qj-swarm-back-btn"
            data-testid="swarm-member-back-btn"
            onClick={() => selectSwarmMember(null)}
          >
            <ArrowLeft size={13} />
            <span>返回</span>
          </button>
          <SwarmPixelBee
            name={member.name}
            isQueen={isQueen}
            state={member.state}
            killed={member.killed}
            size="sm"
          />
          <strong className="qj-swarm-detail-name">@{member.name}</strong>
          <span className="qj-swarm-member-role">{MEMBER_ROLE_LABELS[member.role]}</span>
        </div>

        <div className="qj-swarm-detail-controls">
          {!member.killed && (
            <Select
              aria-label={`@${member.name} 模型选择`}
              wrapperClassName="qj-swarm-inline-model-select"
              data-testid="swarm-member-model-select"
              value={currentEncodedModel}
              options={modelOptions}
              onValueChange={handleModelSwitch}
            />
          )}

          {hasUnmergedChanges && (
            <Button
              variant="primary"
              size="sm"
              disabled={ui.busyAction !== null}
              data-testid="swarm-member-merge-btn"
              onClick={() =>
                void controller.controlMember(swarmId, member.name, "mergeWorktree", {
                  applyChanges: true,
                })
              }
            >
              <GitMerge size={12} />
              <span>合并变更 ({changeCount})</span>
            </Button>
          )}

          {!isQueen && !member.killed && (
            <IconButton
              size="sm"
              variant="ghost"
              aria-label={`终止成员 @${member.name}`}
              tooltip="终止并退役该成员"
              onClick={() => setConfirmKillOpen(true)}
            >
              <Trash2 size={13} />
            </IconButton>
          )}
        </div>
      </header>

      <div className="qj-swarm-detail-subtabs" role="tablist" aria-label="成员详情视图">
        <button
          type="button"
          role="tab"
          aria-selected={ui.inspectorTab === "session"}
          className={`qj-swarm-underline-tab${ui.inspectorTab === "session" ? " active" : ""}`}
          onClick={() => setSubTab("session")}
        >
          <span>实时对话</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={ui.inspectorTab === "diff"}
          className={`qj-swarm-underline-tab${ui.inspectorTab === "diff" ? " active" : ""}`}
          onClick={() => setSubTab("diff")}
        >
          <span>代码变更</span>
          {changeCount > 0 && <span className="qj-swarm-tab-count">{changeCount}</span>}
        </button>
      </div>

      <div className="qj-swarm-detail-body">
        {ui.inspectorTab === "session" ? (
          <div className="qj-swarm-inspector-session" data-testid="swarm-inspector-session">
            {renderFactory(
              "conversation.surface",
              {
                sessionId: member.sessionId,
                cwd: member.worktreePath ?? snapshot.run.cwd,
                compact: true,
                isolated: true,
              },
              {
                occurrenceKey: `swarm:${swarmId}:${member.name}`,
                fallback: <InspectorSessionFallback member={member} />,
              },
            )}
          </div>
        ) : (
          <div className="qj-swarm-inspector-diff" data-testid="swarm-inspector-diff">
            <div className="qj-swarm-diff-toolbar">
              <div className="qj-swarm-diff-badges">
                <span className="qj-swarm-role-pill">{WORKSPACE_MODE_LABELS[member.workspaceMode]}</span>
                {cachedDiff?.branchName && (
                  <span className="qj-swarm-branch-pill">
                    <GitBranch size={11} />
                    <span>{cachedDiff.branchName}</span>
                  </span>
                )}
              </div>
              <div className="qj-swarm-diff-actions">
                <IconButton
                  size="sm"
                  aria-label="刷新代码变更"
                  onClick={() => void controller.loadWorktreeDiff(swarmId, member.name)}
                >
                  <RefreshCw size={12.5} />
                </IconButton>
                {member.workspaceMode !== "inherit" && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={cachedDiff?.empty === true || ui.busyAction !== null}
                    onClick={() =>
                      void controller.controlMember(swarmId, member.name, "mergeWorktree", {
                        applyChanges: true,
                      })
                    }
                  >
                    <GitMerge size={12} />
                    <span>合并到工作区</span>
                  </Button>
                )}
              </div>
            </div>

            {cachedDiff !== undefined && cachedDiff.changedFiles.length > 0 && (
              <div className="qj-swarm-diff-files">
                {cachedDiff.changedFiles.map((file) => (
                  <button
                    key={file}
                    type="button"
                    className="qj-swarm-file-chip"
                    onClick={() =>
                      void workbenchService?.openFile(file, {
                        cwd: member.worktreePath ?? snapshot.run.cwd,
                      })
                    }
                  >
                    <FileCode2 size={11} />
                    <span>{file}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="qj-swarm-diff-viewer" role="region" aria-label="Unified Diff 预览">
              {cachedDiff === undefined ? (
                <div className="qj-swarm-empty-state">正在读取代码变更对比…</div>
              ) : cachedDiff.empty || diffRows.length === 0 ? (
                <div className="qj-swarm-empty-state">暂无未合并的文件变更</div>
              ) : (
                <div className="qj-swarm-diff-table">
                  {diffRows.map((row, idx) => (
                    <div key={`${idx}-${row.text.slice(0, 12)}`} className={`qj-swarm-diff-line is-${row.kind}`}>
                      <span className="qj-swarm-diff-gutter" aria-hidden="true">{row.lineNo}</span>
                      <span className="qj-swarm-diff-code">{row.text || " "}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <form className="qj-swarm-composer-line" onSubmit={(e) => void handleReviewSubmit(e)}>
              <input
                type="text"
                value={reviewFeedback}
                onChange={(e) => setReviewFeedback(e.target.value)}
                placeholder={`向 @${member.name} 发送审查反馈…`}
                aria-label="代码审查反馈"
                className="qj-swarm-composer-input"
              />
              <IconButton
                size="sm"
                variant={reviewFeedback.trim() !== "" ? "primary" : "ghost"}
                type="submit"
                aria-label="发送审查反馈"
                disabled={reviewFeedback.trim() === ""}
              >
                <Send size={12.5} />
              </IconButton>
            </form>
          </div>
        )}
      </div>

      <Dialog
        open={confirmKillOpen}
        onOpenChange={setConfirmKillOpen}
        title={`确认终止 @${member.name}？`}
        description={
          hasUnmergedChanges
            ? `该成员在独立工作区中有 ${changeCount} 个未合并文件变更。终止将销毁其独立工作副本，建议先合并变更。`
            : "终止后该成员将永久退役并释放工作区资源。"
        }
        footer={
          <div className="qj-swarm-dialog-actions">
            <Button variant="secondary" size="sm" onClick={() => setConfirmKillOpen(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                setConfirmKillOpen(false);
                void controller.controlMember(swarmId, member.name, "kill", {
                  forceKillUnmerged: true,
                });
                selectSwarmMember(null);
              }}
            >
              确认终止
            </Button>
          </div>
        }
      >
        <p className="qj-swarm-dialog-note">
          如需仅调整模型，可直接使用顶栏下拉框原地切换模型，无需终止重建。
        </p>
      </Dialog>
    </section>
  );
}
