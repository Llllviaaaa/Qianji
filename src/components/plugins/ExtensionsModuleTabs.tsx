import { LayoutGroup, motion } from "motion/react";
import { BookOpen, Boxes, Plug } from "lucide-react";
import { PILL_SPRING } from "./pluginHelpers";

export type ExtensionsSection = "plugins" | "skills" | "mcp";

export interface ExtensionsModuleTabsProps {
  active: ExtensionsSection;
  onChange: (next: ExtensionsSection) => void;
  pluginsCount: number;
  skillsCount: number;
  mcpCount: number;
}

export function ExtensionsModuleTabs({
  active,
  onChange,
  pluginsCount,
  skillsCount,
  mcpCount,
}: ExtensionsModuleTabsProps) {
  const tabs: ReadonlyArray<{
    id: ExtensionsSection;
    label: string;
    icon: React.ReactNode;
    count: number;
  }> = [
    { id: "plugins", label: "扩展插件", icon: <Boxes size={14.5} />, count: pluginsCount },
    { id: "skills", label: "Agent 技能", icon: <BookOpen size={14.5} />, count: skillsCount },
    { id: "mcp", label: "MCP 服务", icon: <Plug size={14.5} />, count: mcpCount },
  ];

  return (
    <LayoutGroup id="extensions-module-tabs">
      <div className="extensions-module-tabs" role="tablist" aria-label="扩展能力分类">
        {tabs.map((tab) => {
          const isActive = active === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`extensions-module-tab${isActive ? " active" : ""}`}
              onClick={() => onChange(tab.id)}
            >
              {tab.icon}
              <span>{tab.label}</span>
              <span className="extensions-module-tab-badge">{tab.count}</span>
              {isActive && (
                <motion.span
                  layoutId="extensions-module-tab-line"
                  className="extensions-module-tab-line"
                  transition={PILL_SPRING}
                />
              )}
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}
