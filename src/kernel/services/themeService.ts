/**
 * Frontend Cordis `themeService` (ADR 0023 Phase 2).
 *
 * Manages Qianji's merged appearance theme catalog, resolved color scheme,
 * accent color, UI scale, and transcript density with automatic Cordis Fiber
 * cleanup for plugin-registered themes and subscribers.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import {
  buildThemeCssVariables,
  mergeAppearanceCatalog,
  resolveAppearanceTheme,
  type AppearanceCatalog,
  type AppearanceThemeDefinition,
  type ThemePalette,
} from "../../lib/appearanceCatalog";
import {
  clientContributions,
  ClientContributionRegistry,
  type AppearanceThemeInput,
} from "../../lib/clientContributions";
import { applyUiScale, resolveUiScale } from "../../lib/panelLayout";
import {
  nextTranscriptDensity,
  normalizeTranscriptDensity,
  type TranscriptDensity,
} from "../../lib/transcriptDensity";
import { useAppStore } from "../../store";
import type { AppSettings } from "../../types";
import { ServiceEmitter, shallowEqualObject, trackContextEffect } from "./shared";

export type {
  AppearanceCatalog,
  AppearanceThemeDefinition,
  AppearanceThemeInput,
  ThemePalette,
  TranscriptDensity,
};

declare module "@deepseek-ai/cordis" {
  interface Context {
    themeService: ThemeService;
  }
}

export interface ThemeServiceSnapshot {
  readonly catalog: AppearanceCatalog;
  readonly themeId: string;
  readonly activeTheme: AppearanceThemeDefinition;
  readonly resolvedScheme: "light" | "dark";
  readonly accentColor: string;
  readonly uiScale: number;
  readonly resolvedScale: number;
  readonly transcriptDensity: TranscriptDensity;
}

export interface ThemeServiceOptions {
  registry?: ClientContributionRegistry;
}

function readSystemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

function clampUiScalePercent(value: number | undefined): number {
  const numeric = Number(value ?? 100);
  if (!Number.isFinite(numeric)) return 100;
  return Math.min(150, Math.max(75, Math.round(numeric)));
}

interface ThemeInternalState {
  readonly registry: ClientContributionRegistry;
  systemDark: boolean;
  localThemeId: string;
  localAccentColor: string;
  localUiScale: number;
  localTranscriptDensity: TranscriptDensity;
  cachedThemesRef: readonly AppearanceThemeDefinition[];
  cachedCatalog: AppearanceCatalog;
  snapshot: ThemeServiceSnapshot;
  readonly emitter: ServiceEmitter;
}

export class ThemeService extends Service {
  static provide = "themeService";
  private readonly internal: ThemeInternalState;

  constructor(ctx: Context, options?: ThemeServiceOptions) {
    super(ctx, "themeService");
    const registry = options?.registry ?? clientContributions;
    const initialThemes = registry.getSnapshot().themes;
    const initialCatalog = mergeAppearanceCatalog(initialThemes);

    this.internal = {
      registry,
      systemDark: readSystemPrefersDark(),
      localThemeId: "system",
      localAccentColor: "",
      localUiScale: 100,
      localTranscriptDensity: "normal",
      cachedThemesRef: initialThemes,
      cachedCatalog: initialCatalog,
      snapshot: null as unknown as ThemeServiceSnapshot,
      emitter: new ServiceEmitter("themeService"),
    };
    this.internal.snapshot = this.computeSnapshot();

    const sync = () => {
      const next = this.computeSnapshot();
      if (!shallowEqualObject(this.internal.snapshot, next)) {
        this.internal.snapshot = next;
        this.internal.emitter.emit();
      }
    };

    const offStore = useAppStore.subscribe((state, prev) => {
      if (state.settings !== prev.settings) sync();
    });

    const offContrib = registry.subscribe(() => {
      const nextThemes = registry.getSnapshot().themes;
      if (nextThemes !== this.internal.cachedThemesRef) {
        this.internal.cachedThemesRef = nextThemes;
        this.internal.cachedCatalog = mergeAppearanceCatalog(nextThemes);
        sync();
      }
    });

    let mediaQuery: MediaQueryList | null = null;
    const onMediaChange = (event: MediaQueryListEvent) => {
      this.internal.systemDark = event.matches;
      sync();
    };
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      try {
        mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
        mediaQuery.addEventListener("change", onMediaChange);
      } catch {
        mediaQuery = null;
      }
    }

    ctx.effect(() => () => {
      offStore();
      offContrib();
      mediaQuery?.removeEventListener("change", onMediaChange);
      this.internal.emitter.clear();
    });
  }

  private computeSnapshot(): ThemeServiceSnapshot {
    const settings = useAppStore.getState().settings;
    const catalog = this.internal.cachedCatalog;
    const themeId = settings?.theme ?? this.internal.localThemeId;
    const activeTheme = resolveAppearanceTheme(catalog, themeId, this.internal.systemDark);
    const resolvedScheme: "light" | "dark" = activeTheme.mode === "dark" ? "dark" : "light";
    const accentColor = settings?.accentColor ?? this.internal.localAccentColor;
    const uiScale = clampUiScalePercent(settings?.uiScale ?? this.internal.localUiScale);
    const transcriptDensity = settings
      ? normalizeTranscriptDensity(settings.transcriptDensity)
      : this.internal.localTranscriptDensity;

    return {
      catalog,
      themeId,
      activeTheme,
      resolvedScheme,
      accentColor,
      uiScale,
      resolvedScale: resolveUiScale(uiScale),
      transcriptDensity,
    };
  }

  private publish(): void {
    const next = this.computeSnapshot();
    if (!shallowEqualObject(this.internal.snapshot, next)) {
      this.internal.snapshot = next;
      this.internal.emitter.emit();
    }
  }

  private async persistSettingsPatch(patch: Partial<AppSettings>): Promise<void> {
    const state = useAppStore.getState();
    if (!state.settings) return;
    const nextSettings: AppSettings = { ...state.settings, ...patch };
    if (typeof window === "undefined") {
      useAppStore.setState({ settings: nextSettings });
      return;
    }
    await state.saveSettings(nextSettings);
  }

  getSnapshot(): ThemeServiceSnapshot {
    return this.internal.snapshot;
  }

  subscribe(listener: () => void): () => void {
    const rawUnsub = this.internal.emitter.add(listener);
    return trackContextEffect(this.ctx, rawUnsub);
  }

  registerTheme(theme: AppearanceThemeInput): () => void {
    const rawDispose = this.internal.registry.registerTheme(theme);
    return trackContextEffect(this.ctx, rawDispose);
  }

  async setTheme(themeId: string): Promise<void> {
    const trimmed = themeId.trim();
    if (trimmed === "") return;
    this.internal.localThemeId = trimmed;
    await this.persistSettingsPatch({ theme: trimmed });
    this.publish();
    this.applyToDocument();
  }

  async setAccentColor(accentColor: string): Promise<void> {
    this.internal.localAccentColor = accentColor;
    await this.persistSettingsPatch({ accentColor });
    this.publish();
    this.applyToDocument();
  }

  async setTranscriptDensity(density: TranscriptDensity): Promise<void> {
    const normalized = normalizeTranscriptDensity(density);
    this.internal.localTranscriptDensity = normalized;
    await this.persistSettingsPatch({ transcriptDensity: normalized });
    this.publish();
  }

  async cycleTranscriptDensity(): Promise<TranscriptDensity> {
    const next = nextTranscriptDensity(this.internal.snapshot.transcriptDensity);
    await this.setTranscriptDensity(next);
    return next;
  }

  async setUiScale(uiScale: number): Promise<void> {
    const clamped = clampUiScalePercent(uiScale);
    this.internal.localUiScale = clamped;
    await this.persistSettingsPatch({ uiScale: clamped });
    this.publish();
    this.applyToDocument();
  }

  applyToDocument(): void {
    if (typeof document === "undefined" || !document.documentElement) return;
    const root = document.documentElement;
    const snap = this.internal.snapshot;
    const palette = snap.activeTheme.palette;
    if (palette) {
      root.dataset.theme = snap.resolvedScheme;
      const vars = buildThemeCssVariables(palette);
      for (const [name, value] of Object.entries(vars)) {
        root.style.setProperty(name, value);
      }
      if (snap.accentColor.trim() !== "") {
        root.style.setProperty("--qj-brand-primary", snap.accentColor);
        root.style.setProperty("--accent", snap.accentColor);
        root.style.setProperty("--accent-custom", snap.accentColor);
      }
      root.style.color = palette.text;
      root.style.background = palette.sidebar;
    }
    applyUiScale(root, document.getElementById("root"), snap.uiScale);
  }
}
