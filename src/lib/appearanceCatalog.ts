export type AppearanceScope = "builtin" | "user" | "project";

export interface ThemePalette {
  app: string;
  panel: string;
  panelStrong: string;
  panelSoft: string;
  hover: string;
  active: string;
  border: string;
  borderStrong: string;
  text: string;
  text2: string;
  text3: string;
  accent: string;
  accentText: string;
  sidebar: string;
}

export interface AppearanceThemeDefinition {
  id: string;
  label: string;
  mode: "system" | "light" | "dark";
  scope: AppearanceScope;
  sourcePath?: string;
  palette?: ThemePalette;
}

export interface AppearanceCatalog {
  themes: AppearanceThemeDefinition[];
}

export const LIGHT_PALETTE: ThemePalette = {
  app: "#ffffff",
  sidebar: "#f2f3f6",
  panel: "#ffffff",
  panelSoft: "#f4f5f7",
  panelStrong: "#eaecf0",
  hover: "rgba(15, 23, 42, 0.048)",
  active: "rgba(15, 23, 42, 0.076)",
  border: "rgba(15, 23, 42, 0.075)",
  borderStrong: "rgba(15, 23, 42, 0.13)",
  text: "#111214",
  text2: "#686b70",
  text3: "#8b8f95",
  accent: "#006ee4",
  accentText: "#ffffff",
};

export const DARK_PALETTE: ThemePalette = {
  app: "#191a1d",
  sidebar: "#111214",
  panel: "#222428",
  panelSoft: "#26282d",
  panelStrong: "#31343a",
  hover: "rgba(255, 255, 255, 0.055)",
  active: "rgba(255, 255, 255, 0.088)",
  border: "rgba(255, 255, 255, 0.075)",
  borderStrong: "rgba(255, 255, 255, 0.13)",
  text: "#fcfcfc",
  text2: "#989b9e",
  text3: "#717477",
  accent: "#4b93ff",
  accentText: "#ffffff",
};

export const BUILTIN_APPEARANCE_CATALOG: AppearanceCatalog = {
  themes: [
    { id: "system", label: "跟随系统", mode: "system", scope: "builtin" },
    { id: "light", label: "浅色", mode: "light", scope: "builtin", palette: LIGHT_PALETTE },
    { id: "dark", label: "深色", mode: "dark", scope: "builtin", palette: DARK_PALETTE },
  ],
};

export function mergeAppearanceCatalog(themes: readonly AppearanceThemeDefinition[]): AppearanceCatalog {
  if (themes.length === 0) return BUILTIN_APPEARANCE_CATALOG;
  const byId = new Map(BUILTIN_APPEARANCE_CATALOG.themes.map((item) => [item.id, item]));
  const ordered = [...themes].sort((left, right) => {
    const rank = (scope: AppearanceScope) => scope === "project" ? 2 : scope === "user" ? 1 : 0;
    return rank(left.scope) - rank(right.scope);
  });
  for (const item of ordered) byId.set(item.id, item);
  return { themes: [...byId.values()] };
}

export function resolveAppearanceTheme(
  catalog: AppearanceCatalog,
  id: string,
  systemDark: boolean,
): AppearanceThemeDefinition {
  const selected = catalog.themes.find((theme) => theme.id === id)
    ?? catalog.themes.find((theme) => theme.id === "system")
    ?? BUILTIN_APPEARANCE_CATALOG.themes[0];
  if (selected.mode !== "system") return selected;
  const resolvedId = systemDark ? "dark" : "light";
  return catalog.themes.find((theme) => theme.id === resolvedId)
    ?? BUILTIN_APPEARANCE_CATALOG.themes.find((theme) => theme.id === resolvedId)
    ?? BUILTIN_APPEARANCE_CATALOG.themes[0];
}

export function buildThemeCssVariables(palette: ThemePalette): Record<string, string> {
  return {
    "--qj-bg-app": palette.app,
    "--qj-bg-canvas": palette.app,
    "--qj-bg-sidebar": palette.sidebar,
    "--qj-bg-surface": palette.panel,
    "--qj-bg-subtle": palette.panelSoft,
    "--qj-bg-elevated": palette.panelStrong,
    "--qj-bg-hover": palette.hover,
    "--qj-bg-active": palette.active,
    "--qj-border-default": palette.border,
    "--qj-border-strong": palette.borderStrong,
    "--pi-stage-border": palette.border,
    "--qj-text-primary": palette.text,
    "--qj-text-secondary": palette.text2,
    "--qj-text-muted": palette.text3,
    "--qj-text-inverse": palette.app,
    "--qj-brand-primary": palette.accent,
    "--qj-brand-contrast": palette.accentText,
    "--app": palette.app,
    "--panel": palette.panel,
    "--panel-strong": palette.panelStrong,
    "--panel-soft": palette.panelSoft,
    "--hover": palette.hover,
    "--active": palette.active,
    "--border": palette.border,
    "--border-strong": palette.borderStrong,
    "--text": palette.text,
    "--text-2": palette.text2,
    "--text-3": palette.text3,
    "--accent": palette.accent,
    "--accent-custom": palette.accent,
    "--accent-text": palette.accentText,
    "--sidebar-bg": palette.sidebar,
    "--sidebar-text": palette.text2,
    "--thread-muted": palette.text3,
  };
}
