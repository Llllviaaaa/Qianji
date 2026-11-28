/**
 * Primary content panes (`general` | `server` | `connectors` | `plugins`) +
 * delegation to `BotSettingsSecondaryPane` for the Bot Settings shell.
 */
import { useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { ArrowRight, CalendarClock, Moon, Monitor, Play, Sun } from "lucide-react";
import { useAppStore, useFrontendService, useSessionState, useThemeState } from "@qianji/client";
import { Switch } from "@qianji/client-primitives";
import type { BoundRenderFactoryFn } from "@qianji/client-slots";
import { BotConnectorsConsole } from "./BotConnectorsConsole";
import { BotModelsSettingsPane, decodeBotModelKey, encodeBotModelKey } from "./BotModelsSettingsPane";
import { BotPluginsSettingsPane } from "./BotPluginsSettingsPane";
import { BotSettingsSecondaryPane } from "./BotSettingsSecondaryPanes";
import { VirtualServerConsole } from "./BotVirtualServerConsole";
import {
  openBotScheduledModal,
  openHostSettingsFromBot,
  patchBotUi,
  useBotController,
  useBotSnapshot,
  useBotUiState,
} from "./botStore";

export function BotSettingsPaneContent({
  ctx,
  renderFactory,
  onClose,
}: {
  readonly ctx?: Context;
  readonly renderFactory?: BoundRenderFactoryFn;
  readonly onClose: () => void;
}): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const themeService = useFrontendService("themeService", ctx);
  const navigationService = useFrontendService("navigationService", ctx);
  const workspaceService = useFrontendService("workspaceService", ctx);
  const themeSnap = useThemeState(ctx);
  const sessionState = useSessionState(ctx);
  const appSettings = useAppStore((s) => s.settings);
  const saveAppSettings = useAppStore((s) => s.saveSettings);

  const [wsDraft, setWsDraft] = useState(snapshot.customBotCwd ?? "");
  const [wsKey, setWsKey] = useState(snapshot.customBotCwd ?? "");
  const [procInput, setProcInput] = useState("");
  if (wsKey !== (snapshot.customBotCwd ?? "")) {
    setWsKey(snapshot.customBotCwd ?? "");
    setWsDraft(snapshot.customBotCwd ?? "");
  }

  const applyWorkspaceDir = async (nextDir: string) => {
    const clean = nextDir.trim();
    setWsDraft(clean);
    await ctrl.configureBot({ workspaceDir: clean });
    if (appSettings !== null) {
      await saveAppSettings({ ...appSettings, botWorkspaceDir: clean });
    }
    navigationService?.showToast(
      clean ? `分身主工作区已切换至：${clean}` : "已恢复默认分身主工作区",
      "info",
    );
  };

  const rawThemeId = themeSnap?.themeId ?? "";
  const activeThemeMode =
    rawThemeId === "light" || rawThemeId === "dark" || rawThemeId === "system"
      ? rawThemeId
      : (themeSnap?.resolvedScheme ?? "light") === "light"
        ? "light"
        : "dark";
  const closeToTray = appSettings?.closeToTrayInBotMode ?? true;
  const availableModels = sessionState?.availableModels ?? [];
  const pacing = snapshot.pacing;
  const modelCfg = snapshot.modelConfig;

  if (ui.settingsTab === "models") {
    return <BotModelsSettingsPane ctx={ctx} renderFactory={renderFactory} />;
  }

  if (ui.settingsTab === "server") {
    return <VirtualServerConsole ctx={ctx} />;
  }

  if (ui.settingsTab === "connectors") {
    return <BotConnectorsConsole ctx={ctx} />;
  }

  if (ui.settingsTab === "plugins") {
    return <BotPluginsSettingsPane ctx={ctx} />;
  }

  if (ui.settingsTab !== "general") {
    return <BotSettingsSecondaryPane ctx={ctx} onClose={onClose} />;
  }

  const addWatchedProcess = () => {
    const trimmed = procInput.trim();
    if (!trimmed) return;
    if (!snapshot.connectorConfigs.processSensor.watchedProcesses.includes(trimmed)) {
      void ctrl.configureBot({
        processSensor: {
          watchedProcesses: [...snapshot.connectorConfigs.processSensor.watchedProcesses, trimmed],
        },
      });
    }
    setProcInput("");
  };

  return (
    <div className="qj-bset-stack">
      {/* 1. Identity & Appearance */}
      <section className="qj-bset-group">
        <div className="qj-bset-group-head">
          <span className="qj-bset-group-title">身份与界面偏好</span>
          <button
            type="button"
            className="qj-bset-text-link"
            onClick={() => patchBotUi({ settingsTab: "voice" })}
          >
            <span>定制形象与声音</span>
            <ArrowRight size={12.5} />
          </button>
        </div>

        <div className="qj-bset-card">
          <div className="qj-bset-row">
            <div className="qj-bset-row-copy">
              <div className="qj-bset-row-title">分身名称</div>
              <div className="qj-bset-row-desc">显示在右侧陪伴栏、主聊天欢迎语与全局搜索中</div>
            </div>
            <input
              type="text"
              aria-label="分身名称"
              value={snapshot.profile.displayName}
              onChange={(e) => void ctrl.updateProfile({ displayName: e.target.value })}
              className="qj-bset-input sm"
            />
          </div>

          <div className="qj-bset-row">
            <div className="qj-bset-row-copy">
              <div className="qj-bset-row-title">外观模式</div>
              <div className="qj-bset-row-desc">
                同步切换千机 Agent 工作台与 Bot 形态配色，或{" "}
                <button
                  type="button"
                  className="qj-bset-inline-jump"
                  onClick={() => openHostSettingsFromBot(navigationService, "appearance")}
                >
                  定制主题与字号 ↗
                </button>
              </div>
            </div>
            <div className="qj-bset-seg" role="group" aria-label="外观模式切换">
              {([
                ["light", "浅色", Sun],
                ["dark", "深色", Moon],
                ["system", "系统", Monitor],
              ] as const).map(([mode, label, Icon]) => (
                <button
                  key={mode}
                  type="button"
                  className={`qj-bset-seg-btn${activeThemeMode === mode ? " active" : ""}`}
                  onClick={() => void themeService?.setTheme(mode)}
                >
                  <Icon size={12.5} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="qj-bset-row">
            <div className="qj-bset-row-copy">
              <div className="qj-bset-row-title">关闭窗口时驻留系统托盘</div>
              <div className="qj-bset-row-desc">关闭主窗后继续保持后台巡检、日程预警与长任务通知</div>
            </div>
            <Switch
              checked={closeToTray}
              aria-label="关闭窗口时驻留系统托盘"
              onCheckedChange={(checked) => {
                if (appSettings !== null) {
                  void saveAppSettings({ ...appSettings, closeToTrayInBotMode: checked });
                }
              }}
            />
          </div>
        </div>
      </section>

      {/* 2. Dedicated Bot Model Routing */}
      <section className="qj-bset-group">
        <div className="qj-bset-group-head">
          <span className="qj-bset-group-title">分身专属模型选择</span>
          <button
            type="button"
            className="qj-bset-text-link"
            onClick={() => patchBotUi({ settingsTab: "models" })}
          >
            <span>配置模型供应商与密钥</span>
            <ArrowRight size={12.5} />
          </button>
        </div>

        <div className="qj-bset-card qj-bset-card-pad">
          {availableModels.length === 0 && (
            <div className="qj-bset-callout">
              <span>当前尚未配置可用模型密钥，可在分身设置内直接添加 API 密钥或自定义服务商。</span>
              <button
                type="button"
                className="qj-bset-btn soft xs"
                onClick={() => patchBotUi({ settingsTab: "models" })}
              >
                去配置密钥
              </button>
            </div>
          )}

          <div className="qj-bset-grid-2">
            <label className="qj-bset-field">
              <span className="qj-bset-field-label">主力对话与理解模型</span>
              <select
                aria-label="主力对话模型"
                value={encodeBotModelKey(modelCfg.primary)}
                onChange={(e) => {
                  const nextPrimary = decodeBotModelKey(e.target.value);
                  void ctrl.configureBot({ modelConfig: { primary: nextPrimary } });
                }}
                className="qj-bset-select"
              >
                <option value="">跟随默认模型</option>
                {availableModels.map((m) => (
                  <option key={`${m.provider}::${m.id}`} value={`${m.provider}::${m.id}`}>
                    {m.name} ({m.provider})
                  </option>
                ))}
              </select>
            </label>

            <label className="qj-bset-field">
              <span className="qj-bset-field-label">后台轻巡检模型</span>
              <select
                aria-label="后台轻巡检模型"
                value={encodeBotModelKey(modelCfg.patrol)}
                onChange={(e) => {
                  const nextPatrol = decodeBotModelKey(e.target.value);
                  void ctrl.configureBot({ modelConfig: { patrol: nextPatrol } });
                }}
                className="qj-bset-select"
              >
                <option value="">跟随主力模型</option>
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

      {/* 3. Proactive Heartbeat & Quiet Hours */}
      <section className="qj-bset-group">
        <div className="qj-bset-group-head">
          <span className="qj-bset-group-title">贴心主动巡检 (Heartbeat) 与免打扰</span>
          <button
            type="button"
            className="qj-bset-text-link"
            onClick={() => openBotScheduledModal(null, { returnToCurrent: true })}
          >
            <CalendarClock size={12.5} />
            <span>管理预定任务</span>
            <ArrowRight size={12.5} />
          </button>
        </div>

        <div className="qj-bset-card">
          <div className="qj-bset-row">
            <div className="qj-bset-row-copy">
              <div className="qj-bset-row-title">后台静默巡检</div>
              <div className="qj-bset-row-desc">
                按周期巡视收件箱、日程与盯守进程；开会或免打扰时段仅收纳动态不弹窗
              </div>
            </div>
            <div className="qj-bset-inline-controls">
              <button
                type="button"
                disabled={ui.serverBusy}
                onClick={() => void ctrl.runPatrolNow()}
                className="qj-bset-btn soft sm"
              >
                <Play size={12} />
                <span>立即巡检</span>
              </button>
              <Switch
                checked={pacing.heartbeatEnabled}
                aria-label="启用后台主动巡检"
                onCheckedChange={(checked) => void ctrl.configureBot({ pacing: { heartbeatEnabled: checked } })}
              />
            </div>
          </div>

          <div className="qj-bset-subbar">
            <label className="qj-bset-inline-field">
              <span>巡检频率</span>
              <select
                aria-label="巡检频率"
                value={String(pacing.heartbeatIntervalMinutes)}
                onChange={(e) =>
                  void ctrl.configureBot({ pacing: { heartbeatIntervalMinutes: Number(e.target.value) } })
                }
                className="qj-bset-select compact"
              >
                <option value="5">每 5 分钟</option>
                <option value="15">每 15 分钟</option>
                <option value="30">每 30 分钟</option>
                <option value="60">每 60 分钟</option>
              </select>
            </label>

            <div className="qj-bset-inline-field">
              <Switch
                checked={pacing.quietHoursEnabled}
                aria-label="开启免打扰时段"
                onCheckedChange={(checked) => void ctrl.configureBot({ pacing: { quietHoursEnabled: checked } })}
              />
              <span>免打扰时段</span>
              <input
                type="time"
                aria-label="免打扰开始时间"
                value={pacing.quietHoursStart}
                onChange={(e) => void ctrl.configureBot({ pacing: { quietHoursStart: e.target.value } })}
                className="qj-bset-time-input"
              />
              <span>–</span>
              <input
                type="time"
                aria-label="免打扰结束时间"
                value={pacing.quietHoursEnd}
                onChange={(e) => void ctrl.configureBot({ pacing: { quietHoursEnd: e.target.value } })}
                className="qj-bset-time-input"
              />
            </div>
          </div>
        </div>
      </section>

      {/* 4. Workspace & Desktop Awareness */}
      <section className="qj-bset-group">
        <div className="qj-bset-group-head">
          <span className="qj-bset-group-title">工作空间与桌面感知</span>
        </div>

        <div className="qj-bset-card">
          <div className="qj-bset-row stack">
            <div className="qj-bset-row-top">
              <div className="qj-bset-row-copy">
                <div className="qj-bset-row-title">分身主工作区目录 (/workspace)</div>
                <div className="qj-bset-row-desc">
                  当前生效：<code className="qj-bset-code">{snapshot.botCwd || "默认目录"}</code>
                  <span className="qj-bset-tag">{snapshot.customBotCwd ? "自定义" : "默认"}</span>
                </div>
              </div>
              {Boolean(snapshot.customBotCwd) && (
                <button
                  type="button"
                  className="qj-bset-btn soft xs"
                  onClick={() => void applyWorkspaceDir("")}
                >
                  恢复默认
                </button>
              )}
            </div>

            <div className="qj-bset-path-bar">
              <input
                type="text"
                aria-label="分身主工作区目录"
                value={wsDraft}
                onChange={(e) => setWsDraft(e.target.value)}
                placeholder={snapshot.botCwd || "如 D:\\QianjiBot\\workspace（留空使用默认目录）"}
                className="qj-bset-input mono"
              />
              <button
                type="button"
                className="qj-bset-btn soft sm"
                onClick={async () => {
                  const picked = await workspaceService?.pickFolder().catch(() => null);
                  if (picked && picked.trim() !== "") {
                    await applyWorkspaceDir(picked.trim());
                  }
                }}
              >
                选择目录
              </button>
              <button
                type="button"
                className="qj-bset-btn primary sm"
                onClick={() => void applyWorkspaceDir(wsDraft)}
              >
                保存路径
              </button>
            </div>
          </div>

          <div className="qj-bset-row stack">
            <div className="qj-bset-row-top">
              <div className="qj-bset-row-copy">
                <div className="qj-bset-row-title">
                  电脑专注与进程完成感知
                  <span className="qj-bset-tag">{snapshot.awareness.busyState}</span>
                </div>
                <div className="qj-bset-row-desc">
                  开会或专注时自动静默；下方盯守的长耗时命令结束后主动通知你
                </div>
              </div>
              <Switch
                checked={snapshot.connectorConfigs.processSensor.enabled}
                aria-label="启用电脑专注与进程感知"
                onCheckedChange={(checked) => void ctrl.configureBot({ processSensor: { enabled: checked } })}
              />
            </div>

            <div className="qj-bset-chip-editor">
              {snapshot.connectorConfigs.processSensor.watchedProcesses.map((proc) => (
                <span key={proc} className="qj-connector-chip">
                  <span>{proc}</span>
                  <button
                    type="button"
                    aria-label={`移除盯守进程 ${proc}`}
                    onClick={() =>
                      void ctrl.configureBot({
                        processSensor: {
                          watchedProcesses: snapshot.connectorConfigs.processSensor.watchedProcesses.filter(
                            (p) => p !== proc,
                          ),
                        },
                      })
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                type="text"
                aria-label="添加盯守进程名"
                placeholder="输入进程名（如 cargo / ffmpeg）回车添加"
                value={procInput}
                onChange={(e) => setProcInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addWatchedProcess();
                  }
                }}
                className="qj-bset-input mono compact"
              />
              <button type="button" className="qj-bset-btn soft xs" onClick={addWatchedProcess}>
                + 盯守
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
