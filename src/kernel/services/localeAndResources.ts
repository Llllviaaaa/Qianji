/**
 * Frontend Cordis `localeService` and `resourcesService` (ADR 0023 Phase 2).
 *
 * - `LocaleService`: optional i18n dictionary registry (`registerNamespace`,
 *   `getLocale`, `setLocale`, `bind(ns)` with fallback to `common` and key).
 * - `ResourcesService`: URI-scheme resource protocol registry (`registerProtocol`,
 *   `read`, `subscribe` / `subscribeResource`) with automatic Cordis Fiber disposal.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import { useAppStore } from "../../store";
import { ServiceEmitter, shallowEqualArray, trackContextEffect } from "./shared";

declare module "@deepseek-ai/cordis" {
  interface Context {
    localeService: LocaleService;
    resourcesService: ResourcesService;
  }
}

/* -------------------------------------------------------------------------- */
/*                               LocaleService                                */
/* -------------------------------------------------------------------------- */

export type LocaleCode = "zh-CN" | "en" | (string & {});
export type LocaleDictionary = Readonly<Record<string, string>>;
export type LocaleBundle = Readonly<Record<string, LocaleDictionary>>;
export type TranslateParams = Readonly<Record<string, string | number | boolean>>;
export type TranslateFn<K extends string = string> = (key: K, params?: TranslateParams) => string;

export interface LocaleServiceSnapshot {
  readonly locale: LocaleCode;
  readonly fallbackLocale: LocaleCode;
  readonly namespaces: readonly string[];
}

export interface LocaleServiceOptions {
  initialLocale?: LocaleCode;
  fallbackLocale?: LocaleCode;
}

interface NamespaceEntry {
  readonly id: number;
  readonly bundle: LocaleBundle;
}

function detectSystemLocale(): LocaleCode {
  if (typeof navigator !== "undefined" && typeof navigator.language === "string") {
    return navigator.language.toLowerCase().startsWith("en") ? "en" : "zh-CN";
  }
  return "zh-CN";
}

function resolveSettingsLocale(language: string | undefined): LocaleCode {
  if (language === "en" || language === "zh-CN") return language;
  return detectSystemLocale();
}

function interpolateTemplate(template: string, params?: TranslateParams): string {
  if (params === undefined) return template;
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}|\{\s*([A-Za-z0-9_.-]+)\s*\}/g, (match, doubleKey, singleKey) => {
    const key = (doubleKey ?? singleKey) as string;
    if (!Object.prototype.hasOwnProperty.call(params, key)) return match;
    return String(params[key]);
  });
}

interface LocaleInternalState {
  locale: LocaleCode;
  fallbackLocale: LocaleCode;
  explicitLocale: boolean;
  nextEntryId: number;
  readonly namespaces: Map<string, NamespaceEntry[]>;
  snapshot: LocaleServiceSnapshot;
  readonly emitter: ServiceEmitter;
}

export class LocaleService extends Service {
  static provide = "localeService";
  private readonly internal: LocaleInternalState;

  constructor(ctx: Context, options?: LocaleServiceOptions) {
    super(ctx, "localeService");
    const settingsLang = useAppStore.getState().settings?.language;
    const initialLocale = options?.initialLocale ?? resolveSettingsLocale(settingsLang);
    const fallbackLocale = options?.fallbackLocale ?? "en";

    this.internal = {
      locale: initialLocale,
      fallbackLocale,
      explicitLocale: options?.initialLocale !== undefined,
      nextEntryId: 0,
      namespaces: new Map(),
      snapshot: {
        locale: initialLocale,
        fallbackLocale,
        namespaces: [],
      },
      emitter: new ServiceEmitter("localeService"),
    };

    const offStore = useAppStore.subscribe((state, prev) => {
      if (this.internal.explicitLocale) return;
      if (state.settings?.language !== prev.settings?.language) {
        const nextLocale = resolveSettingsLocale(state.settings?.language);
        if (nextLocale !== this.internal.locale) {
          this.internal.locale = nextLocale;
          this.publish();
        }
      }
    });

    ctx.effect(() => () => {
      offStore();
      this.internal.namespaces.clear();
      this.internal.emitter.clear();
    });
  }

  private publish(): void {
    const names = [...this.internal.namespaces.keys()].sort();
    const prev = this.internal.snapshot;
    if (
      prev.locale === this.internal.locale
      && prev.fallbackLocale === this.internal.fallbackLocale
      && shallowEqualArray(prev.namespaces, names)
    ) {
      // Dictionary contents inside an existing namespace may still have changed.
      this.internal.snapshot = { ...prev };
      this.internal.emitter.emit();
      return;
    }
    this.internal.snapshot = {
      locale: this.internal.locale,
      fallbackLocale: this.internal.fallbackLocale,
      namespaces: names,
    };
    this.internal.emitter.emit();
  }

  private lookupInNamespace(namespace: string, locale: LocaleCode, key: string): string | undefined {
    const stack = this.internal.namespaces.get(namespace);
    if (!stack || stack.length === 0) return undefined;
    // Later registrations override earlier ones; disposing restores previous entries.
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const entry = stack[i];
      const dict = entry?.bundle[locale];
      if (dict !== undefined && Object.prototype.hasOwnProperty.call(dict, key)) {
        return dict[key];
      }
    }
    return undefined;
  }

  getSnapshot(): LocaleServiceSnapshot {
    return this.internal.snapshot;
  }

  subscribe(listener: () => void): () => void {
    const rawUnsub = this.internal.emitter.add(listener);
    return trackContextEffect(this.ctx, rawUnsub);
  }

  getLocale(): LocaleCode {
    return this.internal.locale;
  }

  setLocale(locale: LocaleCode): void {
    const trimmed = locale.trim();
    if (trimmed === "") return;
    this.internal.explicitLocale = true;
    if (this.internal.locale === trimmed) return;
    this.internal.locale = trimmed;
    this.publish();
  }

  registerNamespace(namespace: string, bundle: LocaleBundle): () => void {
    const cleanNs = namespace.trim();
    if (cleanNs === "") return () => undefined;
    const entry: NamespaceEntry = {
      id: ++this.internal.nextEntryId,
      bundle,
    };
    const stack = this.internal.namespaces.get(cleanNs) ?? [];
    stack.push(entry);
    this.internal.namespaces.set(cleanNs, stack);
    this.publish();

    return trackContextEffect(this.ctx, () => {
      const current = this.internal.namespaces.get(cleanNs);
      if (!current) return;
      const next = current.filter((item) => item.id !== entry.id);
      if (next.length === current.length) return;
      if (next.length === 0) this.internal.namespaces.delete(cleanNs);
      else this.internal.namespaces.set(cleanNs, next);
      this.publish();
    });
  }

  translate(namespace: string, key: string, params?: TranslateParams): string {
    const currentLocale = this.internal.locale;
    const fallbackLocale = this.internal.fallbackLocale;
    const raw =
      this.lookupInNamespace(namespace, currentLocale, key)
      ?? (fallbackLocale !== currentLocale ? this.lookupInNamespace(namespace, fallbackLocale, key) : undefined)
      ?? (namespace !== "common" ? this.lookupInNamespace("common", currentLocale, key) : undefined)
      ?? (namespace !== "common" && fallbackLocale !== currentLocale
        ? this.lookupInNamespace("common", fallbackLocale, key)
        : undefined)
      ?? key;
    return interpolateTemplate(raw, params);
  }

  bind<K extends string = string>(namespace: string): TranslateFn<K> {
    const cleanNs = namespace.trim() || "common";
    return (key: K, params?: TranslateParams) => this.translate(cleanNs, key, params);
  }
}

/* -------------------------------------------------------------------------- */
/*                              ResourcesService                              */
/* -------------------------------------------------------------------------- */

export interface ParsedResourceUri {
  readonly raw: string;
  readonly scheme: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
}

export interface ResourceProtocolHandler<T = unknown> {
  read: (uri: string, parsed: ParsedResourceUri) => Promise<T> | T;
  subscribe?: (uri: string, listener: (value: T) => void, parsed: ParsedResourceUri) => () => void;
}

export interface ResourcesServiceSnapshot {
  readonly schemes: readonly string[];
}

export function normalizeResourceScheme(scheme: string): string {
  return scheme.trim().replace(/:\/?\/?$/, "").toLowerCase();
}

export function parseResourceUri(uri: string): ParsedResourceUri {
  const trimmed = uri.trim();
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/)?([^?]*)(?:\?(.*))?$/.exec(trimmed);
  if (!match || !match[1]) {
    throw new Error(`无效的资源 URI: "${uri}"`);
  }
  const scheme = match[1].toLowerCase();
  const path = match[2] ?? "";
  const query: Record<string, string> = {};
  const rawQuery = match[3];
  if (rawQuery !== undefined && rawQuery !== "") {
    for (const pair of rawQuery.split("&")) {
      if (pair === "") continue;
      const eq = pair.indexOf("=");
      if (eq < 0) {
        query[decodeURIComponent(pair)] = "";
      } else {
        query[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
      }
    }
  }
  return { raw: trimmed, scheme, path, query };
}

interface ProtocolEntry {
  readonly id: number;
  readonly handler: ResourceProtocolHandler<unknown>;
}

interface ResourcesInternalState {
  nextId: number;
  readonly protocols: Map<string, ProtocolEntry[]>;
  snapshot: ResourcesServiceSnapshot;
  readonly emitter: ServiceEmitter;
}

export class ResourcesService extends Service {
  static provide = "resourcesService";
  private readonly internal: ResourcesInternalState;

  constructor(ctx: Context) {
    super(ctx, "resourcesService");
    this.internal = {
      nextId: 0,
      protocols: new Map(),
      snapshot: { schemes: [] },
      emitter: new ServiceEmitter("resourcesService"),
    };

    ctx.effect(() => () => {
      this.internal.protocols.clear();
      this.internal.snapshot = { schemes: [] };
      this.internal.emitter.clear();
    });
  }

  private publish(): void {
    const schemes = [...this.internal.protocols.keys()].sort();
    this.internal.snapshot = { schemes };
    this.internal.emitter.emit();
  }

  private resolveHandler(scheme: string): ResourceProtocolHandler<unknown> | undefined {
    const stack = this.internal.protocols.get(scheme);
    return stack && stack.length > 0 ? stack[stack.length - 1]?.handler : undefined;
  }

  getSnapshot(): ResourcesServiceSnapshot {
    return this.internal.snapshot;
  }

  hasProtocol(scheme: string): boolean {
    return this.resolveHandler(normalizeResourceScheme(scheme)) !== undefined;
  }

  registerProtocol<T = unknown>(scheme: string, handler: ResourceProtocolHandler<T>): () => void {
    const normalized = normalizeResourceScheme(scheme);
    if (normalized === "") {
      throw new Error("资源协议 scheme 不能为空");
    }
    const entry: ProtocolEntry = {
      id: ++this.internal.nextId,
      handler: handler as ResourceProtocolHandler<unknown>,
    };
    const stack = this.internal.protocols.get(normalized) ?? [];
    stack.push(entry);
    this.internal.protocols.set(normalized, stack);
    this.publish();

    return trackContextEffect(this.ctx, () => {
      const current = this.internal.protocols.get(normalized);
      if (!current) return;
      const next = current.filter((item) => item.id !== entry.id);
      if (next.length === current.length) return;
      if (next.length === 0) this.internal.protocols.delete(normalized);
      else this.internal.protocols.set(normalized, next);
      this.publish();
    });
  }

  async read<T = unknown>(uri: string): Promise<T> {
    const parsed = parseResourceUri(uri);
    const handler = this.resolveHandler(parsed.scheme);
    if (!handler) {
      throw new Error(`未注册的资源协议: "${parsed.scheme}" (${uri})`);
    }
    return (await handler.read(parsed.raw, parsed)) as T;
  }

  subscribeProtocols(listener: () => void): () => void {
    const rawUnsub = this.internal.emitter.add(listener);
    return trackContextEffect(this.ctx, rawUnsub);
  }

  subscribeResource<T = unknown>(uri: string, listener: (value: T) => void): () => void {
    const parsed = parseResourceUri(uri);
    let disposed = false;
    let currentUnsub: (() => void) | null = null;
    let boundHandler: ResourceProtocolHandler<unknown> | undefined;

    const deliver = (value: unknown) => {
      if (disposed) return;
      try {
        listener(value as T);
      } catch (error) {
        console.error(`[qianji-services:resourcesService] resource subscriber (${uri}) failed:`, error);
      }
    };

    const bindCurrentProtocol = () => {
      if (disposed) return;
      const nextHandler = this.resolveHandler(parsed.scheme);
      if (nextHandler === boundHandler) return;
      currentUnsub?.();
      currentUnsub = null;
      boundHandler = nextHandler;
      if (!nextHandler) return;

      if (typeof nextHandler.subscribe === "function") {
        currentUnsub = nextHandler.subscribe(parsed.raw, deliver, parsed);
      } else {
        void Promise.resolve(nextHandler.read(parsed.raw, parsed))
          .then(deliver)
          .catch((error) => {
            console.error(`[qianji-services:resourcesService] resource read (${uri}) failed:`, error);
          });
      }
    };

    bindCurrentProtocol();
    const offProtocols = this.internal.emitter.add(bindCurrentProtocol);

    return trackContextEffect(this.ctx, () => {
      disposed = true;
      offProtocols();
      currentUnsub?.();
      currentUnsub = null;
      boundHandler = undefined;
    });
  }

  subscribe(listener: () => void): () => void;
  subscribe<T = unknown>(uri: string, listener: (value: T) => void): () => void;
  subscribe<T = unknown>(
    uriOrListener: string | (() => void),
    maybeListener?: (value: T) => void,
  ): () => void {
    if (typeof uriOrListener === "function") {
      return this.subscribeProtocols(uriOrListener);
    }
    if (typeof maybeListener !== "function") {
      throw new Error("ResourcesService.subscribe(uri, listener) requires a listener function");
    }
    return this.subscribeResource(uriOrListener, maybeListener);
  }
}
