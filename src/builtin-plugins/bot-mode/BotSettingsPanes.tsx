/**
 * Primary content panes (`general` | `server` | `connectors` | `voice`) +
 * delegation to `BotSettingsSecondaryPane` for the 9-tab Bot Settings modal.
 */
import { useRef, type ChangeEvent, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { useAppStore, useFrontendService, useSessionState, useThemeState } from "@qianji/client";
import { Switch } from "@qianji/client-primitives";
import { AVATAR_PRESET_LABELS, FELT_AVATAR_URIS } from "./BotAvatarArt";
import { BotConnectorsConsole } from "./BotConnectorsConsole";
import { BotSettingsSecondaryPane } from "./BotSettingsSecondaryPanes";
import { VirtualServerConsole } from "./BotVirtualServerConsole";
import { useBotController, useBotSnapshot, useBotUiState } from "./botStore";

function encodeModelKey(ref?: { provider: string; model: string }): string {
  return ref?.provider && ref?.model ? `${ref.provider}::${ref.model}` : "";
}

function decodeModelKey(raw: string): { provider: string; model: string } | undefined {
  const idx = raw.indexOf("::");
  if (idx <= 0 || idx >= raw.length - 2) return undefined;
  return { provider: raw.slice(0, idx), model: raw.slice(idx + 2) };
}

export function BotSettingsPaneContent({
  ctx,
  onClose,
}: {
  readonly ctx?: Context;
  readonly onClose: () => void;
}): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const themeService = useFrontendService("themeService", ctx);
  const themeSnap = useThemeState(ctx);
  const sessionState = useSessionState(ctx);
  const appSettings = useAppStore((s) => s.settings);
  const saveAppSettings = useAppStore((s) => s.saveSettings);
  const avatarFileRef = useRef<HTMLInputElement | null>(null);

  const isLight = (themeSnap?.resolvedScheme ?? "light") === "light";
  const closeToTray = appSettings?.closeToTrayInBotMode ?? true;
  const availableModels = sessionState?.availableModels ?? [];
  const pacing = snapshot.pacing;
  const modelCfg = snapshot.modelConfig;

  const handleAvatarUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        void ctrl.updateProfile({ avatarPreset: "custom", customAvatarDataUrl: reader.result });
      }
    };
    reader.readAsDataURL(file);
    event.target.value = "";
  };

  if (ui.settingsTab === "server") {
    return <VirtualServerConsole ctx={ctx} />;
  }

  if (ui.settingsTab === "general") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>通用</h3>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              padding: "14px 0",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              borderBottom: "1px solid var(--qj-border-default)",
            }}
          >
            <div>
              <div style={{ fontSize: 14, fontWeight: 520 }}>外观模式</div>
              <div style={{ fontSize: 12, color: "var(--qj-text-secondary)", marginTop: 2 }}>
                同步切换千机 Agent 工作台与 Bot 形态主题
              </div>
            </div>
            <button
              type="button"
              className="qj-soft-btn"
              style={{ height: 36, padding: "0 16px", fontSize: 12, fontWeight: 520 }}
              onClick={() => void themeService?.setTheme(isLight ? "dark" : "light")}
            >
              {isLight ? "浅色模式（点击切深色）" : "深色模式（点击切浅色）"}
            </button>
          </div>

          <div
            style={{
              padding: "14px 0",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              borderBottom: "1px solid var(--qj-border-default)",
            }}
          >
            <div>
              <div style={{ fontSize: 14, fontWeight: 520 }}>关闭窗口时驻留系统托盘</div>
              <div style={{ fontSize: 12, color: "var(--qj-text-secondary)", marginTop: 2 }}>
                关闭主窗后继续保持后台巡检、日程预警与长任务通知
              </div>
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

          <div
            style={{
              padding: "14px 0",
              display: "flex",
              flexDirection: "column",
              gap: 10,
              borderBottom: "1px solid var(--qj-border-default)",
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 520 }}>分身专属模型选择</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 12 }}>
              <div>
                <div style={{ color: "var(--qj-text-secondary)", marginBottom: 4 }}>主力对话与理解模型</div>
                <select
                  aria-label="主力对话模型"
                  value={encodeModelKey(modelCfg.primary)}
                  onChange={(e) => {
                    const nextPrimary = decodeModelKey(e.target.value);
                    void ctrl.configureBot({ modelConfig: { ...modelCfg, primary: nextPrimary } });
                  }}
                  style={{ width: "100%", padding: "7px 10px", borderRadius: 10, border: "1px solid var(--qj-border-default)", background: "var(--muse-soft-fill)", color: "var(--qj-text-primary)", fontSize: 12 }}
                >
                  <option value="">跟随工作台默认模型</option>
                  {availableModels.map((m) => (
                    <option key={`${m.provider}::${m.id}`} value={`${m.provider}::${m.id}`}>
                      {m.name} ({m.provider})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div style={{ color: "var(--qj-text-secondary)", marginBottom: 4 }}>后台轻巡检模型</div>
                <select
                  aria-label="后台轻巡检模型"
                  value={encodeModelKey(modelCfg.patrol)}
                  onChange={(e) => {
                    const nextPatrol = decodeModelKey(e.target.value);
                    void ctrl.configureBot({ modelConfig: { ...modelCfg, patrol: nextPatrol } });
                  }}
                  style={{ width: "100%", padding: "7px 10px", borderRadius: 10, border: "1px solid var(--qj-border-default)", background: "var(--muse-soft-fill)", color: "var(--qj-text-primary)", fontSize: 12 }}
                >
                  <option value="">跟随主力模型</option>
                  {availableModels.map((m) => (
                    <option key={`${m.provider}::${m.id}`} value={`${m.provider}::${m.id}`}>
                      {m.name} ({m.provider})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div
            style={{
              padding: "14px 0",
              display: "flex",
              flexDirection: "column",
              gap: 10,
              borderBottom: "1px solid var(--qj-border-default)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 520 }}>贴心主动巡检 (Heartbeat) 与免打扰时段</div>
                <div style={{ fontSize: 12, color: "var(--qj-text-secondary)", marginTop: 2 }}>
                  按设定周期巡视邮箱/日程/进程；免打扰与开会中自动收纳动态不弹窗
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  type="button"
                  disabled={ui.serverBusy}
                  onClick={() => void ctrl.runPatrolNow()}
                  className="qj-soft-btn"
                  style={{ height: 30, padding: "0 12px", fontSize: 12, whiteSpace: "nowrap", flexShrink: 0 }}
                >
                  立即巡检
                </button>
                <Switch
                  checked={pacing.heartbeatEnabled}
                  aria-label="启用后台主动巡检"
                  onCheckedChange={(checked) => void ctrl.configureBot({ pacing: { heartbeatEnabled: checked } })}
                />
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", fontSize: 12, color: "var(--qj-text-secondary)" }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span>巡检频率</span>
                <select
                  aria-label="巡检频率"
                  value={String(pacing.heartbeatIntervalMinutes)}
                  onChange={(e) => void ctrl.configureBot({ pacing: { heartbeatIntervalMinutes: Number(e.target.value) } })}
                  style={{ padding: "4px 8px", borderRadius: 8, border: "1px solid var(--qj-border-default)", background: "var(--muse-soft-fill)", color: "var(--qj-text-primary)", fontSize: 12 }}
                >
                  <option value="5">每 5 分钟</option>
                  <option value="15">每 15 分钟</option>
                  <option value="30">每 30 分钟</option>
                  <option value="60">每 60 分钟</option>
                </select>
              </label>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Switch
                  checked={pacing.quietHoursEnabled}
                  aria-label="开启免打扰时段"
                  onCheckedChange={(checked) => void ctrl.configureBot({ pacing: { quietHoursEnabled: checked } })}
                />
                <span>夜间/免打扰</span>
                <input
                  type="time"
                  aria-label="免打扰开始时间"
                  value={pacing.quietHoursStart}
                  onChange={(e) => void ctrl.configureBot({ pacing: { quietHoursStart: e.target.value } })}
                  style={{ border: "1px solid var(--qj-border-default)", borderRadius: 8, padding: "3px 6px", background: "var(--muse-soft-fill)", color: "var(--qj-text-primary)", fontSize: 12 }}
                />
                <span>–</span>
                <input
                  type="time"
                  aria-label="免打扰结束时间"
                  value={pacing.quietHoursEnd}
                  onChange={(e) => void ctrl.configureBot({ pacing: { quietHoursEnd: e.target.value } })}
                  style={{ border: "1px solid var(--qj-border-default)", borderRadius: 8, padding: "3px 6px", background: "var(--muse-soft-fill)", color: "var(--qj-text-primary)", fontSize: 12 }}
                />
              </label>
            </div>
          </div>

          <div
            style={{
              padding: "14px 0",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div>
              <div style={{ fontSize: 14, fontWeight: 520 }}>分身名称</div>
              <div style={{ fontSize: 12, color: "var(--qj-text-secondary)", marginTop: 2 }}>
                显示在右侧陪伴栏、主聊天欢迎语与全局搜索中
              </div>
            </div>
            <input
              type="text"
              aria-label="分身名称"
              value={snapshot.profile.displayName}
              onChange={(e) => void ctrl.updateProfile({ displayName: e.target.value })}
              style={{
                width: 168,
                padding: "7px 12px",
                borderRadius: 12,
                border: "1px solid var(--qj-border-default)",
                background: "var(--muse-soft-fill)",
                color: "var(--qj-text-primary)",
                fontSize: 13,
                outline: "none",
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  if (ui.settingsTab === "connectors") {
    return <BotConnectorsConsole ctx={ctx} />;
  }

  if (ui.settingsTab === "voice") {
    const presets: ReadonlyArray<keyof typeof AVATAR_PRESET_LABELS> = [
      "alabaster-felt",
      "warm-felt",
      "plush-ears",
    ];
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>声音和虚拟形象</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, fontSize: 12 }}>
          {presets.map((presetId) => {
            const active = snapshot.profile.avatarPreset === presetId;
            return (
              <button
                key={presetId}
                type="button"
                onClick={() => void ctrl.updateProfile({ avatarPreset: presetId })}
                style={{
                  border: 0,
                  padding: 14,
                  borderRadius: 18,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 8,
                  cursor: "pointer",
                  background: "var(--muse-soft-fill)",
                  color: "var(--qj-text-primary)",
                  outline: active ? "2px solid var(--qj-text-primary)" : "none",
                }}
              >
                <img
                  src={FELT_AVATAR_URIS[presetId]}
                  alt={AVATAR_PRESET_LABELS[presetId]}
                  style={{ width: 64, height: 64, borderRadius: 9999, objectFit: "cover" }}
                />
                <span style={{ fontWeight: 520 }}>{AVATAR_PRESET_LABELS[presetId]}</span>
              </button>
            );
          })}
        </div>

        <div
          style={{
            padding: 14,
            borderRadius: 16,
            background: "var(--muse-soft-fill)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 520 }}>自定义形象图片</div>
            <div style={{ fontSize: 12, color: "var(--qj-text-secondary)", marginTop: 2 }}>
              支持上传 PNG / JPG / WebP 作为你的专属数字分身头像
            </div>
          </div>
          <input
            ref={avatarFileRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={handleAvatarUpload}
          />
          <button
            type="button"
            onClick={() => avatarFileRef.current?.click()}
            style={{
              height: 32,
              padding: "0 14px",
              borderRadius: 9999,
              border: 0,
              background: "var(--qj-bg-surface)",
              color: "var(--qj-text-primary)",
              fontSize: 12,
              fontWeight: 520,
              cursor: "pointer",
            }}
          >
            上传图片
          </button>
        </div>
      </div>
    );
  }

  return <BotSettingsSecondaryPane ctx={ctx} onClose={onClose} />;
}
