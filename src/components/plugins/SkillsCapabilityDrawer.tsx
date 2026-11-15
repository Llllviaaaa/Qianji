import { useMemo, useState } from "react";
import type { SkillInfo } from "@qianji/protocol";
import { Search, X } from "lucide-react";
import type { Notice } from "./pluginHelpers";
import { SkillsSettingsSection } from "./SkillsSettingsSection";

export interface SkillsCapabilityDrawerProps {
  cwd: string;
  skills: readonly SkillInfo[];
  onNotify: (notice: Notice) => void;
  onCloseSettings?: () => void;
}

/** Structured Skills capability drawer embedded inside the `prompt-context` core extension card. */
export function SkillsCapabilityDrawer({
  cwd,
  skills,
  onNotify,
  onCloseSettings,
}: SkillsCapabilityDrawerProps) {
  const [search, setSearch] = useState("");

  const stats = useMemo(() => {
    let enabled = 0;
    let pluginProvided = 0;
    let projectScoped = 0;
    for (const item of skills) {
      if (item.enabled) enabled += 1;
      if (item.pluginId) pluginProvided += 1;
      else if (item.scope === "project") projectScoped += 1;
    }
    return { total: skills.length, enabled, pluginProvided, projectScoped };
  }, [skills]);

  return (
    <div className="plugin-structured-form">
      <div className="mcp-overview-footer">
        <div className="mcp-overview-stats">
          <span className="plugin-op-chip">共 {stats.total} 个技能</span>
          <span className={`plugin-op-chip${stats.enabled > 0 ? " tone-green" : ""}`}>
            已启用 {stats.enabled} 项
          </span>
          {stats.pluginProvided > 0 && (
            <span className="plugin-op-chip tone-accent">插件附带 {stats.pluginProvided} 项</span>
          )}
          {stats.projectScoped > 0 && (
            <span className="plugin-op-chip">项目级 {stats.projectScoped} 项</span>
          )}
        </div>

        <label className="plugins-search-box skills-drawer-search">
          <Search size={13.5} aria-hidden="true" />
          <input
            type="search"
            value={search}
            placeholder="搜索技能、/skill 命令或插件来源…"
            aria-label="搜索 Agent 技能"
            onChange={(event) => setSearch(event.target.value)}
          />
          {search !== "" && (
            <button
              type="button"
              className="plugins-search-clear"
              aria-label="清空技能搜索"
              onClick={() => setSearch("")}
            >
              <X size={12} />
            </button>
          )}
        </label>
      </div>

      <SkillsSettingsSection
        cwd={cwd}
        search={search}
        onNotify={onNotify}
        onCloseSettings={onCloseSettings}
      />
    </div>
  );
}
