/**
 * 4K Live2D Character Labels (`云白·虹彩绘师` / `暖珀·晴空学妹` / `星黛·秘境司书`),
 * Companion Crest Avatar Badges (`BotCompanionAvatar`), Qianji gradient brand mark,
 * and precision stroke icon set.
 */
import type { ReactElement } from "react";
import type { BotAvatarPresetId } from "@qianji/protocol";
import { FELT_AVATAR_URIS, QIANJI_BRAND_FAVICON_URI } from "./botAvatarAssets";
import type { BotExpressionId } from "./botUiAtoms";
import { resolveLive2DPresetMeta } from "./live2d/types";

export { FELT_AVATAR_URIS, QIANJI_BRAND_FAVICON_URI };

export const AVATAR_PRESET_LABELS: Readonly<Record<Exclude<BotAvatarPresetId, "custom">, string>> = {
  "alabaster-felt": "云白·虹彩绘师",
  "warm-felt": "暖珀·晴空学妹",
  "plush-ears": "星黛·秘境司书",
};

export function resolvePlushPrefix(preset: BotAvatarPresetId): "alabaster" | "warm" | "plush" {
  if (preset === "warm-felt") return "warm";
  if (preset === "plush-ears") return "plush";
  return "alabaster";
}

export function resolveAvatarUri(preset: BotAvatarPresetId, customDataUrl?: string): string {
  if (preset === "custom" && customDataUrl) return customDataUrl;
  return `/bot-plush/${resolvePlushPrefix(preset)}-head.webp`;
}

export function BotBrandOrbIcon({ size = 20 }: { readonly size?: number }): ReactElement {
  return (
    <img
      src={QIANJI_BRAND_FAVICON_URI}
      alt="千机"
      width={size}
      height={size}
      style={{ width: size, height: size, flexShrink: 0 }}
    />
  );
}

export function BotCompanionAvatar({
  preset,
  customDataUrl,
  size = 124,
  shape = "squircle",
  expression = "calm",
}: {
  readonly preset: BotAvatarPresetId;
  readonly customDataUrl?: string;
  readonly size?: number;
  readonly shape?: "squircle" | "circle";
  readonly expression?: BotExpressionId;
}): ReactElement {
  const borderRadius = shape === "circle" ? "9999px" : `${Math.max(8, Math.round(size * 0.24))}px`;
  const isCustomImage =
    preset === "custom" &&
    typeof customDataUrl === "string" &&
    customDataUrl.startsWith("data:image/");
  const meta = resolveLive2DPresetMeta(preset);

  return (
    <div
      data-expression={expression}
      style={{
        position: "relative",
        width: size,
        height: size,
        borderRadius,
        overflow: "hidden",
        background: `radial-gradient(circle at 50% 28%, ${meta.accentHex}38 0%, var(--qj-bg-subtle) 80%)`,
        border: "1px solid var(--qj-border-default)",
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {isCustomImage ? (
        <img
          src={customDataUrl}
          alt="千机"
          width={size}
          height={size}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      ) : (
        <svg
          width={Math.round(size * 0.86)}
          height={Math.round(size * 0.86)}
          viewBox="0 0 40 40"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="20" cy="14.5" r="7.2" fill="#f8fafc" />
          <path
            d="M12.6 13.8c0-4.6 3.3-7.8 7.4-7.8s7.4 3.2 7.4 7.8c-1.8-1.9-4.3-2.9-7.4-2.9s-5.6 1-7.4 2.9Z"
            fill={meta.accentHex}
          />
          <path
            d="M8.5 34.5c1.6-6.5 5.8-10.2 11.5-10.2s9.9 3.7 11.5 10.2"
            fill={meta.accentHex}
            fillOpacity="0.88"
          />
          <circle cx="30.5" cy="10" r="2.2" fill={meta.glowHex} />
        </svg>
      )}
      {expression === "focused" && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            right: 2,
            bottom: 2,
            width: Math.max(6, Math.round(size * 0.24)),
            height: Math.max(6, Math.round(size * 0.24)),
            borderRadius: "9999px",
            background: "var(--qj-brand-primary)",
            border: "1.5px solid var(--bot-sheet-bg, #fff)",
          }}
        />
      )}
    </div>
  );
}

export type BotIconName =
  | "chat"
  | "search"
  | "feed"
  | "ideas"
  | "goals"
  | "library"
  | "spaces"
  | "more"
  | "menu"
  | "panelRight"
  | "phone"
  | "smile"
  | "reply"
  | "dots"
  | "closeX"
  | "pencil"
  | "tabActivity"
  | "tabShield"
  | "tabIdentity"
  | "tabMail"
  | "checkCircle"
  | "chevronDown";

export function BotIcon({ name }: { readonly name: BotIconName }): ReactElement {
  switch (name) {
    case "chat":
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
        </svg>
      );
    case "search":
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
          <circle cx="11" cy="11" r="7.5" />
          <path d="m20 20-3.8-3.8" />
        </svg>
      );
    case "feed":
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="3" width="16" height="18" rx="3" />
          <path d="M8 8h8M8 12h8M8 16h5" />
        </svg>
      );
    case "ideas":
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
          <path d="M9 18h6M10 22h4" />
        </svg>
      );
    case "goals":
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
          <path d="m8.5 12.2 2.4 2.4 4.8-5" />
        </svg>
      );
    case "library":
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
          <rect x="13.5" y="3" width="7.5" height="7.5" rx="2" />
          <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
          <circle cx="17.25" cy="17.25" r="3.75" />
        </svg>
      );
    case "spaces":
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
          <path d="M12 8v8M8 12h8" />
        </svg>
      );
    case "more":
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M4 9h16M4 15h16" />
        </svg>
      );
    case "menu":
      return (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      );
    case "panelRight":
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2.5" />
          <path d="M15 4v16" />
        </svg>
      );
    case "phone":
      return (
        <svg width="14.5" height="14.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.58 2.81.7A2 2 0 0 1 22 16.92z" />
        </svg>
      );
    case "smile":
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
          <circle cx="12" cy="12" r="9.5" />
          <path d="M8.5 14.5s1.3 1.8 3.5 1.8 3.5-1.8 3.5-1.8" />
          <circle cx="9" cy="9.8" r="1" fill="currentColor" />
          <circle cx="15" cy="9.8" r="1" fill="currentColor" />
        </svg>
      );
    case "reply":
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 14 4 9 9 4" />
          <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
        </svg>
      );
    case "dots":
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="19" cy="12" r="1.7" />
        </svg>
      );
    case "closeX":
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      );
    case "pencil":
      return (
        <svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
        </svg>
      );
    case "tabActivity":
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round">
          <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
        </svg>
      );
    case "tabShield":
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case "tabIdentity":
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" />
          <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
          <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
          <path d="M2 12a10 10 0 0 1 18-6" />
          <path d="M2 16h.01" />
          <path d="M21.8 16c.2-2 .131-5.354 0-6" />
          <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" />
          <path d="M8.65 22c.21-.66.45-1.32.57-2" />
          <path d="M9 6.8a6 6 0 0 1 9 5.2v2" />
        </svg>
      );
    case "tabMail":
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect width="20" height="16" x="2" y="4" rx="2.5" />
          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
        </svg>
      );
    case "checkCircle":
      return (
        <svg width="16.5" height="16.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="m8.8 12.2 2.2 2.2 4.4-4.6" />
        </svg>
      );
    case "chevronDown":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      );
  }
}

export function CalendarTaskTileIcon(): ReactElement {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" style={{ flexShrink: 0, borderRadius: 11 }}>
      <rect width="40" height="40" rx="11" fill="rgba(255,255,255,0.78)" />
      <g fill="#9ca3af">
        <circle cx="12" cy="12.5" r="1.4" />
        <circle cx="17" cy="12.5" r="1.4" />
        <circle cx="22" cy="12.5" r="1.4" />
        <circle cx="27" cy="12.5" r="1.4" />
        <circle cx="12" cy="18" r="1.4" />
        <circle cx="17" cy="18" r="1.4" />
        <circle cx="22" cy="18" r="1.4" />
        <circle cx="27" cy="18" r="1.4" />
        <circle cx="12" cy="23.5" r="1.4" />
        <circle cx="17" cy="23.5" r="1.4" />
        <circle cx="22" cy="23.5" r="1.4" />
      </g>
      <circle cx="28" cy="27.5" r="6" fill="#006ee4" />
      <path d="M28 24.6v3.1l1.9 1.2" fill="none" stroke="#ffffff" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
