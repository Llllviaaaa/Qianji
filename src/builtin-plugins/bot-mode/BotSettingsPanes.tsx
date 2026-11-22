/**
 * Primary content panes (`general` | `server` | `connectors` | `voice`) +
 * delegation to `BotSettingsSecondaryPane` for the 9-tab Bot Settings modal.
 */
import { useRef, type ChangeEvent, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { useFrontendService, useThemeState } from "@qianji/client";
import { AVATAR_PRESET_LABELS, FELT_AVATAR_URIS } from "./BotAvatarArt";
import { BotSettingsSecondaryPane } from "./BotSettingsSecondaryPanes";
import { VirtualServerConsole } from "./BotVirtualServerConsole";
import { useBotController, useBotSnapshot, useBotUiState } from "./botStore";

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
  const avatarFileRef = useRef<HTMLInputElement | null>(null);

  const isLight = (themeSnap?.resolvedScheme ?? "light") === "light";

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
                保持 Heartbeat 后台静默巡检不中断
              </div>
            </div>
            <span
              style={{
                padding: "4px 12px",
                borderRadius: 9999,
                fontSize: 12,
                fontWeight: 520,
                background: "var(--muse-primary-bg)",
                color: "var(--muse-primary-fg)",
              }}
            >
              已开启
            </span>
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
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>连接器</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {snapshot.connectors.map((c) => (
            <div
              key={c.id}
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
                <div style={{ fontSize: 14, fontWeight: 520 }}>{c.name}</div>
                <div style={{ fontSize: 12, color: "var(--qj-text-secondary)", marginTop: 2 }}>{c.description}</div>
              </div>
              <button
                type="button"
                onClick={() => void ctrl.toggleConnector(c.id)}
                style={{
                  height: 32,
                  padding: "0 16px",
                  borderRadius: 9999,
                  border: 0,
                  fontSize: 12,
                  fontWeight: 520,
                  cursor: "pointer",
                  background: c.enabled ? "var(--muse-primary-bg)" : "var(--qj-bg-surface)",
                  color: c.enabled ? "var(--muse-primary-fg)" : "var(--qj-text-primary)",
                }}
              >
                {c.enabled ? "已连接" : "连接"}
              </button>
            </div>
          ))}
        </div>
      </div>
    );
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
