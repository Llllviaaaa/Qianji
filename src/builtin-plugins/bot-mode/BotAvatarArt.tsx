/**
 * Self-contained 3D felt companion artwork & brand orb for Qianji Bot Mode.
 * Harmonized with neutral alabaster / warm stone / obsidian dark palettes.
 */
import type { ReactElement } from "react";
import type { BotAvatarPresetId } from "@qianji/protocol";

export function BotBrandOrbIcon({ size = 22 }: { readonly size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <defs>
        <radialGradient id="qjBotOrbGrad" cx="35%" cy="28%" r="70%">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.95" />
          <stop offset="65%" stopColor="currentColor" stopOpacity="0.55" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.18" />
        </radialGradient>
      </defs>
      <circle cx="14" cy="14" r="10.5" stroke="url(#qjBotOrbGrad)" strokeWidth="2.4" />
      <circle cx="14" cy="14" r="4.2" fill="currentColor" fillOpacity="0.82" />
    </svg>
  );
}

export function BotCompanionAvatar({
  preset,
  customDataUrl,
  size = 86,
}: {
  readonly preset: BotAvatarPresetId;
  readonly customDataUrl?: string;
  readonly size?: number;
}): ReactElement {
  if (preset === "custom" && customDataUrl) {
    return (
      <img
        src={customDataUrl}
        alt="Bot 形象"
        width={size}
        height={size}
        style={{ width: size, height: size, borderRadius: "26px", objectFit: "cover" }}
      />
    );
  }

  const palette =
    preset === "warm-felt"
      ? { bodyTop: "#F5ECE2", bodyBottom: "#DECBB8", cheek: "#E5A898", accent: "#8C6F5A", eye: "#2B2420" }
      : preset === "plush-ears"
        ? { bodyTop: "#ECEEF5", bodyBottom: "#CBD1E2", cheek: "#D9A7B8", accent: "#6F7896", eye: "#232633" }
        : { bodyTop: "#F6F6F4", bodyBottom: "#DCDCD7", cheek: "#E2B2A6", accent: "#8E8E88", eye: "#242423" };

  return (
    <svg width={size} height={size} viewBox="0 0 112 112" fill="none" aria-hidden="true">
      <defs>
        <radialGradient id={`qjFeltBody-${preset}`} cx="36%" cy="28%" r="72%">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="48%" stopColor={palette.bodyTop} />
          <stop offset="100%" stopColor={palette.bodyBottom} />
        </radialGradient>
        <filter id={`qjFeltShadow-${preset}`} x="-12%" y="-10%" width="124%" height="128%">
          <feDropShadow dx="0" dy="6" stdDeviation="6" floodColor="#000000" floodOpacity="0.12" />
        </filter>
      </defs>

      <g filter={`url(#qjFeltShadow-${preset})`}>
        {preset === "plush-ears" ? (
          <>
            <ellipse cx="36" cy="27" rx="10" ry="18" transform="rotate(-14 36 27)" fill={`url(#qjFeltBody-${preset})`} />
            <ellipse cx="76" cy="27" rx="10" ry="18" transform="rotate(14 76 27)" fill={`url(#qjFeltBody-${preset})`} />
          </>
        ) : (
          <>
            <circle cx="33" cy="34" r="11" fill={`url(#qjFeltBody-${preset})`} />
            <circle cx="79" cy="34" r="11" fill={`url(#qjFeltBody-${preset})`} />
          </>
        )}

        <rect x="22" y="28" width="68" height="62" rx="31" fill={`url(#qjFeltBody-${preset})`} />

        {/* Soft felt highlight */}
        <ellipse cx="46" cy="40" rx="18" ry="8" fill="#FFFFFF" fillOpacity="0.55" />

        {/* Calm expressive eyes */}
        <rect x="41" y="53" width="6.5" height="9.5" rx="3.25" fill={palette.eye} />
        <rect x="64.5" y="53" width="6.5" height="9.5" rx="3.25" fill={palette.eye} />
        <circle cx="43" cy="55.5" r="1.4" fill="#FFFFFF" />
        <circle cx="66.5" cy="55.5" r="1.4" fill="#FFFFFF" />

        {/* Subtle warm blush & gentle smile */}
        <ellipse cx="35.5" cy="64.5" rx="5.2" ry="3.1" fill={palette.cheek} fillOpacity="0.55" />
        <ellipse cx="76.5" cy="64.5" rx="5.2" ry="3.1" fill={palette.cheek} fillOpacity="0.55" />
        <path
          d="M51.5 65.5C53.2 67.6 58.8 67.6 60.5 65.5"
          stroke={palette.accent}
          strokeWidth="2.1"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}
