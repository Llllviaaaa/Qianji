import JSZip from "jszip";
import type { BotAvatarPresetId } from "@qianji/protocol";
import type {
  Cubism4InternalModel,
  Cubism4ModelSettings,
  Live2DModel as Live2DModelType,
} from "pixi-live2d-display-lipsyncpatch/cubism4";
import { ensurePixiCspRuntime, PIXI } from "./pixiCspRuntime";
import {
  LIVE2D_CORE_SCRIPT_URL,
  LIVE2D_PRESETS,
  resolveLive2DPresetMeta,
  type Live2DPresetMeta,
} from "./types";

export interface RegisteredZipPackageRecord {
  readonly customId: string;
  readonly fileName: string;
  readonly entryPath: string;
  readonly rawModelJson: Record<string, unknown>;
  readonly rewrittenModelJson: Record<string, unknown>;
  readonly blobUrlsByPath: ReadonlyMap<string, string>;
  readonly dispose: () => void;
}

export interface LoadLive2DModelParams {
  readonly preset: BotAvatarPresetId;
  readonly customModelSource?: string | null;
  readonly signal?: AbortSignal;
}

export interface LoadedLive2DInstance {
  readonly model: Live2DModelType<Cubism4InternalModel>;
  readonly rawModelJson: Record<string, unknown> | null;
  readonly modelUrl: string;
  readonly presetMeta: Live2DPresetMeta;
  readonly isCustomPackage: boolean;
  readonly dispose: () => void;
}

type Cubism4Module = typeof import("pixi-live2d-display-lipsyncpatch/cubism4");

const RASTER_IMAGE_URL_RE = /^data:image\/|\.(?:png|webp|jpe?g|gif|avif|svg|bmp)(?:[?#].*)?$/i;
const ZIP_PACKAGES = new Map<string, RegisteredZipPackageRecord>();
const MODEL_JSON_CACHE = new Map<string, Record<string, unknown>>();

let cubismCoreLoadPromise: Promise<boolean> | null = null;
let cubism4ModuleCache: Cubism4Module | null = null;
let tickerRegistered = false;
let zipPackageSeq = 0;

function createAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("Live2D model load aborted", "AbortError");
  }
  const err = new Error("Live2D model load aborted");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw createAbortError();
}

function inferMimeType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

function normalizePosixPath(rawPath: string): string {
  const parts = rawPath.replace(/\\/g, "/").split("/");
  const stack: string[] = [];
  for (const seg of parts) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      stack.pop();
    } else {
      stack.push(seg);
    }
  }
  return stack.join("/");
}

function resolveRelativeZipPath(baseDir: string, relFile: string): string {
  if (/^(?:blob:|data:|https?:|\/)/i.test(relFile)) return relFile;
  const combined = baseDir.length > 0 ? `${baseDir}/${relFile}` : relFile;
  return normalizePosixPath(combined);
}

function rewriteModel3FileReferences(
  rawJson: Record<string, unknown>,
  baseDir: string,
  blobMap: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(rawJson)) as Record<string, unknown>;
  const refs = cloned.FileReferences;
  if (typeof refs !== "object" || refs === null) return cloned;

  const refObj = refs as Record<string, unknown>;
  const mapSingle = (val: unknown): unknown => {
    if (typeof val !== "string" || val.length === 0) return val;
    const resolved = resolveRelativeZipPath(baseDir, val);
    return blobMap.get(resolved) ?? val;
  };

  for (const key of ["Moc", "Physics", "Pose", "DisplayInfo", "UserData"]) {
    if (key in refObj) {
      refObj[key] = mapSingle(refObj[key]);
    }
  }

  if (Array.isArray(refObj.Textures)) {
    refObj.Textures = refObj.Textures.map((tex) => mapSingle(tex));
  }

  if (Array.isArray(refObj.Expressions)) {
    refObj.Expressions = refObj.Expressions.map((item) => {
      if (typeof item !== "object" || item === null) return item;
      const entry = { ...(item as Record<string, unknown>) };
      entry.File = mapSingle(entry.File);
      return entry;
    });
  }

  if (typeof refObj.Motions === "object" && refObj.Motions !== null) {
    const motionsObj = refObj.Motions as Record<string, unknown>;
    const nextMotions: Record<string, unknown> = {};
    for (const [groupName, list] of Object.entries(motionsObj)) {
      if (!Array.isArray(list)) {
        nextMotions[groupName] = list;
        continue;
      }
      nextMotions[groupName] = list.map((item) => {
        if (typeof item !== "object" || item === null) return item;
        const entry = { ...(item as Record<string, unknown>) };
        entry.File = mapSingle(entry.File);
        if (typeof entry.Sound === "string") {
          const soundPath = resolveRelativeZipPath(baseDir, entry.Sound);
          const soundBlob = blobMap.get(soundPath);
          if (soundBlob !== undefined) {
            entry.Sound = soundBlob;
          } else {
            delete entry.Sound;
          }
        }
        return entry;
      });
    }
    refObj.Motions = nextMotions;
  }

  return cloned;
}

async function loadCubism4RuntimeModule(): Promise<Cubism4Module> {
  ensurePixiCspRuntime();
  if (cubism4ModuleCache !== null) return cubism4ModuleCache;
  const mod = await import("pixi-live2d-display-lipsyncpatch/cubism4");
  if (!tickerRegistered) {
    mod.Live2DModel.registerTicker(PIXI.Ticker);
    tickerRegistered = true;
  }
  cubism4ModuleCache = mod;
  return mod;
}

function hasCubismCore(): boolean {
  return (window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore !== undefined;
}

/**
 * Dynamically injects `/live2d/live2dcubismcore.min.js` once in browser environments,
 * binds `window.PIXI = PIXI`, and warms the Cubism 4 `Live2DModel` runtime module.
 */
export function ensureCubismCoreLoaded(
  coreScriptUrl: string = LIVE2D_CORE_SCRIPT_URL,
): Promise<boolean> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.resolve(false);
  }
  (window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI;

  if (hasCubismCore()) {
    return loadCubism4RuntimeModule().then(
      () => true,
      () => false,
    );
  }

  if (cubismCoreLoadPromise !== null) {
    return cubismCoreLoadPromise;
  }

  cubismCoreLoadPromise = new Promise<boolean>((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-qianji-live2d-core="true"]`,
    );
    if (existing !== null && hasCubismCore()) {
      resolve(true);
      return;
    }

    const script = document.createElement("script");
    script.src = coreScriptUrl;
    script.async = true;
    script.dataset.qianjiLive2dCore = "true";
    script.onload = () => {
      resolve(hasCubismCore());
    };
    script.onerror = () => {
      cubismCoreLoadPromise = null;
      resolve(false);
    };
    document.head.appendChild(script);
  }).then(async (loaded) => {
    if (!loaded) return false;
    try {
      await loadCubism4RuntimeModule();
      return true;
    } catch {
      return false;
    }
  });

  return cubismCoreLoadPromise;
}

/**
 * Unpacks a user-supplied `.zip` Live2D Cubism 4 archive in memory using `JSZip`,
 * converts all bundled assets into managed `blob:` URLs, and rewrites `.model3.json` references.
 */
export async function registerZipLive2DPackage(
  file: File,
): Promise<{ readonly customId: string; readonly fileName: string }> {
  const buffer = await file.arrayBuffer();
  const archive = await JSZip.loadAsync(buffer);

  const entryNames = Object.keys(archive.files).filter((rawName) => {
    const entry = archive.files[rawName];
    if (!entry || entry.dir) return false;
    const norm = normalizePosixPath(rawName);
    if (norm.startsWith("__MACOSX/")) return false;
    const baseName = norm.split("/").pop() ?? "";
    return !baseName.startsWith(".");
  });

  const modelEntryRaw = entryNames.find((name) => name.toLowerCase().endsWith(".model3.json"));
  if (modelEntryRaw === undefined) {
    throw new Error("ZIP 压缩包中未找到 Cubism 4 (.model3.json) 模型配置文件");
  }

  const modelEntryFile = archive.files[modelEntryRaw];
  if (!modelEntryFile) {
    throw new Error("无法读取 ZIP 中的 .model3.json 文件");
  }

  const modelText = await modelEntryFile.async("string");
  const parsedJson = JSON.parse(modelText) as Record<string, unknown>;

  const normalizedModelPath = normalizePosixPath(modelEntryRaw);
  const lastSlash = normalizedModelPath.lastIndexOf("/");
  const baseDir = lastSlash >= 0 ? normalizedModelPath.slice(0, lastSlash) : "";

  const createdObjectUrls: string[] = [];
  const blobUrlsByPath = new Map<string, string>();

  try {
    for (const rawName of entryNames) {
      const zipObj = archive.files[rawName];
      if (!zipObj) continue;
      const normPath = normalizePosixPath(rawName);
      const bytes = await zipObj.async("uint8array");
      const safeCopy = new Uint8Array(bytes.byteLength);
      safeCopy.set(bytes);
      const blob = new Blob([safeCopy], { type: inferMimeType(normPath) });
      const blobUrl = URL.createObjectURL(blob);
      createdObjectUrls.push(blobUrl);
      blobUrlsByPath.set(normPath, blobUrl);
    }
  } catch (err) {
    for (const u of createdObjectUrls) URL.revokeObjectURL(u);
    throw err;
  }

  const rewrittenModelJson = rewriteModel3FileReferences(parsedJson, baseDir, blobUrlsByPath);

  zipPackageSeq += 1;
  const customId = `zip:live2d-pkg-${zipPackageSeq}`;
  const cleanFileName = file.name || `${normalizedModelPath.split("/").pop() ?? "custom.zip"}`;

  let disposed = false;
  const record: RegisteredZipPackageRecord = {
    customId,
    fileName: cleanFileName,
    entryPath: normalizedModelPath,
    rawModelJson: parsedJson,
    rewrittenModelJson,
    blobUrlsByPath,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const u of createdObjectUrls) {
        URL.revokeObjectURL(u);
      }
      ZIP_PACKAGES.delete(customId);
    },
  };

  ZIP_PACKAGES.set(customId, record);
  return { customId, fileName: cleanFileName };
}

export function getRegisteredZipPackage(customId: string): RegisteredZipPackageRecord | null {
  return ZIP_PACKAGES.get(customId) ?? null;
}

export function revokeZipLive2DPackage(customId: string): void {
  const pkg = ZIP_PACKAGES.get(customId);
  if (pkg !== undefined) {
    pkg.dispose();
  }
}

export async function fetchRawModel3Json(
  sourceUrlOrId: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  if (sourceUrlOrId.startsWith("zip:")) {
    return ZIP_PACKAGES.get(sourceUrlOrId)?.rawModelJson ?? null;
  }
  const cached = MODEL_JSON_CACHE.get(sourceUrlOrId);
  if (cached !== undefined) return cached;
  try {
    const res = await fetch(sourceUrlOrId, signal ? { signal } : undefined);
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, unknown>;
    MODEL_JSON_CACHE.set(sourceUrlOrId, json);
    return json;
  } catch {
    return null;
  }
}

function resolveModelTarget(params: LoadLive2DModelParams): {
  readonly source: string;
  readonly isCustomPackage: boolean;
  readonly presetMeta: Live2DPresetMeta;
} {
  const trimmed = params.customModelSource?.trim() ?? "";
  if (trimmed.length > 0 && !RASTER_IMAGE_URL_RE.test(trimmed)) {
    return {
      source: trimmed,
      isCustomPackage: true,
      presetMeta: resolveLive2DPresetMeta(params.preset),
    };
  }
  const effectivePreset = params.preset === "custom" ? "alabaster-felt" : params.preset;
  const presetMeta = LIVE2D_PRESETS[effectivePreset];
  return {
    source: presetMeta.modelJsonUrl,
    isCustomPackage: false,
    presetMeta,
  };
}

/**
 * Loads a Cubism 4 `Live2DModel` from a built-in preset (`Mao` / `Hiyori` / `Rice`),
 * a direct `.model3.json` URL, or a registered `zip:...` package.
 */
export async function loadLive2DModelInstance(
  params: LoadLive2DModelParams,
): Promise<LoadedLive2DInstance> {
  throwIfAborted(params.signal);
  const target = resolveModelTarget(params);

  const coreReady = await ensureCubismCoreLoaded();
  throwIfAborted(params.signal);
  if (!coreReady) {
    throw new Error("Live2D Cubism 4 Core runtime is unavailable in this environment");
  }

  const { Cubism4ModelSettings: SettingsCtor, Live2DModel } = await loadCubism4RuntimeModule();
  throwIfAborted(params.signal);

  if (target.source.startsWith("zip:")) {
    const zipPkg = ZIP_PACKAGES.get(target.source);
    if (zipPkg === undefined) {
      throw new Error(`Unregistered Live2D ZIP package: ${target.source}`);
    }
    const settingsInput = {
      ...zipPkg.rewrittenModelJson,
      url: `https://qianji-zip.local/${zipPkg.entryPath}`,
    } as ConstructorParameters<typeof SettingsCtor>[0];
    const settings: Cubism4ModelSettings = new SettingsCtor(settingsInput);
    settings.resolveURL = (relOrBlob: string): string => {
      if (/^(?:blob:|data:|https?:)/i.test(relOrBlob)) return relOrBlob;
      const lastSlash = zipPkg.entryPath.lastIndexOf("/");
      const baseDir = lastSlash >= 0 ? zipPkg.entryPath.slice(0, lastSlash) : "";
      const norm = resolveRelativeZipPath(baseDir, relOrBlob);
      return zipPkg.blobUrlsByPath.get(norm) ?? relOrBlob;
    };

    const rawModel = await Live2DModel.from(settings, {
      autoInteract: false,
      crossOrigin: false as unknown as string,
    });
    const model = rawModel as unknown as Live2DModelType<Cubism4InternalModel>;
    if (params.signal?.aborted === true) {
      model.destroy({ children: true });
      throw createAbortError();
    }

    return {
      model,
      rawModelJson: zipPkg.rawModelJson,
      modelUrl: target.source,
      presetMeta: target.presetMeta,
      isCustomPackage: true,
      dispose: () => {
        model.destroy({ children: true });
      },
    };
  }

  const rawModelJson = await fetchRawModel3Json(target.source, params.signal);
  throwIfAborted(params.signal);

  const isExternalHttp = /^https?:\/\//i.test(target.source);
  const loadedModel = await Live2DModel.from(target.source, {
    autoInteract: false,
    crossOrigin: isExternalHttp ? "anonymous" : (false as unknown as string),
  });
  const model = loadedModel as unknown as Live2DModelType<Cubism4InternalModel>;
  if (params.signal?.aborted === true) {
    model.destroy({ children: true });
    throw createAbortError();
  }

  return {
    model,
    rawModelJson,
    modelUrl: target.source,
    presetMeta: target.presetMeta,
    isCustomPackage: target.isCustomPackage,
    dispose: () => {
      model.destroy({ children: true });
    },
  };
}
