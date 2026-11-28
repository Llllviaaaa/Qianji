/**
 * Live2D Cubism 4 Motion & Expression Introspection Catalog (`live2dCatalog.ts`).
 *
 * Introspects both `Live2DModel.internalModel.settings` and raw `.model3.json`
 * `FileReferences`, mapping official 4K characters (`Mao`, `Hiyori`, `Rice`) and
 * user-imported `.zip` packages into natural Chinese labels, curated showcase
 * choreography (`DEMO_SHOWCASE_STEPS`), and Bot presence resolution.
 */
import type { BotActionId, BotExpressionId } from "../botUiAtoms";
import type {
  Live2DExpressionItem,
  Live2DHitZone,
  Live2DMotionItem,
  Live2DPresetMeta,
} from "./types";

export type Live2DCharacterKey = Live2DPresetMeta["characterId"];
export type Live2DExpressionHint =
  | "calm"
  | "smile"
  | "sparkle"
  | "shy"
  | "wink"
  | "surprised"
  | "focused"
  | "sleepy";

export interface Live2DCatalogBundle {
  readonly motions: readonly Live2DMotionItem[];
  readonly expressions: readonly Live2DExpressionItem[];
}

export interface DemoShowcaseStep {
  readonly id: string;
  readonly holdSec: number;
  readonly captionZh: string;
  readonly expressionHint: Live2DExpressionHint;
  readonly motionCategory: Live2DMotionItem["category"];
}

export interface ResolvedLive2DPresence {
  readonly expressionHint: Live2DExpressionHint;
  readonly motionCategory: Live2DMotionItem["category"];
  readonly shouldTriggerMotion: boolean;
  readonly expressionItem: Live2DExpressionItem | null;
  readonly motionItem: Live2DMotionItem | null;
}

interface CuratedMotionMeta {
  readonly labelZh: string;
  readonly category: Live2DMotionItem["category"];
}

const MAO_MOTIONS: Readonly<Record<string, CuratedMotionMeta>> = {
  mtn_01: { labelZh: "待机呼吸", category: "idle" },
  sample_01: { labelZh: "绘师随想", category: "idle" },
  mtn_02: { labelZh: "开心招手", category: "greeting" },
  mtn_03: { labelZh: "歪头倾听", category: "emotion" },
  mtn_04: { labelZh: "元气雀跃", category: "greeting" },
  special_01: { labelZh: "虹光挥杖", category: "special" },
  special_02: { labelZh: "魔法星心", category: "special" },
  special_03: { labelZh: "极光幻舞", category: "special" },
};

const HIYORI_MOTIONS: Readonly<Record<string, CuratedMotionMeta>> = {
  hiyori_m01: { labelZh: "温柔守候", category: "idle" },
  hiyori_m02: { labelZh: "微风轻晃", category: "idle" },
  hiyori_m03: { labelZh: "点头倾听", category: "greeting" },
  hiyori_m04: { labelZh: "开心招手", category: "touch" },
  hiyori_m05: { labelZh: "害羞歪头", category: "emotion" },
  hiyori_m06: { labelZh: "欣喜展颜", category: "greeting" },
  hiyori_m07: { labelZh: "思索微倾", category: "emotion" },
  hiyori_m08: { labelZh: "晴空舒展", category: "special" },
  hiyori_m09: { labelZh: "静谧轻息", category: "idle" },
  hiyori_m10: { labelZh: "元气绽放", category: "special" },
};

const RICE_MOTIONS: Readonly<Record<string, CuratedMotionMeta>> = {
  idle: { labelZh: "秘境悬浮", category: "idle" },
  mtn_01: { labelZh: "奥术凝视", category: "greeting" },
  mtn_02: { labelZh: "魔导展开", category: "special" },
  mtn_03: { labelZh: "星辉咏唱", category: "special" },
};

const CHARACTER_MOTION_MAPS: Readonly<Record<Live2DCharacterKey, Readonly<Record<string, CuratedMotionMeta>>>> = {
  mao: MAO_MOTIONS,
  hiyori: HIYORI_MOTIONS,
  rice: RICE_MOTIONS,
};

const CHARACTER_EXPRESSION_LABELS: Readonly<Record<Live2DCharacterKey, Readonly<Record<string, string>>>> = {
  mao: {
    exp_01: "平静凝视",
    exp_02: "笑眼弯弯",
    exp_03: "静心微阖",
    exp_04: "星眸闪耀",
    exp_05: "委屈轻叹",
    exp_06: "害羞脸红",
    exp_07: "惊讶睁眼",
    exp_08: "嘟嘴鼓气",
  },
  hiyori: {
    exp_smile: "晴空微笑",
    exp_wink: "眨眼微笑",
    exp_shy: "害羞脸红",
    exp_surprised: "惊讶睁眼",
    exp_focused: "专注凝神",
    exp_sleepy: "困倦微醺",
  },
  rice: {
    exp_calm: "静谧司书",
    exp_arcane_circle: "星环法阵",
    exp_mystic_flame: "秘焰流光",
    exp_grand_sigil: "天穹圣印",
    exp_wink: "星眸微眨",
    exp_meditate: "冥想闭目",
  },
};

const CN_NUMERALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"] as const;

export const DEMO_SHOWCASE_STEPS: readonly DemoShowcaseStep[] = [
  {
    id: "step-greeting",
    holdSec: 3.8,
    captionZh: "温柔致意 · 目光相迎与灵动挥手",
    expressionHint: "smile",
    motionCategory: "greeting",
  },
  {
    id: "step-special",
    holdSec: 4.4,
    captionZh: "招牌演绎 · 4K 原画灵动高光时刻",
    expressionHint: "sparkle",
    motionCategory: "special",
  },
  {
    id: "step-shy",
    holdSec: 3.6,
    captionZh: "心动微嗔 · 柔和景深视差凝视",
    expressionHint: "shy",
    motionCategory: "emotion",
  },
  {
    id: "step-wink",
    holdSec: 3.6,
    captionZh: "俏皮眨眼 · 丝滑物理发丝摆动",
    expressionHint: "wink",
    motionCategory: "touch",
  },
  {
    id: "step-calm",
    holdSec: 4.0,
    captionZh: "温柔守候 · 静谧呼吸相伴左右",
    expressionHint: "calm",
    motionCategory: "idle",
  },
];

function extractStem(pathOrName: string): string {
  const clean = pathOrName.replace(/\\/g, "/").split("?")[0] ?? pathOrName;
  const file = clean.split("/").pop() ?? clean;
  return file
    .replace(/\.(?:motion3|exp3|model3)\.json$/i, "")
    .replace(/\.json$/i, "")
    .trim();
}

function toCnOrdinal(zeroBasedIndex: number): string {
  return CN_NUMERALS[zeroBasedIndex] ?? `${zeroBasedIndex + 1}`;
}

function inferCharacterId(
  explicit: Live2DCharacterKey | null | undefined,
  rawModelJson?: Record<string, unknown> | null,
): Live2DCharacterKey | null {
  if (explicit === "mao" || explicit === "hiyori" || explicit === "rice") return explicit;
  const moc = typeof (rawModelJson?.FileReferences as Record<string, unknown> | undefined)?.Moc === "string"
    ? String((rawModelJson?.FileReferences as Record<string, unknown>).Moc).toLowerCase()
    : "";
  if (moc.includes("mao")) return "mao";
  if (moc.includes("hiyori")) return "hiyori";
  if (moc.includes("rice")) return "rice";
  return null;
}

function inferFallbackMotionMeta(
  group: string,
  stem: string,
  indexInGroup: number,
): CuratedMotionMeta {
  const lower = `${group} ${stem}`.toLowerCase();
  const ord = toCnOrdinal(indexInGroup);
  if (lower.includes("special") || lower.includes("magic") || lower.includes("skill")) {
    return { labelZh: `招牌演绎·${ord}`, category: "special" };
  }
  if (lower.includes("wave") || lower.includes("greet") || lower.includes("hello") || lower.includes("nod")) {
    return { labelZh: `问候致意·${ord}`, category: "greeting" };
  }
  if (lower.includes("shy") || lower.includes("angry") || lower.includes("sad") || lower.includes("happy") || lower.includes("smile")) {
    return { labelZh: `情绪流露·${ord}`, category: "emotion" };
  }
  if (group.toLowerCase().includes("idle") || stem.toLowerCase().startsWith("idle")) {
    return { labelZh: indexInGroup === 0 ? "待机呼吸" : `轻柔待机·${ord}`, category: "idle" };
  }
  if (group.toLowerCase().includes("tap") || group.toLowerCase().includes("touch") || group.toLowerCase().includes("flick")) {
    return { labelZh: `触碰互动·${ord}`, category: "touch" };
  }
  return { labelZh: `灵动动作·${ord}`, category: "greeting" };
}

function inferFallbackExpressionLabel(nameOrStem: string, index: number): string {
  const lower = nameOrStem.toLowerCase();
  if (lower.includes("smile") || lower.includes("happy") || lower.includes("joy")) return "温柔微笑";
  if (lower.includes("wink")) return "俏皮眨眼";
  if (lower.includes("shy") || lower.includes("blush")) return "害羞脸红";
  if (lower.includes("surpris") || lower.includes("shock")) return "惊讶睁眼";
  if (lower.includes("angry") || lower.includes("pout")) return "嘟嘴微嗔";
  if (lower.includes("sad") || lower.includes("cry")) return "委屈轻叹";
  if (lower.includes("sleep") || lower.includes("close") || lower.includes("meditat")) return "静心微阖";
  if (lower.includes("focus") || lower.includes("serious")) return "专注凝神";
  if (lower.includes("calm") || lower.includes("normal") || lower.includes("default")) return "平静凝视";
  if (lower.includes("star") || lower.includes("sparkl") || lower.includes("arcane") || lower.includes("magic")) return "星辉流光";
  return `神态表情·${toCnOrdinal(index)}`;
}

function readMotionMapFromSettingsOrJson(
  settings: unknown,
  rawModelJson?: Record<string, unknown> | null,
): Record<string, ReadonlyArray<{ readonly file?: string }>> {
  const result: Record<string, Array<{ readonly file?: string }>> = {};
  const rawRefs = rawModelJson?.FileReferences as Record<string, unknown> | undefined;
  const rawMotions = rawRefs?.Motions;
  const settingsMotions = (settings as { motions?: unknown } | null | undefined)?.motions;
  const source =
    typeof rawMotions === "object" && rawMotions !== null
      ? (rawMotions as Record<string, unknown>)
      : typeof settingsMotions === "object" && settingsMotions !== null
        ? (settingsMotions as Record<string, unknown>)
        : {};

  for (const [groupName, arr] of Object.entries(source)) {
    if (!Array.isArray(arr)) continue;
    result[groupName] = arr.map((item) => {
      if (typeof item !== "object" || item === null) return {};
      const rec = item as Record<string, unknown>;
      const fileVal = typeof rec.File === "string" ? rec.File : typeof rec.file === "string" ? rec.file : undefined;
      return fileVal !== undefined ? { file: fileVal } : {};
    });
  }
  return result;
}

function readExpressionsFromSettingsOrJson(
  settings: unknown,
  rawModelJson?: Record<string, unknown> | null,
): ReadonlyArray<{ readonly name: string; readonly file?: string }> {
  const rawRefs = rawModelJson?.FileReferences as Record<string, unknown> | undefined;
  const rawExps = rawRefs?.Expressions;
  const settingsExps = (settings as { expressions?: unknown } | null | undefined)?.expressions;
  const arr = Array.isArray(rawExps) ? rawExps : Array.isArray(settingsExps) ? settingsExps : [];

  return arr.map((item, idx) => {
    if (typeof item !== "object" || item === null) return { name: `exp_${idx + 1}` };
    const rec = item as Record<string, unknown>;
    const fileVal = typeof rec.File === "string" ? rec.File : typeof rec.file === "string" ? rec.file : undefined;
    const rawName = typeof rec.Name === "string" ? rec.Name : typeof rec.name === "string" ? rec.name : "";
    const resolvedName = rawName.trim().length > 0 ? rawName.trim() : fileVal !== undefined ? extractStem(fileVal) : `exp_${idx + 1}`;
    return fileVal !== undefined ? { name: resolvedName, file: fileVal } : { name: resolvedName };
  });
}

export function introspectLive2DCatalog(params: {
  readonly settings?: unknown;
  readonly rawModelJson?: Record<string, unknown> | null;
  readonly characterId?: Live2DCharacterKey | null;
  readonly isCustomPackage?: boolean;
}): Live2DCatalogBundle {
  const charKey = params.isCustomPackage === true ? null : inferCharacterId(params.characterId, params.rawModelJson);
  const motionDict = charKey !== null ? CHARACTER_MOTION_MAPS[charKey] : null;
  const expDict = charKey !== null ? CHARACTER_EXPRESSION_LABELS[charKey] : null;

  const rawGroups = readMotionMapFromSettingsOrJson(params.settings, params.rawModelJson);
  const motions: Live2DMotionItem[] = [];
  for (const [group, entries] of Object.entries(rawGroups)) {
    entries.forEach((entry, index) => {
      const stem = entry.file !== undefined ? extractStem(entry.file) : `${group}_${index}`;
      const curated = motionDict?.[stem] ?? motionDict?.[stem.toLowerCase()];
      const meta = curated ?? inferFallbackMotionMeta(group, stem, index);
      motions.push({
        id: `${group}:${index}`,
        group,
        index,
        ...(entry.file !== undefined ? { file: entry.file } : {}),
        labelZh: meta.labelZh,
        category: meta.category,
      });
    });
  }

  const rawExps = readExpressionsFromSettingsOrJson(params.settings, params.rawModelJson);
  const expressions: Live2DExpressionItem[] = rawExps.map((entry, index) => {
    const stem = entry.file !== undefined ? extractStem(entry.file) : entry.name;
    const labelZh =
      expDict?.[entry.name] ??
      expDict?.[stem] ??
      expDict?.[entry.name.toLowerCase()] ??
      inferFallbackExpressionLabel(entry.name || stem, index);
    return {
      id: `exp:${entry.name}`,
      name: entry.name,
      index,
      labelZh,
    };
  });

  return { motions, expressions };
}

const HINT_LABEL_KEYWORDS: Readonly<Record<Live2DExpressionHint, readonly string[]>> = {
  calm: ["平静", "静谧", "微笑", "晴空"],
  smile: ["笑眼", "微笑", "晴空", "星环", "静谧"],
  sparkle: ["星眸", "闪耀", "圣印", "秘焰", "眨眼", "微笑"],
  shy: ["害羞", "脸红", "微嗔", "嘟嘴", "星环"],
  wink: ["眨眼", "微眨", "笑眼", "星眸"],
  surprised: ["惊讶", "睁眼", "秘焰", "星眸"],
  focused: ["专注", "凝神", "星环", "平静"],
  sleepy: ["困倦", "微阖", "冥想", "闭目", "平静"],
};

export function pickExpressionByHint(
  expressions: readonly Live2DExpressionItem[],
  hint: Live2DExpressionHint,
): Live2DExpressionItem | null {
  if (expressions.length === 0) return null;
  const keywords = HINT_LABEL_KEYWORDS[hint];
  for (const kw of keywords) {
    const found = expressions.find((e) => e.labelZh.includes(kw));
    if (found !== undefined) return found;
  }
  return expressions[0] ?? null;
}

export function pickMotionByCategory(
  motions: readonly Live2DMotionItem[],
  category: Live2DMotionItem["category"],
  seed = 0,
): Live2DMotionItem | null {
  if (motions.length === 0) return null;
  const exact = motions.filter((m) => m.category === category);
  if (exact.length > 0) {
    return exact[Math.abs(seed) % exact.length] ?? exact[0] ?? null;
  }
  const nonIdle = category !== "idle" ? motions.filter((m) => m.category !== "idle") : motions;
  const pool = nonIdle.length > 0 ? nonIdle : motions;
  return pool[Math.abs(seed) % pool.length] ?? pool[0] ?? null;
}

export interface Live2DTaskStageBinding {
  readonly expressionId?: string | null;
  readonly motionId?: string | null;
}

export function resolveLive2DPresenceState(
  expression: BotExpressionId,
  action: BotActionId,
  catalog?: Live2DCatalogBundle,
  customBinding?: Live2DTaskStageBinding | null,
): ResolvedLive2DPresence {
  let expressionHint: Live2DExpressionHint = "calm";
  if (expression === "happy") expressionHint = "smile";
  else if (expression === "focused") expressionHint = "focused";
  else if (expression === "curious") expressionHint = "surprised";
  else if (expression === "patrol") expressionHint = "wink";
  else if (expression === "sleepy") expressionHint = "sleepy";

  let motionCategory: Live2DMotionItem["category"] = "idle";
  if (action === "wave" || action === "nod") motionCategory = "greeting";
  else if (action === "celebrate") {
    motionCategory = "special";
    expressionHint = "sparkle";
  } else if (action === "think" || action === "scan") {
    motionCategory = "emotion";
  }

  const boundExpression =
    catalog !== undefined && customBinding?.expressionId
      ? (catalog.expressions.find((e) => e.id === customBinding.expressionId) ?? null)
      : null;
  const boundMotion =
    catalog !== undefined && customBinding?.motionId
      ? (catalog.motions.find((m) => m.id === customBinding.motionId) ?? null)
      : null;

  return {
    expressionHint,
    motionCategory,
    shouldTriggerMotion: boundMotion !== null || action !== "idle",
    expressionItem:
      boundExpression ??
      (catalog !== undefined ? pickExpressionByHint(catalog.expressions, expressionHint) : null),
    motionItem:
      boundMotion ??
      (catalog !== undefined ? pickMotionByCategory(catalog.motions, motionCategory) : null),
  };
}

export function resolveTouchReactionTargets(
  zone: Live2DHitZone,
  comboCount: number,
  catalog: Live2DCatalogBundle,
): {
  readonly expressionItem: Live2DExpressionItem | null;
  readonly motionItem: Live2DMotionItem | null;
} {
  if (comboCount >= 3) {
    return {
      expressionItem: pickExpressionByHint(catalog.expressions, zone === "head" ? "sparkle" : "shy"),
      motionItem: pickMotionByCategory(catalog.motions, "special", comboCount),
    };
  }
  if (zone === "head") {
    return {
      expressionItem: pickExpressionByHint(catalog.expressions, "smile"),
      motionItem: pickMotionByCategory(catalog.motions, "greeting", comboCount),
    };
  }
  if (zone === "face") {
    return {
      expressionItem: pickExpressionByHint(catalog.expressions, comboCount === 2 ? "wink" : "shy"),
      motionItem: pickMotionByCategory(catalog.motions, "emotion", comboCount),
    };
  }
  if (zone === "accessory") {
    return {
      expressionItem: pickExpressionByHint(catalog.expressions, "sparkle"),
      motionItem: pickMotionByCategory(catalog.motions, "special", comboCount),
    };
  }
  return {
    expressionItem: pickExpressionByHint(catalog.expressions, "wink"),
    motionItem: pickMotionByCategory(catalog.motions, "touch", comboCount),
  };
}
