import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import type { SkillInfo } from "@qianji/protocol";
import { Search, X } from "lucide-react";
import { queryKeys } from "../../lib/queries";
import { skillClient } from "../../lib/skillClient";
import { SkillsSettingsSection } from "../plugins/SkillsSettingsSection";
import type { Notice } from "../plugins/pluginHelpers";

export interface SkillsSettingsPageProps {
  cwd: string;
  onCloseSettings?: () => void;
}

const NO_SKILLS: SkillInfo[] = [];

/** Standalone Settings page for browsing, authoring, toggling, and inserting Agent Skills. */
export function SkillsSettingsPage({ cwd, onCloseSettings }: SkillsSettingsPageProps) {
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState<Notice>(null);

  const skillsQuery = useQuery({
    queryKey: queryKeys.skills(cwd),
    queryFn: () => skillClient.list(cwd),
  });
  const skills = skillsQuery.data ?? NO_SKILLS;

  const stats = useMemo(() => {
    let enabled = 0;
    let project = 0;
    for (const item of skills) {
      if (item.enabled) enabled += 1;
      if (item.scope === "project") project += 1;
    }
    return { total: skills.length, enabled, project };
  }, [skills]);

  return (
    <div className="skills-page-stack">
      <div className="skills-page-header">
        <label className="plugins-search-box">
          <Search size={14} />
          <input
            placeholder="搜索技能名称、触发描述、/skill 指令或 SKILL.md 路径…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {search !== "" && (
            <button type="button" aria-label="清空技能搜索" onClick={() => setSearch("")}>
              <X size={12} />
            </button>
          )}
        </label>

        <div className="mcp-overview-stats">
          <span className="plugin-op-chip">共 {stats.total} 个技能</span>
          <span className="plugin-op-chip tone-green">已启用 {stats.enabled} 个</span>
          {cwd.trim() !== "" && <span className="plugin-op-chip tone-accent">项目级 {stats.project} 个</span>}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {notice !== null && (
          <motion.div
            className={`plugins-notice ${notice.kind}`}
            role="status"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.14 }}
          >
            <span>{notice.text}</span>
            <button type="button" className="icon-button" aria-label="关闭提示" onClick={() => setNotice(null)}>
              <X size={13} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <SkillsSettingsSection cwd={cwd} search={search} onNotify={setNotice} onCloseSettings={onCloseSettings} />
    </div>
  );
}
