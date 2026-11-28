import type { BotAvatarPresetId } from "@qianji/protocol";

export type Live2DBackdropThemeId =
  | "atelier-aurora"
  | "sunlit-window"
  | "stardust-sanctuary"
  | "velvet-night";

export type Live2DFramingMode = "bust-breakout" | "half-body" | "full-art";

export type Live2DHitZone = "head" | "face" | "body" | "accessory";

export type HeadTrackingStatus = "off" | "requesting" | "active" | "fallback";

export interface Live2DMotionItem {
  readonly id: string;
  readonly group: string;
  readonly index: number;
  readonly file?: string;
  readonly labelZh: string;
  readonly category: "idle" | "greeting" | "emotion" | "special" | "touch";
}

export interface Live2DExpressionItem {
  readonly id: string;
  readonly name: string;
  readonly index: number;
  readonly labelZh: string;
}

export interface Live2DPresetMeta {
  readonly id: Exclude<BotAvatarPresetId, "custom">;
  readonly characterId: "mao" | "hiyori" | "rice";
  readonly nameZh: string;
  readonly subtitleZh: string;
  readonly modelJsonUrl: string;
  readonly accentHex: string;
  readonly glowHex: string;
  readonly defaultBackdrop: Live2DBackdropThemeId;
  readonly framing: {
    readonly bustScaleMultiplier: number;
    readonly bustAnchorY: number;
    readonly halfScaleMultiplier: number;
    readonly halfAnchorY: number;
    readonly fullScaleMultiplier: number;
    readonly fullAnchorY: number;
  };
}

export const LIVE2D_CORE_SCRIPT_URL = "/live2d/live2dcubismcore.min.js";

export const LIVE2D_PRESETS: Readonly<
  Record<Exclude<BotAvatarPresetId, "custom">, Live2DPresetMeta>
> = {
  "alabaster-felt": {
    id: "alabaster-felt",
    characterId: "mao",
    nameZh: "云白·虹彩绘师",
    subtitleZh: "极光魔导画师 · 虹彩星芒流光",
    modelJsonUrl: "/live2d/Mao/Mao.model3.json",
    accentHex: "#7c9cff",
    glowHex: "#c4b5fd",
    defaultBackdrop: "atelier-aurora",
    framing: {
      bustScaleMultiplier: 2.15,
      bustAnchorY: 0.34,
      halfScaleMultiplier: 1.52,
      halfAnchorY: 0.44,
      fullScaleMultiplier: 0.94,
      fullAnchorY: 0.5,
    },
  },
  "warm-felt": {
    id: "warm-felt",
    characterId: "hiyori",
    nameZh: "暖珀·晴空学妹",
    subtitleZh: "暖阳水手开衫 · 缎带微风守候",
    modelJsonUrl: "/live2d/Hiyori/Hiyori.model3.json",
    accentHex: "#f59e0b",
    glowHex: "#fde68a",
    defaultBackdrop: "sunlit-window",
    framing: {
      bustScaleMultiplier: 2.35,
      bustAnchorY: 0.28,
      halfScaleMultiplier: 1.62,
      halfAnchorY: 0.41,
      fullScaleMultiplier: 0.96,
      fullAnchorY: 0.5,
    },
  },
  "plush-ears": {
    id: "plush-ears",
    characterId: "rice",
    nameZh: "星黛·秘境司书",
    subtitleZh: "星辉奥术法球 · 秘境浮光司书",
    modelJsonUrl: "/live2d/Rice/Rice.model3.json",
    accentHex: "#a855f7",
    glowHex: "#67e8f9",
    defaultBackdrop: "stardust-sanctuary",
    framing: {
      bustScaleMultiplier: 2.05,
      bustAnchorY: 0.32,
      halfScaleMultiplier: 1.48,
      halfAnchorY: 0.43,
      fullScaleMultiplier: 0.94,
      fullAnchorY: 0.5,
    },
  },
};

export const LIVE2D_PRESET_IDS: readonly Exclude<BotAvatarPresetId, "custom">[] = [
  "alabaster-felt",
  "warm-felt",
  "plush-ears",
];

export function resolveLive2DPresetMeta(preset: BotAvatarPresetId): Live2DPresetMeta {
  if (preset === "custom") {
    return LIVE2D_PRESETS["alabaster-felt"];
  }
  return LIVE2D_PRESETS[preset];
}
