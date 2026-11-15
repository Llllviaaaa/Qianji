import { PluginsSettingsPanel } from "./PluginsSettingsPanel";

export interface PluginsHubPageProps {
  cwd: string;
  onReturnToChat?: () => void;
}

export function PluginsHubPage({ cwd, onReturnToChat }: PluginsHubPageProps) {
  return (
    <section className="plugins-hub-page">
      <div className="plugins-hub-inner">
        <header className="plugins-hub-header">
          <h1>扩展插件</h1>
          <p>统一管理扩展插件、核心能力、Agent 技能 (Skills) 与 MCP 工具服务</p>
        </header>
        <PluginsSettingsPanel cwd={cwd} onDismissHub={onReturnToChat} />
      </div>
    </section>
  );
}
