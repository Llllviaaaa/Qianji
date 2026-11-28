/**
 * 4K Live2D Character Gallery, `.zip` / `.model3.json` Drag-and-Drop Importer,
 * PNG/WebP Fallback, and Exhibition Launcher for Bot Settings (`settingsTab === "voice"`).
 */
import { useRef, useState, type ChangeEvent, type DragEvent, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { FolderArchive, Image as ImageIcon, RotateCcw } from "lucide-react";
import type { BotAvatarPresetId } from "@qianji/protocol";
import { AVATAR_PRESET_LABELS } from "../BotAvatarArt";
import { useBotController, useBotSnapshot } from "../botStore";
import {
  clearCustomLive2DPackage,
  importCustomLive2DPackage,
  setLive2DBackdropTheme,
  useLive2DDirectorState,
} from "./live2dDirectorStore";
import { Live2DViewport } from "./Live2DViewport";
import { LIVE2D_PRESET_IDS, LIVE2D_PRESETS } from "./types";

export function Live2DVoiceSettingsSection({
  ctx,
}: {
  readonly ctx?: Context;
}): ReactElement {
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const director = useLive2DDirectorState();
  const zipFileRef = useRef<HTMLInputElement | null>(null);
  const avatarImageRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const applyModelOrImageFile = async (file: File) => {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".zip") || lower.endsWith(".model3.json") || lower.endsWith(".json")) {
      const loadedId = await importCustomLive2DPackage(file);
      if (loadedId !== null) {
        void ctrl.updateProfile({ avatarPreset: "custom" });
      }
      return;
    }
    if (file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          clearCustomLive2DPackage();
          void ctrl.updateProfile({ avatarPreset: "custom", customAvatarDataUrl: reader.result });
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const handleZipInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void applyModelOrImageFile(file);
  };

  const handleImageInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void applyModelOrImageFile(file);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void applyModelOrImageFile(file);
  };

  const selectPreset = (presetId: Exclude<BotAvatarPresetId, "custom">) => {
    clearCustomLive2DPackage();
    setLive2DBackdropTheme(LIVE2D_PRESETS[presetId].defaultBackdrop);
    void ctrl.updateProfile({ avatarPreset: presetId });
  };

  return (
    <div className="qj-bset-stack">
      <div className="qj-settings-char-grid">
        {LIVE2D_PRESET_IDS.map((presetId) => {
          const meta = LIVE2D_PRESETS[presetId];
          const active =
            snapshot.profile.avatarPreset === presetId && director.customModelSource === null;
          return (
            <button
              key={presetId}
              type="button"
              className={`qj-settings-char-card${active ? " active" : ""}`}
              onClick={() => selectPreset(presetId)}
            >
              <div
                className="qj-settings-bust-frame"
                style={{ ["--portal-accent" as string]: meta.accentHex }}
              >
                <Live2DViewport
                  preset={presetId}
                  expression="calm"
                  action="idle"
                  stageVariant="card-preview"
                  framingMode="half-body"
                  width={154}
                  height={148}
                  backdropTheme={meta.defaultBackdrop}
                  interactive={false}
                />
              </div>
              <div className="qj-settings-char-meta">
                <span className="qj-settings-char-label">{AVATAR_PRESET_LABELS[presetId]}</span>
                <span className="qj-settings-char-sub">{meta.subtitleZh}</span>
              </div>
            </button>
          );
        })}
      </div>

      <div
        className={`qj-settings-upload-dropzone${dragActive ? " drag-active" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          if (!dragActive) setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
      >
        <div className="qj-settings-upload-copy">
          <div className="qj-settings-upload-title">自定义 Live2D 模型包或平面头像</div>
          <div className="qj-settings-upload-desc">
            {director.customModelFileName
              ? `已加载模型包：${director.customModelFileName}`
              : "支持拖入包含 .model3.json 的 .zip 模型包，或上传 PNG / WebP 头像图片"}
          </div>
          {director.importError !== null && (
            <div style={{ marginTop: 4, fontSize: 11.5, color: "var(--qj-status-danger)" }}>
              {director.importError}
            </div>
          )}
        </div>

        <input
          ref={zipFileRef}
          type="file"
          accept=".zip,.model3.json,application/zip"
          style={{ display: "none" }}
          onChange={handleZipInput}
        />
        <input
          ref={avatarImageRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={handleImageInput}
        />

        <div className="qj-settings-upload-actions">
          <button
            type="button"
            className="qj-primary-pill-btn qj-settings-upload-pill"
            onClick={() => zipFileRef.current?.click()}
          >
            <FolderArchive size={13} />
            <span>导入 .zip 模型包</span>
          </button>
          <button
            type="button"
            className="qj-soft-btn qj-settings-upload-pill"
            onClick={() => avatarImageRef.current?.click()}
          >
            <ImageIcon size={13} />
            <span>上传图片</span>
          </button>
          {(snapshot.profile.avatarPreset === "custom" || director.customModelFileName !== null) && (
            <button
              type="button"
              className="qj-soft-btn qj-settings-upload-pill"
              title="恢复默认角色"
              aria-label="恢复默认角色"
              onClick={() => selectPreset("alabaster-felt")}
            >
              <RotateCcw size={12.5} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
