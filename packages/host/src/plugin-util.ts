/**
 * Small helpers of the plugin manager (plugin-manager.ts): value signatures,
 * error text, watcher filtering, plugin export resolution, and the stack
 * parsing that attributes an uncaught error to a plugin's files.
 */
import { fileURLToPath } from "node:url";
import type { Plugin } from "@deepseek-ai/cordis";
import { redactSensitiveText } from "@qianji/protocol";
import { pathComparisonKey } from "./plugin-manifest.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function signatureOf(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, item: unknown) => (typeof item === "function" ? "[function]" : item));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorDetailWithStack(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message || error.name || "Error";
    const rawStack = error.stack?.trim();
    if (rawStack !== undefined && rawStack !== "") {
      const combined = rawStack.includes(msg) ? rawStack : `${error.name || "Error"}: ${msg}\n${rawStack}`;
      return redactSensitiveText(combined);
    }
    return redactSensitiveText(msg);
  }
  return redactSensitiveText(String(error));
}

export function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function shouldIgnoreWatchedPath(filename: string | null | undefined): boolean {
  if (filename == null || filename === "") return false;
  const normalized = filename.replace(/\\/g, "/");
  return normalized === ".git"
    || normalized.startsWith(".git/")
    || normalized.startsWith("node_modules/")
    || normalized === "node_modules"
    || normalized.endsWith(".tmp")
    || normalized.endsWith("~");
}

const fiberToPluginId = new WeakMap<object, string>();

export function tagFiberPluginId(fiber: unknown, pluginId: string): void {
  if (typeof fiber === "object" && fiber !== null && pluginId !== "") {
    fiberToPluginId.set(fiber, pluginId);
  }
}

export function readFiberPluginId(fiber: unknown): string | undefined {
  let cursor: unknown = fiber;
  let guard = 0;
  while (typeof cursor === "object" && cursor !== null && guard < 32) {
    const tagged = fiberToPluginId.get(cursor);
    if (tagged !== undefined) return tagged;
    try {
      const parentCtx = (cursor as { parent?: unknown }).parent;
      cursor =
        typeof parentCtx === "object" && parentCtx !== null
          ? (parentCtx as { fiber?: unknown }).fiber
          : undefined;
    } catch {
      return undefined;
    }
    guard += 1;
  }
  return undefined;
}

function isClassConstructor(fn: unknown): fn is new (ctx: unknown, config: unknown) => object {
  if (typeof fn !== "function") return false;
  const proto = fn.prototype as object | undefined;
  if (proto === undefined || proto === null) return false;
  const src = Function.prototype.toString.call(fn);
  if (/^\s*class\b/.test(src)) return true;
  const staticRecord = fn as unknown as Record<string, unknown>;
  return typeof staticRecord.provide === "string" || Object.getPrototypeOf(fn) !== Function.prototype;
}

function mergeManifestInject(existing: unknown, manifestInject?: readonly string[]): unknown {
  if (manifestInject === undefined || manifestInject.length === 0) return existing;
  if (existing === undefined) return [...manifestInject];
  if (Array.isArray(existing)) {
    const merged = new Set<string>();
    for (const item of existing) {
      if (typeof item === "string" && item.trim() !== "") merged.add(item);
    }
    for (const item of manifestInject) {
      if (item.trim() !== "") merged.add(item);
    }
    return [...merged];
  }
  if (isRecord(existing)) {
    const merged: Record<string, unknown> = { ...existing };
    for (const item of manifestInject) {
      if (item.trim() !== "" && !Object.prototype.hasOwnProperty.call(merged, item)) {
        merged[item] = true;
      }
    }
    return merged;
  }
  return existing;
}

function wrapServiceClass(
  Ctor: new (ctx: unknown, config: unknown) => object,
  pluginId: string,
  manifestInject?: readonly string[],
): Plugin {
  const TaggedService = class extends Ctor {
    constructor(ctx: { fiber?: unknown }, config: unknown) {
      tagFiberPluginId(ctx?.fiber, pluginId);
      super(ctx, config);
    }
  };
  Object.defineProperty(TaggedService, "name", {
    value: (Ctor as { name?: string }).name || pluginId,
    configurable: true,
  });
  const mergedInject = mergeManifestInject((Ctor as { inject?: unknown }).inject, manifestInject);
  if (mergedInject !== undefined) {
    (TaggedService as { inject?: unknown }).inject = mergedInject;
  }
  return TaggedService as unknown as Plugin;
}

function wrapPluginApply(
  applyFn: (ctx: unknown, config: unknown) => unknown,
  pluginId: string,
  meta: Record<string, unknown>,
  manifestInject?: readonly string[],
): Plugin {
  const wrapped: Record<string, unknown> = {
    apply(ctx: { fiber?: unknown }, config: unknown) {
      tagFiberPluginId(ctx?.fiber, pluginId);
      return applyFn.call(this, ctx, config);
    },
  };
  for (const key of ["name", "inject", "provide", "Config", "schema", "reusable"] as const) {
    if (meta[key] !== undefined) wrapped[key] = meta[key];
  }
  const mergedInject = mergeManifestInject(wrapped.inject, manifestInject);
  if (mergedInject !== undefined) wrapped.inject = mergedInject;
  return wrapped as unknown as Plugin;
}

export function resolveCordisPluginExport(
  mod: Record<string, unknown>,
  pluginId: string,
  manifestInject?: readonly string[],
): Plugin {
  if (typeof mod.apply === "function") {
    return wrapPluginApply(mod.apply as (ctx: unknown, config: unknown) => unknown, pluginId, mod, manifestInject);
  }
  const def = mod.default;
  if (typeof def === "function") {
    if (isClassConstructor(def)) {
      return wrapServiceClass(def, pluginId, manifestInject);
    }
    return wrapPluginApply(
      def as (ctx: unknown, config: unknown) => unknown,
      pluginId,
      def as unknown as Record<string, unknown>,
      manifestInject,
    );
  }
  if (isRecord(def) && typeof def.apply === "function") {
    return wrapPluginApply(def.apply as (ctx: unknown, config: unknown) => unknown, pluginId, def, manifestInject);
  }
  throw new Error(`Plugin "${pluginId}" host entry must export apply(ctx, config) or a default Cordis plugin`);
}

function extractBalancedCallSiteLocation(trimmedLine: string): string | undefined {
  if (!trimmedLine.endsWith(")")) return undefined;
  let depth = 0;
  for (let i = trimmedLine.length - 1; i >= 0; i -= 1) {
    const ch = trimmedLine[i];
    if (ch === ")") {
      depth += 1;
    } else if (ch === "(") {
      depth -= 1;
      if (depth === 0) {
        const inner = trimmedLine.slice(i + 1, -1).trim();
        return inner !== "" ? inner : undefined;
      }
    }
  }
  return undefined;
}

function addNormalizedLocationKey(rawToken: string, keys: Set<string>): void {
  const trimmed = rawToken.trim().replace(/^['"`]+|[,;'"`]+$/g, "");
  if (trimmed === "") return;
  const withoutLineCol = trimmed.replace(/(?::\d+){1,2}$/, "");
  if (/^file:\/\//i.test(withoutLineCol)) {
    try {
      keys.add(pathComparisonKey(fileURLToPath(new URL(withoutLineCol))));
    } catch {
      // Ignore malformed file URLs in arbitrary user error strings.
    }
    return;
  }
  const withoutQuery = withoutLineCol.split(/[?#]/, 1)[0] ?? withoutLineCol;
  if (/^[a-zA-Z]:[\\/]/.test(withoutQuery) && withoutQuery.length > 3) {
    keys.add(pathComparisonKey(withoutQuery));
  } else if (withoutQuery.startsWith("/") && !withoutQuery.startsWith("//") && withoutQuery.length > 1) {
    keys.add(pathComparisonKey(withoutQuery));
  }
}

export function extractStackFrameComparisonKeys(stackText: string): string[] {
  const keys = new Set<string>();
  for (const rawLine of stackText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const parenLoc = extractBalancedCallSiteLocation(line);
    if (parenLoc !== undefined) {
      addNormalizedLocationKey(parenLoc, keys);
    }
    const atMatch = /^at\s+(?:async\s+)?(.+)$/.exec(line);
    if (atMatch?.[1] !== undefined && !atMatch[1].endsWith(")")) {
      addNormalizedLocationKey(atMatch[1], keys);
    }
    const jscAtIdx = line.indexOf("@");
    if (jscAtIdx >= 0 && jscAtIdx + 1 < line.length) {
      addNormalizedLocationKey(line.slice(jscAtIdx + 1), keys);
    }
  }
  for (const match of stackText.matchAll(/file:\/\/\/[^\s"'`<>|]+/gi)) {
    const token = match[0].replace(/\)+$/, "");
    addNormalizedLocationKey(token, keys);
  }
  return [...keys];
}
