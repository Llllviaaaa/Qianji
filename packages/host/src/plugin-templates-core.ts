/**
 * ADR 0023 Phase 6 core scaffold templates (`"core-override"` and `"global-skin"`)
 * consumed by `scaffoldPluginFiles()` (`plugin-scaffold.ts`) and `plugin_manager`.
 *
 * Every generated template compiles cleanly through `ClientBundleRegistry.compile()`,
 * passes `verifyPluginDirectory()`, and passes `tsc --noEmit` against generated
 * offline `plugin-types/`.
 */

export const CORE_PLUGIN_TEMPLATE_KINDS = ["core-override", "global-skin"] as const;

export type CorePluginTemplateKind = (typeof CORE_PLUGIN_TEMPLATE_KINDS)[number];

export interface CoreTemplateContext {
  readonly pluginId: string;
  readonly title: string;
  readonly description: string;
  readonly toolPrefix: string;
}

export interface CoreTemplateFileEntry {
  readonly relPath: string;
  readonly content: string;
}

export interface CoreTemplateSpec {
  readonly configSchema: Record<string, unknown>;
  readonly tsconfigInclude: readonly string[];
  readonly files: readonly CoreTemplateFileEntry[];
}

export function isCorePluginTemplateKind(value: string): value is CorePluginTemplateKind {
  return value === "core-override" || value === "global-skin";
}

function buildCoreOverrideClientTsx(ctx: CoreTemplateContext): string {
  const { pluginId, title, toolPrefix } = ctx;
  const footerSlot = `${toolPrefix}.composerFooter`;
  return `import { useState, type ChangeEvent } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { ArrowRight, Sparkles, X } from "lucide-react";
import {
  sendChatPrompt,
  showToast,
  useComposerState,
  usePluginConfig,
  useSessionState,
} from "@qianji/client";
import { Badge, Button } from "@qianji/client-primitives";
import type { SlotComponentProps, SlotPropsOf, SlotSpec } from "@qianji/client-slots";

interface CoreOverrideConfig {
  enabled: boolean;
  bannerTitle: string;
  placeholder: string;
}

interface ComposerOverlaySelection {
  readonly variant: "task-start" | "follow-up";
}

declare module "@qianji/client-slots" {
  interface SlotMap {
    ${JSON.stringify(footerSlot)}: SlotSpec<
      { readonly cwd?: string; readonly sessionId: string | null },
      "list",
      "session-maybe"
    >;
  }
}

const OVERRIDE_CSS = \`
.override-shell {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--qj-radius-md, 10px);
  border: 1px solid var(--qj-border-default, var(--border));
  background: var(--qj-bg-elevated, var(--panel));
  color: var(--qj-text-primary, var(--text));
}
.override-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}
.override-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}
.override-textarea {
  width: 100%;
  min-height: 54px;
  resize: vertical;
  padding: 8px 10px;
  border-radius: var(--qj-radius-sm, 6px);
  border: 1px solid var(--qj-border-subtle, var(--border));
  background: var(--qj-bg-surface, var(--app));
  color: var(--qj-text-primary, var(--text));
  font: inherit;
}
.override-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.override-meta {
  font-size: 11.5px;
  color: var(--qj-text-muted, var(--text-3));
}
.override-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
\`;

type ComposerOverrideProps = SlotComponentProps<
  SlotPropsOf<"composer.main">,
  "session-maybe",
  unknown,
  ComposerOverlaySelection
>;

function CustomComposerOverride({
  cwd,
  sessionId,
  sessionKey,
  isStreaming,
  selected,
  renderSlot,
}: ComposerOverrideProps) {
  const config = usePluginConfig<CoreOverrideConfig>(${JSON.stringify(pluginId)}, {
    enabled: true,
    bannerTitle: ${JSON.stringify(title)},
    placeholder: "输入指令（overlay: true 将保留底层核心输入框草稿）...",
  });
  const sessionState = useSessionState();
  const composerState = useComposerState(sessionKey);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const activeCwd = cwd ?? (typeof sessionState?.cwd === "string" ? sessionState.cwd : "");
  const underlyingDraft = typeof composerState?.draft === "string" ? composerState.draft : "";

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    setText(event.target.value);
  };

  const handleSend = async (): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed === "" || sending) return;
    setSending(true);
    try {
      const ok = await sendChatPrompt(trimmed);
      if (ok) {
        setText("");
        showToast(\`[\${config.bannerTitle}] 已发送指令\`, "success");
      }
    } finally {
      setSending(false);
    }
  };

  if (!config.enabled) {
    return null;
  }

  return (
    <div className="override-shell" data-variant={selected?.variant ?? "follow-up"}>
      <div className="override-header">
        <span className="override-title">
          <Sparkles size={13} />
          <span>{config.bannerTitle}</span>
        </span>
        <Badge variant="brand">overlay: true</Badge>
      </div>
      <textarea
        className="override-textarea"
        value={text}
        placeholder={config.placeholder}
        disabled={sending || isStreaming === true}
        onChange={handleChange}
      />
      <div className="override-footer">
        <span className="override-meta">
          {activeCwd !== "" ? activeCwd : "未选择工作区"}
          {underlyingDraft !== "" ? \` · 已保留底层草稿 (\${underlyingDraft.length} 字)\` : ""}
        </span>
        <div className="override-actions">
          {renderSlot(${JSON.stringify(footerSlot)}, { cwd: activeCwd, sessionId })}
          {text !== "" && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setText("")}>
              <X size={12} />
              <span>清空</span>
            </Button>
          )}
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={sending || isStreaming === true || text.trim() === ""}
            onClick={() => void handleSend()}
          >
            <span>发送</span>
            <ArrowRight size={12} />
          </Button>
        </div>
      </div>
    </div>
  );
}

export const name = ${JSON.stringify(`${pluginId}-client`)};
export const inject = ["slots", "styles"];

export function apply(ctx: Context): void {
  const disposeStyle = ctx.styles.inject(OVERRIDE_CSS, "core-override");
  const disposeSlot = ctx.slots.register<"composer.main", unknown, ComposerOverlaySelection>("composer.main", {
    id: "${toolPrefix}-composer-override",
    priority: 20,
    overlay: true,
    select: (ownerProps) => {
      if (ownerProps.pendingApproval === true) return false;
      return { variant: ownerProps.variant ?? "follow-up" };
    },
    children: {
      ${JSON.stringify(footerSlot)}: {
        kind: "list",
        scope: "session-maybe",
        description: "Optional footer actions rendered inside the custom composer override.",
      },
    },
    component: CustomComposerOverride,
  });

  // Cordis Fiber disposal automatically removes both the slot override and stylesheet on unload/HMR.
  ctx.effect(() => () => {
    disposeSlot();
    disposeStyle();
  });
}
`;
}

function buildGlobalSkinCss(ctx: CoreTemplateContext): string {
  return `/* ${ctx.title} — Global skin stylesheet.
 * Compiled by Qianji Host ClientBundleRegistry into \`@layer plugin-skin\`
 * (unscoped, sits above host legacy/skin/components and below Tailwind utilities)
 * and automatically pruned/rolled back on HMR or plugin unload.
 */
:root {
  --qj-radius-sm: 6px;
  --qj-radius-md: 10px;
  --qj-radius-lg: 14px;
}

.app-shell {
  letter-spacing: 0.01em;
}

.composer-box {
  transition: border-color 150ms ease, box-shadow 150ms ease;
}

.composer-box:focus-within {
  border-color: var(--qj-brand-primary);
  box-shadow: 0 0 0 2px var(--qj-brand-soft);
}
`;
}

const CSS_MODULE_AMBIENT_DTS = `declare module "*.css" {
  const cssText: string;
  export default cssText;
}

declare module "*.global.css" {
  const cssText: string;
  export default cssText;
}
`;

function buildGlobalSkinClientTsx(ctx: CoreTemplateContext): string {
  const { pluginId, title, toolPrefix } = ctx;
  return `import type { Context } from "@deepseek-ai/cordis";
import "./skin.global.css";

export interface GlobalSkinConfig {
  accentColor?: string;
  borderRadiusPx?: number;
}

function sanitizeCssValue(raw: string | undefined, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const cleaned = raw.replace(/[{};\\r\\n]/g, "").trim();
  return cleaned !== "" ? cleaned : fallback;
}

function buildDynamicSkinCss(config: GlobalSkinConfig): string {
  const accent = sanitizeCssValue(config.accentColor, "#7c5cff");
  const radius =
    typeof config.borderRadiusPx === "number" && Number.isFinite(config.borderRadiusPx)
      ? Math.max(0, Math.min(24, Math.round(config.borderRadiusPx)))
      : 12;

  return \`
:root {
  --qj-brand-primary: \${accent};
  --qj-brand-hover: color-mix(in srgb, \${accent} 88%, #ffffff);
  --qj-brand-soft: color-mix(in srgb, \${accent} 16%, transparent);
  --qj-radius-md: \${radius}px;
  --qj-radius-lg: \${radius + 4}px;
}
\`;
}

export const name = ${JSON.stringify(`${pluginId}-client`)};
export const inject = ["styles", "contributions"];

export function apply(ctx: Context, config: GlobalSkinConfig = {}): void {
  const accent = sanitizeCssValue(config.accentColor, "#7c5cff");

  // Dynamic @layer plugin-skin rules (disposed cleanly alongside skin.global.css on HMR/unload).
  const disposeGlobalCss = ctx.styles.injectGlobal(buildDynamicSkinCss(config), "dynamic-skin");

  // Register a matching Appearance theme selectable from Settings -> Appearance.
  const disposeTheme = ctx.contributions.registerTheme({
    id: "${toolPrefix}-skin",
    label: ${JSON.stringify(title)},
    mode: "dark",
    palette: {
      accent,
      accentSoft: "rgba(124, 92, 255, 0.16)",
      accentContrast: "#ffffff",
      app: "#0d0f17",
      canvas: "#111420",
      sidebar: "#0b0d14",
      panel: "#171b29",
      border: "rgba(148, 163, 184, 0.18)",
    },
  });

  ctx.effect(() => () => {
    disposeTheme();
    disposeGlobalCss();
  });
}
`;
}

export function buildCoreTemplateSpec(
  template: CorePluginTemplateKind,
  ctx: CoreTemplateContext,
): CoreTemplateSpec {
  if (template === "core-override") {
    return {
      configSchema: {
        type: "object",
        properties: {
          enabled: {
            type: "boolean",
            title: "启用核心输入框接管",
            description: "以 overlay: true 方式在 composer.main 上展示自定义输入栏",
            default: true,
          },
          bannerTitle: {
            type: "string",
            title: "输入栏标题",
            description: "自定义输入栏顶部展示的标题文本",
            default: ctx.title,
          },
          placeholder: {
            type: "string",
            title: "输入占位提示",
            description: "输入区域为空时显示的提示文案",
            default: "输入指令（overlay: true 将保留底层核心输入框草稿）...",
          },
        },
      },
      tsconfigInclude: ["client.tsx"],
      files: [
        {
          relPath: "client.tsx",
          content: buildCoreOverrideClientTsx(ctx),
        },
      ],
    };
  }

  return {
    configSchema: {
      type: "object",
      properties: {
        accentColor: {
          type: "string",
          title: "全局强调色",
          description: "注入 @layer plugin-skin 与主题调色板的强调色（CSS 颜色值）",
          default: "#7c5cff",
        },
        borderRadiusPx: {
          type: "integer",
          title: "圆角半径 (px)",
          description: "全局卡片与输入栏圆角大小",
          default: 12,
          minimum: 0,
          maximum: 24,
        },
      },
    },
    tsconfigInclude: ["client.tsx", "env.d.ts"],
    files: [
      {
        relPath: "skin.global.css",
        content: buildGlobalSkinCss(ctx),
      },
      {
        relPath: "env.d.ts",
        content: CSS_MODULE_AMBIENT_DTS,
      },
      {
        relPath: "client.tsx",
        content: buildGlobalSkinClientTsx(ctx),
      },
    ],
  };
}
