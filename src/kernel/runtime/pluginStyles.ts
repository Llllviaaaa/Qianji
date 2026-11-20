/**
 * Client plugin stylesheet runtime (ADR 0016 & ADR 0023).
 *
 * - Scoped styles (`injectPluginScopedStyle` / `ctx.styles.inject()`):
 *   wrapped in `@layer plugin-ui { @scope ([data-qj-plugin="<id>"]) { ... } }`
 *   with `:root` rewritten to `:scope` and unmatched braces sanitized.
 * - Global skin styles (`injectPluginGlobalStyle` / `ctx.styles.injectGlobal()`):
 *   wrapped in `@layer plugin-skin { ... }` (unscoped, sits above host `legacy`/
 *   `skin`/`components` and below Tailwind `utilities`, preserving `:root` tokens
 *   while still sanitizing comments, strings, and unmatched braces).
 *
 * Both channels share the same per-plugin HMR snapshot / prune / rollback /
 * removeAll lifecycle so failed hot reloads restore prior styles cleanly.
 */

export type PluginStyleMode = "scoped" | "global";

function isCssIdentChar(ch: string | undefined): boolean {
  if (ch === undefined || ch === "") return false;
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 45 ||
    code === 95 ||
    code >= 128
  );
}

/**
 * Sanitize plugin CSS body so unmatched `}`, unclosed comments, or unclosed strings
 * can never escape the enclosing `@layer` / `@scope` block. When `rewriteRootToScope`
 * is true (scoped mode), standalone `:root` selectors are rewritten to `:scope`.
 */
function sanitizePluginCssBody(css: string, rewriteRootToScope: boolean): string {
  let out = "";
  let depth = 0;
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    const next = css[i + 1];
    if (ch === "/" && next === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end === -1) {
        out += `${css.slice(i)}*/`;
        break;
      }
      out += css.slice(i, end + 2);
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += quote;
      i += 1;
      let closed = false;
      while (i < css.length) {
        const c = css[i];
        out += c;
        i += 1;
        if (c === "\\" && i < css.length) {
          out += css[i];
          i += 1;
          continue;
        }
        if (c === quote) {
          closed = true;
          break;
        }
      }
      if (!closed) out += quote;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      out += "{";
      i += 1;
      continue;
    }
    if (ch === "}") {
      if (depth > 0) {
        depth -= 1;
        out += "}";
      }
      i += 1;
      continue;
    }
    if (
      rewriteRootToScope &&
      ch === ":" &&
      css.slice(i, i + 5).toLowerCase() === ":root" &&
      !isCssIdentChar(i > 0 ? css[i - 1] : undefined) &&
      !isCssIdentChar(css[i + 5])
    ) {
      const afterRoot = css[i + 5];
      if (afterRoot !== "[" && afterRoot !== "." && afterRoot !== ":") {
        out += ":scope";
        i += 5;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  if (depth > 0) {
    out += "}".repeat(depth);
  }
  return out;
}

/** Wrap raw plugin CSS inside `@layer plugin-ui { @scope ([data-qj-plugin="<id>"]) { ... } }`. */
export function wrapPluginScopedCss(pluginId: string, css: string): string {
  const trimmed = css.trim();
  if (trimmed === "") return "";
  const escapedId = pluginId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const safeBody = sanitizePluginCssBody(css, true);
  return `@layer plugin-ui {\n@scope ([data-qj-plugin="${escapedId}"]) {\n${safeBody}\n}\n}`;
}

/** Wrap raw global skin CSS inside `@layer plugin-skin { ... }` (unscoped, bracket-sanitized). */
export function wrapPluginGlobalCss(css: string): string {
  const trimmed = css.trim();
  if (trimmed === "") return "";
  const safeBody = sanitizePluginCssBody(css, false);
  return `@layer plugin-skin {\n${safeBody}\n}`;
}

interface TrackedPluginStyleEntry {
  el: HTMLStyleElement;
  seq: number;
  isInline: boolean;
  mode: PluginStyleMode;
}

export interface PluginStyleSnapshotEntry {
  el: HTMLStyleElement;
  text: string;
  seq: number;
  isInline?: boolean;
  mode?: PluginStyleMode;
}

const pluginStyleElements = new Map<string, Map<string, TrackedPluginStyleEntry>>();
let dynamicStyleSeq = 0;

function injectPluginStyleInternal(
  mode: PluginStyleMode,
  pluginId: string,
  css: string,
  styleKey?: string,
): () => void {
  if (typeof document === "undefined" || document.head === null) {
    return () => undefined;
  }
  dynamicStyleSeq += 1;
  const writeSeq = dynamicStyleSeq;
  const isInline = styleKey === undefined;
  const resolvedKey = styleKey ?? `inline-${writeSeq}`;
  const mapKey = `${mode}:${resolvedKey}`;
  let perPlugin = pluginStyleElements.get(pluginId);
  if (perPlugin === undefined) {
    perPlugin = new Map<string, TrackedPluginStyleEntry>();
    pluginStyleElements.set(pluginId, perPlugin);
  }
  let tracked = perPlugin.get(mapKey);
  if (tracked === undefined || !tracked.el.isConnected) {
    const styleEl = document.createElement("style");
    styleEl.setAttribute("data-qj-plugin-style", pluginId);
    styleEl.setAttribute("data-qj-style-key", resolvedKey);
    if (mode === "global") {
      styleEl.setAttribute("data-qj-style-scope", "global");
    }
    document.head.appendChild(styleEl);
    tracked = { el: styleEl, seq: writeSeq, isInline, mode };
    perPlugin.set(mapKey, tracked);
  } else {
    tracked.seq = writeSeq;
  }
  const ownedEl = tracked.el;
  ownedEl.textContent = mode === "global"
    ? wrapPluginGlobalCss(css)
    : wrapPluginScopedCss(pluginId, css);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const map = pluginStyleElements.get(pluginId);
    if (map?.get(mapKey)?.el === ownedEl) {
      map.delete(mapKey);
      if (map.size === 0) pluginStyleElements.delete(pluginId);
    }
    ownedEl.remove();
  };
}

/** Inject scoped CSS for `pluginId` into `document.head` and return an idempotent disposer. */
export function injectPluginScopedStyle(pluginId: string, css: string, styleKey?: string): () => void {
  return injectPluginStyleInternal("scoped", pluginId, css, styleKey);
}

/** Inject unscoped `@layer plugin-skin` CSS for `pluginId` into `document.head` and return an idempotent disposer. */
export function injectPluginGlobalStyle(pluginId: string, css: string, styleKey?: string): () => void {
  return injectPluginStyleInternal("global", pluginId, css, styleKey);
}

/** Snapshot all bundle-loaded (non-inline) scoped and global styles for `pluginId` before an HMR reload. */
export function snapshotBundleStyles(pluginId: string): Map<string, PluginStyleSnapshotEntry> {
  const snap = new Map<string, PluginStyleSnapshotEntry>();
  const perPlugin = pluginStyleElements.get(pluginId);
  if (perPlugin === undefined) return snap;
  for (const [key, entry] of perPlugin.entries()) {
    if (!entry.isInline) {
      snap.set(key, {
        el: entry.el,
        text: entry.el.textContent ?? "",
        seq: entry.seq,
        isInline: entry.isInline,
        mode: entry.mode,
      });
    }
  }
  return snap;
}

export const snapshotBundleScopedStyles = snapshotBundleStyles;

/** Prune stale bundle-loaded scoped and global styles left over from before `seqBefore`. */
export function pruneStaleBundleStyles(pluginId: string, seqBefore: number): void {
  const perPlugin = pluginStyleElements.get(pluginId);
  if (perPlugin === undefined) return;
  for (const [key, entry] of [...perPlugin.entries()]) {
    if (!entry.isInline && entry.seq <= seqBefore) {
      entry.el.remove();
      perPlugin.delete(key);
    }
  }
  if (perPlugin.size === 0) {
    pluginStyleElements.delete(pluginId);
  }
}

/** Roll back bundle-loaded scoped and global styles written after `seqBefore` when an HMR reload fails. */
export function rollbackBundleStyles(
  pluginId: string,
  snapshot: ReadonlyMap<string, PluginStyleSnapshotEntry>,
  seqBefore: number,
): void {
  const perPlugin = pluginStyleElements.get(pluginId);
  if (perPlugin !== undefined) {
    for (const [key, entry] of [...perPlugin.entries()]) {
      if (entry.seq > seqBefore && !snapshot.has(key)) {
        entry.el.remove();
        perPlugin.delete(key);
      }
    }
  }
  if (snapshot.size === 0) {
    if (perPlugin !== undefined && perPlugin.size === 0) {
      pluginStyleElements.delete(pluginId);
    }
    return;
  }
  let targetMap = pluginStyleElements.get(pluginId);
  if (targetMap === undefined) {
    targetMap = new Map<string, TrackedPluginStyleEntry>();
    pluginStyleElements.set(pluginId, targetMap);
  }
  for (const [key, prev] of snapshot.entries()) {
    if (!prev.el.isConnected && typeof document !== "undefined" && document.head !== null) {
      document.head.appendChild(prev.el);
    }
    prev.el.textContent = prev.text;
    targetMap.set(key, {
      el: prev.el,
      seq: prev.seq,
      isInline: prev.isInline ?? false,
      mode: prev.mode ?? (key.startsWith("global:") ? "global" : "scoped"),
    });
  }
}

export const rollbackBundleScopedStyles = rollbackBundleStyles;

/** Remove all injected scoped and global `<style>` elements belonging to `pluginId`. */
export function removeAllPluginStyles(pluginId: string): void {
  const perPlugin = pluginStyleElements.get(pluginId);
  if (perPlugin !== undefined) {
    for (const entry of perPlugin.values()) {
      entry.el.remove();
    }
    pluginStyleElements.delete(pluginId);
  }
  if (typeof document !== "undefined") {
    const selector = `style[data-qj-plugin-style="${pluginId.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
    for (const orphan of Array.from(document.querySelectorAll(selector))) {
      orphan.remove();
    }
  }
}

export const removeAllPluginScopedStyles = removeAllPluginStyles;

/** The sequence number of the latest style write, so a reload can prune what it left behind. */
export function currentStyleSeq(): number {
  return dynamicStyleSeq;
}

export interface PluginStyleGlobalHost {
  __qianjiInjectPluginStyle?: (pluginId: string, css: string, styleKey?: string) => () => void;
  __qianjiInjectPluginGlobalStyle?: (pluginId: string, css: string, styleKey?: string) => () => void;
}

/** Expose both scoped and global style injectors on `target` (defaults to `globalThis`). */
export function installPluginStyleGlobals(
  target: PluginStyleGlobalHost = globalThis as unknown as PluginStyleGlobalHost,
): void {
  target.__qianjiInjectPluginStyle ??= injectPluginScopedStyle;
  target.__qianjiInjectPluginGlobalStyle ??= injectPluginGlobalStyle;
}

installPluginStyleGlobals();
