/**
 * Multi-Role Swarm Model Configuration UI (`src/builtin-plugins/swarm/SwarmRoleModelsConfig.tsx`).
 * Configures `coordinator`, `planner`, `worker`, `explorer`, `verifier`, `monitor` + `defaultWorkerModel`
 * in `设置 -> 模型与密钥` (`settings.sections`, `page === "providers"`) and In-Session `SwarmRoleModelsModal`.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { Cpu, RotateCcw, Save, SlidersHorizontal } from "lucide-react";
import { useSessionState } from "@qianji/client";
import { Badge, Button, Dialog, Select, type SelectOption } from "@qianji/client-primitives";
import type { CoreShellModalProps, SettingsSectionSlotProps, SlotComponentProps } from "@qianji/client-slots";
import type { SwarmAvailableModelInfo, SwarmMemberRole, SwarmModelSettings, SwarmRoleModelConfig } from "@qianji/protocol";
import { SWARM_EFFORT_OPTIONS, SWARM_ROLE_SPECS } from "./swarmLabels";
import {
  decodeRoleModelValue, encodeRoleModelValue, patchSwarmUi, resolveSessionSwarmSummary,
  useSwarmData, useSwarmUi, type SwarmRoleModelsScope,
} from "./swarmStore";
import { useSwarmController } from "./useSwarmController";

function buildMergedModelCatalog(
  rpcModels: readonly SwarmAvailableModelInfo[],
  sessionModels: ReadonlyArray<{ readonly provider: string; readonly id: string; readonly name?: string; readonly reasoning?: boolean }>,
): SwarmAvailableModelInfo[] {
  if (rpcModels.length > 0) return [...rpcModels];
  return sessionModels.map((m) => ({
    provider: m.provider, providerName: m.provider, id: m.id, name: m.name || m.id, reasoning: m.reasoning === true,
  }));
}

function buildRoleSelectOptions(
  catalog: readonly SwarmAvailableModelInfo[],
  inheritLabel: string,
  currentCfg: SwarmRoleModelConfig | null | undefined,
): SelectOption[] {
  const options: SelectOption[] = [{ value: "", label: inheritLabel }];
  const currentEncoded = encodeRoleModelValue(currentCfg);
  let foundCurrent = currentEncoded === "";
  for (const m of catalog) {
    const val = encodeRoleModelValue({ provider: m.provider, model: m.id });
    if (val === currentEncoded) foundCurrent = true;
    options.push({ value: val, label: `${m.providerName || m.provider} / ${m.name || m.id}` });
  }
  if (!foundCurrent && currentCfg) {
    options.push({ value: currentEncoded, label: `${currentCfg.provider || "自定义"} / ${currentCfg.model} (已配置)` });
  }
  return options;
}

function isModelReasoningCapable(
  catalog: readonly SwarmAvailableModelInfo[],
  cfg: SwarmRoleModelConfig | null | undefined,
): boolean {
  if (!cfg || cfg.model.trim() === "") return false;
  if (cfg.effort !== undefined && cfg.effort !== "") return true;
  return catalog.find((m) => m.provider === cfg.provider && m.id === cfg.model)?.reasoning === true;
}

export interface SwarmRoleModelsConfiguratorProps {
  readonly scope: SwarmRoleModelsScope;
  readonly swarmId: string | null;
  readonly showApplyWaitingOption?: boolean;
  readonly onSaved?: () => void;
  readonly onCancel?: () => void;
  readonly ctx?: Context;
}

export function SwarmRoleModelsConfigurator({
  scope, swarmId, showApplyWaitingOption = false, onSaved, onCancel, ctx,
}: SwarmRoleModelsConfiguratorProps): ReactElement {
  const data = useSwarmData();
  const ui = useSwarmUi();
  const sessionSnap = useSessionState(ctx);
  const { loadConfig, updateConfig } = useSwarmController(ctx);

  const fetchedKeyRef = useRef<string>("");
  const targetKey = `${scope}:${swarmId ?? "global"}`;

  useEffect(() => {
    if (fetchedKeyRef.current === targetKey) return;
    fetchedKeyRef.current = targetKey;
    void loadConfig(swarmId);
  }, [loadConfig, swarmId, targetKey]);

  const storedOverrides = useMemo(
    () => (swarmId !== null ? (data.sessionRoleOverridesBySwarmId[swarmId] ?? {}) : {}),
    [data.sessionRoleOverridesBySwarmId, swarmId],
  );

  const syncToken = `${data.configRevision}:${scope}:${swarmId ?? ""}`;
  const [syncedToken, setSyncedToken] = useState(syncToken);
  const [draftDefaultWorker, setDraftDefaultWorker] = useState<SwarmRoleModelConfig | null>(
    () => data.globalModelConfig.defaultWorkerModel ?? null,
  );
  const [draftRoleModels, setDraftRoleModels] = useState<Partial<Record<SwarmMemberRole, SwarmRoleModelConfig>>>(
    () => (scope === "session" ? { ...storedOverrides } : { ...data.globalModelConfig.roleModels }),
  );
  const [applyToWaiting, setApplyToWaiting] = useState(true);

  if (syncedToken !== syncToken) {
    setSyncedToken(syncToken);
    setDraftDefaultWorker(data.globalModelConfig.defaultWorkerModel ?? null);
    setDraftRoleModels(scope === "session" ? { ...storedOverrides } : { ...data.globalModelConfig.roleModels });
  }

  const catalog = useMemo(
    () => buildMergedModelCatalog(data.availableModels, sessionSnap?.availableModels ?? []),
    [data.availableModels, sessionSnap?.availableModels],
  );

  const setRoleModelEncoded = (role: SwarmMemberRole, encoded: string) => {
    setDraftRoleModels((prev) => {
      const next = { ...prev };
      const decoded = decodeRoleModelValue(encoded, prev[role]?.effort);
      if (decoded === null) delete next[role];
      else next[role] = isModelReasoningCapable(catalog, decoded) ? decoded : { provider: decoded.provider, model: decoded.model };
      return next;
    });
  };

  const setRoleEffort = (role: SwarmMemberRole, effort: string) => {
    setDraftRoleModels((prev) => {
      const existing = prev[role];
      if (!existing) return prev;
      const nextCfg: SwarmRoleModelConfig =
        effort === "" ? { provider: existing.provider, model: existing.model } : { provider: existing.provider, model: existing.model, effort };
      return { ...prev, [role]: nextCfg };
    });
  };

  const handleResetAll = () => {
    if (scope === "global") setDraftDefaultWorker(null);
    setDraftRoleModels({});
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (scope === "session" && swarmId !== null) {
      const res = await updateConfig({
        swarmId,
        sessionOverrides: draftRoleModels,
        applyToWaitingMembers: showApplyWaitingOption ? applyToWaiting : false,
      });
      if (res !== null) onSaved?.();
      return;
    }
    const nextGlobal: SwarmModelSettings = { defaultWorkerModel: draftDefaultWorker, roleModels: draftRoleModels };
    const res = await updateConfig({
      globalConfig: nextGlobal,
      ...(swarmId !== null && showApplyWaitingOption ? { swarmId, applyToWaitingMembers: applyToWaiting } : {}),
    });
    if (res !== null) onSaved?.();
  };

  const isSaving = ui.busyAction === "config:update";

  return (
    <form className="qj-swarm-role-models-form" data-testid={`swarm-role-models-form-${scope}`} onSubmit={(e) => void handleSubmit(e)}>
      {scope === "global" && (
        <div className="qj-swarm-role-row is-fallback" data-role="defaultWorkerModel">
          <div className="qj-swarm-role-meta">
            <div className="qj-swarm-role-title-line">
              <Cpu size={13.5} />
              <strong>默认成员兜底模型</strong>
              <Badge variant="neutral">全局兜底</Badge>
            </div>
            <small>当具体执行角色未单独指定模型时优先使用；留空则自动跟随当前会话默认模型</small>
          </div>
          <div className="qj-swarm-role-controls">
            <Select
              aria-label="默认成员兜底模型"
              wrapperClassName="qj-swarm-model-select"
              value={encodeRoleModelValue(draftDefaultWorker)}
              options={buildRoleSelectOptions(catalog, "跟随当前会话默认模型", draftDefaultWorker)}
              onValueChange={(val) => {
                const decoded = decodeRoleModelValue(val, draftDefaultWorker?.effort);
                if (decoded === null) setDraftDefaultWorker(null);
                else setDraftDefaultWorker(isModelReasoningCapable(catalog, decoded) ? decoded : { provider: decoded.provider, model: decoded.model });
              }}
            />
            {isModelReasoningCapable(catalog, draftDefaultWorker) && draftDefaultWorker !== null && (
              <Select
                aria-label="默认成员兜底思考强度"
                wrapperClassName="qj-swarm-effort-select"
                value={draftDefaultWorker.effort ?? ""}
                options={SWARM_EFFORT_OPTIONS}
                onValueChange={(effort) =>
                  setDraftDefaultWorker(
                    effort === ""
                      ? { provider: draftDefaultWorker.provider, model: draftDefaultWorker.model }
                      : { provider: draftDefaultWorker.provider, model: draftDefaultWorker.model, effort },
                  )
                }
              />
            )}
          </div>
        </div>
      )}

      <div className="qj-swarm-role-list">
        {SWARM_ROLE_SPECS.map((spec) => {
          const current = draftRoleModels[spec.role];
          const globalForRole = data.globalModelConfig.roleModels[spec.role];
          const inheritLabel =
            scope === "session"
              ? globalForRole
                ? `继承全局配置 (${globalForRole.provider}/${globalForRole.model})`
                : "继承全局配置（跟随会话默认模型）"
              : "跟随当前会话默认模型";
          return (
            <div key={spec.role} className="qj-swarm-role-row" data-role={spec.role} data-testid={`swarm-role-row-${spec.role}`}>
              <div className="qj-swarm-role-meta">
                <div className="qj-swarm-role-title-line">
                  <Badge variant={spec.badgeVariant}>{spec.shortLabel}</Badge>
                  <strong>{spec.title}</strong>
                </div>
                <small>{spec.description}</small>
              </div>
              <div className="qj-swarm-role-controls">
                <Select
                  aria-label={`${spec.title} 模型选择`}
                  wrapperClassName="qj-swarm-model-select"
                  value={encodeRoleModelValue(current)}
                  options={buildRoleSelectOptions(catalog, inheritLabel, current)}
                  onValueChange={(val) => setRoleModelEncoded(spec.role, val)}
                />
                {isModelReasoningCapable(catalog, current) && (
                  <Select
                    aria-label={`${spec.title} 思考强度`}
                    wrapperClassName="qj-swarm-effort-select"
                    value={current?.effort ?? ""}
                    options={SWARM_EFFORT_OPTIONS}
                    onValueChange={(effort) => setRoleEffort(spec.role, effort)}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="qj-swarm-role-footer">
        <div className="qj-swarm-role-footer-left">
          <Button variant="ghost" size="sm" type="button" onClick={handleResetAll}>
            <RotateCcw size={12.5} />
            <span>重置为跟随默认</span>
          </Button>
          {showApplyWaitingOption && swarmId !== null && (
            <label className="qj-swarm-checkbox-label">
              <input type="checkbox" checked={applyToWaiting} onChange={(e) => setApplyToWaiting(e.target.checked)} />
              <span>保存后立即热切换当前待命成员</span>
            </label>
          )}
        </div>
        <div className="qj-swarm-role-footer-actions">
          {onCancel !== undefined && (
            <Button variant="secondary" size="sm" type="button" onClick={onCancel}>取消</Button>
          )}
          <Button variant="primary" size="sm" type="submit" disabled={isSaving} data-testid={`swarm-role-models-save-${scope}`}>
            <Save size={12.5} />
            <span>{isSaving ? "正在保存…" : "保存角色模型配置"}</span>
          </Button>
        </div>
      </div>
    </form>
  );
}

/* ── Place 1: Global Settings (`设置 -> 模型与密钥`, `page === "providers"`) ── */

export function SwarmSettingsModelsSection(
  props: SlotComponentProps<SettingsSectionSlotProps, "root">,
): ReactNode {
  if (props.page !== "providers") return null;
  return (
    <section className="settings-layered-section qj-swarm-settings-models" data-testid="swarm-settings-models-section">
      <div className="qj-swarm-settings-head">
        <div>
          <h2>蜂群各角色模型分配</h2>
          <p className="qj-swarm-settings-desc">
            按蜂群智能体的 6 类分工独立指定模型与思考强度（例如主控/规划用旗舰推理模型、调研/监控用轻量高性价比模型、质检用异构模型交叉验证）。
          </p>
        </div>
      </div>
      <div className="settings-soft-card qj-swarm-settings-card">
        <SwarmRoleModelsConfigurator scope="global" swarmId={null} ctx={props.ctx} />
      </div>
    </section>
  );
}

/* ── Place 2: In-Session Modal (`shell.modals`) ── */

export function SwarmRoleModelsModal({
  sessionFile: propSessionFile, ctx,
}: SlotComponentProps<CoreShellModalProps, "root">): ReactNode {
  const data = useSwarmData();
  const ui = useSwarmUi();
  const sessionSnap = useSessionState(ctx);

  if (!ui.roleModelsModalOpen) return null;

  const sessionSummary = resolveSessionSwarmSummary(
    data, ui, sessionSnap?.sessionId, propSessionFile ?? sessionSnap?.sessionFile,
  );
  const swarmId = sessionSummary?.run.id ?? ui.activeSwarmId ?? ui.pendingDraftSwarmId;
  const effectiveScope: SwarmRoleModelsScope = swarmId !== null ? ui.roleModelsModalScope : "global";

  return (
    <Dialog
      open={ui.roleModelsModalOpen}
      onOpenChange={(open) => patchSwarmUi({ roleModelsModalOpen: open })}
      className="qj-swarm-role-models-dialog"
      title={<span className="qj-swarm-dialog-title-inline"><SlidersHorizontal size={15} /><span>蜂群各角色模型配置</span></span>}
      description="独立配置协调者、规划师、编码员、调研员、质检员与看门狗所使用的模型与思考强度。"
    >
      <div className="qj-swarm-modal-scope-wrap" data-testid="swarm-role-models-modal">
        {swarmId !== null && (
          <div className="qj-swarm-scope-tabs" role="tablist" aria-label="配置生效范围">
            <button
              type="button"
              role="tab"
              aria-selected={effectiveScope === "session"}
              className={`qj-swarm-tab-btn${effectiveScope === "session" ? " active" : ""}`}
              onClick={() => patchSwarmUi({ roleModelsModalScope: "session" })}
            >
              <span>当前会话蜂群专属覆盖</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={effectiveScope === "global"}
              className={`qj-swarm-tab-btn${effectiveScope === "global" ? " active" : ""}`}
              onClick={() => patchSwarmUi({ roleModelsModalScope: "global" })}
            >
              <span>全局默认角色模型</span>
            </button>
          </div>
        )}
        <SwarmRoleModelsConfigurator
          scope={effectiveScope}
          swarmId={swarmId}
          showApplyWaitingOption={swarmId !== null}
          onCancel={() => patchSwarmUi({ roleModelsModalOpen: false })}
          onSaved={() => patchSwarmUi({ roleModelsModalOpen: false })}
          ctx={ctx}
        />
      </div>
    </Dialog>
  );
}
