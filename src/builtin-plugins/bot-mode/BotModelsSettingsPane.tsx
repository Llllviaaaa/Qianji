/**
 * Native Bot Mode Model Routing & Provider Key Configuration Pane
 * (`src/builtin-plugins/bot-mode/BotModelsSettingsPane.tsx`).
 *
 * Configures Bot's dedicated Primary & Patrol models AND embeds full model
 * provider / API key / custom endpoint management right inside Bot Settings
 * via the `host.settings.providers` slot factory — zero jump to Agent Settings.
 */
import type { ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { Cpu, Sparkles } from "lucide-react";
import { useFrontendService, useSessionState } from "@qianji/client";
import type { BoundRenderFactoryFn } from "@qianji/client-slots";
import { useBotController, useBotSnapshot } from "./botStore";

export function encodeBotModelKey(ref?: { provider: string; model: string }): string {
  return ref?.provider && ref?.model ? `${ref.provider}::${ref.model}` : "";
}

export function decodeBotModelKey(raw: string): { provider: string; model: string } | null {
  const idx = raw.indexOf("::");
  if (idx <= 0 || idx >= raw.length - 2) return null;
  return { provider: raw.slice(0, idx), model: raw.slice(idx + 2) };
}

export function BotModelsSettingsPane({
  ctx,
  renderFactory,
}: {
  readonly ctx?: Context;
  readonly renderFactory?: BoundRenderFactoryFn;
}): ReactElement {
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const navigationService = useFrontendService("navigationService", ctx);
  const sessionState = useSessionState(ctx);

  const availableModels = sessionState?.availableModels ?? [];
  const defaultModel = sessionState?.model ?? availableModels[0] ?? null;
  const modelCfg = snapshot.modelConfig;

  const effectivePrimaryLabel = (() => {
    if (modelCfg.primary?.provider && modelCfg.primary?.model) {
      const matched = availableModels.find(
        (m) => m.provider === modelCfg.primary?.provider && m.id === modelCfg.primary?.model,
      );
      return matched ? `${matched.name} (${matched.provider})` : `${modelCfg.primary.model} (${modelCfg.primary.provider})`;
    }
    return defaultModel ? `${defaultModel.name} (${defaultModel.provider}) · 默认` : "尚未配置可用模型";
  })();

  return (
    <div className="qj-bset-stack" data-testid="bot-models-settings-pane">
      <section className="qj-bset-group">
        <div className="qj-bset-group-head">
          <span className="qj-bset-group-title">分身专属模型路由</span>
          <span className="qj-bset-tag" data-testid="bot-effective-model-badge">
            当前生效：{effectivePrimaryLabel}
          </span>
        </div>

        <div className="qj-bset-card qj-bset-card-pad">
          <div className="qj-bset-row-desc" style={{ marginBottom: 12 }}>
            可为分身单独指定主力对话模型与后台轻巡检/秒级总结模型，与 Agent 编码工作台互不干扰；切换后对当前主聊天与空闲旁聊立即生效。
          </div>

          <div className="qj-bset-grid-2">
            <label className="qj-bset-field">
              <span className="qj-bset-field-label">
                <Sparkles size={12.5} style={{ display: "inline", marginRight: 5, verticalAlign: "-2px" }} />
                主力对话与执行模型
              </span>
              <select
                aria-label="分身主力对话模型"
                data-testid="bot-primary-model-select"
                value={encodeBotModelKey(modelCfg.primary)}
                onChange={(e) => {
                  const nextPrimary = decodeBotModelKey(e.target.value);
                  void ctrl.configureBot({ modelConfig: { primary: nextPrimary } });
                  navigationService?.showToast(
                    nextPrimary
                      ? `分身主力模型已切换为 ${nextPrimary.model}`
                      : "分身主力模型已恢复跟随默认",
                    "info",
                  );
                }}
                className="qj-bset-select"
              >
                <option value="">
                  {defaultModel ? `跟随默认模型 (${defaultModel.name})` : "跟随默认模型"}
                </option>
                {availableModels.map((m) => (
                  <option key={`${m.provider}::${m.id}`} value={`${m.provider}::${m.id}`}>
                    {m.name} ({m.provider})
                  </option>
                ))}
              </select>
            </label>

            <label className="qj-bset-field">
              <span className="qj-bset-field-label">
                <Cpu size={12.5} style={{ display: "inline", marginRight: 5, verticalAlign: "-2px" }} />
                后台轻巡检与任务总结模型
              </span>
              <select
                aria-label="分身后台轻巡检模型"
                data-testid="bot-patrol-model-select"
                value={encodeBotModelKey(modelCfg.patrol)}
                onChange={(e) => {
                  const nextPatrol = decodeBotModelKey(e.target.value);
                  void ctrl.configureBot({ modelConfig: { patrol: nextPatrol } });
                  navigationService?.showToast(
                    nextPatrol
                      ? `后台轻巡检与总结模型已设为 ${nextPatrol.model}`
                      : "后台轻巡检与总结已恢复跟随主力模型",
                    "info",
                  );
                }}
                className="qj-bset-select"
              >
                <option value="">跟随分身主力模型</option>
                {availableModels.map((m) => (
                  <option key={`${m.provider}::${m.id}`} value={`${m.provider}::${m.id}`}>
                    {m.name} ({m.provider})
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </section>

      <section className="qj-bset-group">
        <div className="qj-bset-group-head">
          <span className="qj-bset-group-title">模型供应商、API 密钥与自定义端点</span>
        </div>
        <div className="qj-bset-embedded-providers" data-testid="bot-embedded-providers-host">
          {renderFactory ? (
            renderFactory("host.settings.providers", { hideDefaultPreferences: true }, {
              fallback: (
                <div className="qj-bset-card qj-bset-card-pad">
                  模型服务商配置面板正在加载中…
                </div>
              ),
            })
          ) : (
            <div className="qj-bset-card qj-bset-card-pad">
              当前环境未挂载服务商管理组件，请确认桌面宿主已初始化完成。
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
