/**
 * Built-in keyed settings page components (`general`, `appearance`, `providers`)
 * for `core-settings` (ADR 0023 Phase 4).
 */
import { useMemo, type ReactElement, type ReactNode } from "react";
import { FolderOpen } from "lucide-react";
import type { AgentModeName, PermissionModeName } from "@qianji/protocol";
import {
  useFrontendService,
  useSessionState,
  useThemeState,
  useWorkspaceState,
  type TranscriptDensity,
} from "@qianji/client";
import type { SettingsPageSlotProps, SlotComponentProps } from "@qianji/client-slots";
import { Badge, Button, Card, Select, type SelectOption } from "@qianji/client-primitives";

type PageCompProps = SlotComponentProps<SettingsPageSlotProps, "root">;

const AGENT_MODE_OPTIONS: readonly SelectOption[] = [
  { value: "agent", label: "智能体（自动执行工具）" },
  { value: "plan", label: "规划模式（先产出方案）" },
  { value: "ask", label: "问答模式（只读对话）" },
];

const PERMISSION_MODE_OPTIONS: readonly SelectOption[] = [
  { value: "read-only", label: "只读（禁止写入与命令）" },
  { value: "ask", label: "按次确认（默认）" },
  { value: "workspace-write", label: "工作区自动写入" },
  { value: "full-access", label: "完全权限" },
];

const UI_SCALE_OPTIONS = [90, 100, 110, 125] as const;

const DENSITY_OPTIONS: ReadonlyArray<{ readonly value: TranscriptDensity; readonly label: string }> = [
  { value: "summary", label: "精简" },
  { value: "normal", label: "标准" },
  { value: "verbose", label: "详细" },
];

function SettingRow({
  title,
  description,
  control,
}: {
  readonly title: string;
  readonly description?: string;
  readonly control: ReactNode;
}): ReactElement {
  return (
    <div
      className="setting-row"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "16px",
        padding: "10px 0",
        borderBottom: "1px solid var(--qj-border-subtle)",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
        <strong style={{ fontSize: "13px", fontWeight: 560, color: "var(--qj-text-primary)" }}>{title}</strong>
        {description !== undefined && (
          <small style={{ fontSize: "12px", color: "var(--qj-text-secondary)", lineHeight: 1.4 }}>
            {description}
          </small>
        )}
      </div>
      <div style={{ flexShrink: 0 }}>{control}</div>
    </div>
  );
}

export function GeneralSettingsSlotPage({ ctx, cwd }: PageCompProps): ReactElement {
  const sessionState = useSessionState(ctx);
  const workspaceState = useWorkspaceState(ctx);
  const sessionService = useFrontendService("sessionService", ctx);
  const workspaceService = useFrontendService("workspaceService", ctx);

  const activeCwd = workspaceState?.cwd || cwd || "";
  const agentMode = sessionState?.agentMode ?? "agent";
  const permissionMode = sessionState?.permissionMode ?? "ask";

  return (
    <div data-testid="settings-page-general" style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <Card variant="subtle" padding="md">
        <SettingRow
          title="默认智能体模式"
          description="控制当前会话中 Agent 的执行风格（智能体执行、规划方案或只读问答）"
          control={(
            <div style={{ minWidth: "200px" }}>
              <Select
                aria-label="默认智能体模式"
                value={agentMode}
                options={AGENT_MODE_OPTIONS}
                onValueChange={(next) => void sessionService?.setAgentMode(next as AgentModeName)}
              />
            </div>
          )}
        />
        <SettingRow
          title="工具权限策略"
          description="决定文件写入与终端命令是否需要人工确认"
          control={(
            <div style={{ minWidth: "200px" }}>
              <Select
                aria-label="工具权限策略"
                value={permissionMode}
                options={PERMISSION_MODE_OPTIONS}
                onValueChange={(next) => void sessionService?.setPermissionMode(next as PermissionModeName)}
              />
            </div>
          )}
        />
      </Card>

      <Card variant="subtle" padding="md">
        <SettingRow
          title="当前工作区目录"
          description={activeCwd !== "" ? activeCwd : "尚未选择工作区目录"}
          control={(
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              {workspaceState?.trust.trusted === true && <Badge variant="success">已信任</Badge>}
              <Button type="button" size="sm" variant="secondary" onClick={() => void workspaceService?.pickFolder()}>
                <FolderOpen size={13} />
                <span>切换目录</span>
              </Button>
            </div>
          )}
        />
        <SettingRow
          title="急救安全模式快捷键"
          description="当外部插件导致核心界面异常时，随时按下该组合键停用外部插件"
          control={<Badge variant="neutral">Ctrl+Shift+Alt+R</Badge>}
        />
      </Card>
    </div>
  );
}

export function AppearanceSettingsSlotPage({ ctx }: PageCompProps): ReactElement {
  const themeState = useThemeState(ctx);
  const themeService = useFrontendService("themeService", ctx);
  const themes = themeState?.catalog.themes ?? [];
  const activeThemeId = themeState?.themeId ?? "light";
  const uiScale = themeState?.uiScale ?? 100;
  const density = themeState?.transcriptDensity ?? "normal";

  return (
    <div data-testid="settings-page-appearance" style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <Card variant="subtle" padding="md">
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <strong style={{ fontSize: "13px", color: "var(--qj-text-primary)" }}>主题模式</strong>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }} role="radiogroup" aria-label="主题模式">
            {themes.map((theme) => {
              const selected = activeThemeId === theme.id;
              return (
                <Button
                  key={theme.id}
                  type="button"
                  size="sm"
                  variant={selected ? "primary" : "secondary"}
                  role="radio"
                  aria-checked={selected}
                  onClick={() => void themeService?.setTheme(theme.id)}
                >
                  <span>{theme.label}</span>
                </Button>
              );
            })}
          </div>
        </div>
      </Card>

      <Card variant="subtle" padding="md">
        <SettingRow
          title="全局界面缩放"
          description="按比例缩放工作台整体字号与控件尺寸"
          control={(
            <div style={{ display: "flex", gap: "6px" }}>
              {UI_SCALE_OPTIONS.map((scale) => (
                <Button
                  key={scale}
                  type="button"
                  size="sm"
                  variant={uiScale === scale ? "primary" : "secondary"}
                  onClick={() => void themeService?.setUiScale(scale)}
                >
                  {scale}%
                </Button>
              ))}
            </div>
          )}
        />
        <SettingRow
          title="消息密度"
          description="调节对话气泡与工具卡片之间的纵向紧凑程度"
          control={(
            <div style={{ display: "flex", gap: "6px" }}>
              {DENSITY_OPTIONS.map((opt) => (
                <Button
                  key={opt.value}
                  type="button"
                  size="sm"
                  variant={density === opt.value ? "primary" : "secondary"}
                  onClick={() => void themeService?.setTranscriptDensity(opt.value)}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          )}
        />
      </Card>
    </div>
  );
}

const DEFAULT_THINKING_LEVELS: readonly string[] = ["off", "low", "medium", "high"];

export function ProvidersSettingsSlotPage({ ctx }: PageCompProps): ReactElement {
  const sessionState = useSessionState(ctx);
  const sessionService = useFrontendService("sessionService", ctx);
  const availableModels = sessionState?.availableModels;
  const activeModel = sessionState?.model ?? null;
  const activeModelKey = activeModel !== null ? `${activeModel.provider}/${activeModel.id}` : "";
  const thinkingLevels = sessionState?.availableThinkingLevels;
  const activeThinking = sessionState?.thinkingLevel ?? "medium";

  const modelOptions = useMemo<SelectOption[]>(() => {
    const models = availableModels ?? [];
    return models.length > 0
      ? models.map((item) => ({
          value: `${item.provider}/${item.id}`,
          label: `${item.name || item.id} (${item.provider})`,
        }))
      : [{ value: activeModelKey, label: activeModelKey || "暂无可用模型" }];
  }, [availableModels, activeModelKey]);

  const thinkingOptions = useMemo<SelectOption[]>(
    () => (thinkingLevels ?? DEFAULT_THINKING_LEVELS).map((lvl) => ({ value: lvl, label: lvl })),
    [thinkingLevels],
  );

  const modelList = availableModels ?? [];

  return (
    <div data-testid="settings-page-providers" style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <Card variant="subtle" padding="md">
        <SettingRow
          title="当前对话模型"
          description="切换当前会话使用的默认语言模型"
          control={(
            <div style={{ minWidth: "240px" }}>
              <Select
                aria-label="当前对话模型"
                value={activeModelKey}
                options={modelOptions}
                disabled={modelList.length === 0 || sessionState?.isSwitchingModel === true}
                onValueChange={(nextKey) => {
                  const found = modelList.find((m) => `${m.provider}/${m.id}` === nextKey);
                  if (found !== undefined) void sessionService?.setModel(found);
                }}
              />
            </div>
          )}
        />
        <SettingRow
          title="推理思考等级"
          description="配置支持深度思考模型的默认推理强度"
          control={(
            <div style={{ minWidth: "160px" }}>
              <Select
                aria-label="推理思考等级"
                value={activeThinking}
                options={thinkingOptions}
                onValueChange={(next) => void sessionService?.setThinkingLevel(next)}
              />
            </div>
          )}
        />
      </Card>
    </div>
  );
}
