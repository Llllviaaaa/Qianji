import {
  Archive,
  FolderOpen,
  GitBranch,
  Pin,
  Settings,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type { ClientSidebarSectionContribution } from "../../lib/clientContributions";
import type { ProjectConfig, SessionInfo } from "../../types";
import { SlotEntryHost } from "../common/ErrorBoundary";
import { PluginMenuItems } from "../common/PluginMenuItems";
import type { SettingsPage } from "../SettingsModal";
import type { PositionedProjectMenu } from "./sidebarHelpers";

export interface SidebarFloatingMenusAndFooterProps {
  cwd: string;
  currentSessionFile: string | null;
  leftSidebarSections?: readonly ClientSidebarSectionContribution[];
  projectMenu: PositionedProjectMenu | null;
  setProjectMenu: (next: PositionedProjectMenu | null) => void;
  groups: Array<[string, SessionInfo[]]>;
  projectConfig: (workspace: string) => ProjectConfig;
  updateProjectConfig: (workspace: string, changes: Partial<ProjectConfig>) => Promise<void>;
  onOpenProjectFolder: (workspace: string) => void;
  onCreateWorktree: (workspace: string) => void | Promise<void>;
  beginProjectRename: (workspace: string) => void;
  onArchiveProject: (workspace: string, sessions: SessionInfo[]) => void | Promise<void>;
  removeProject: (workspace: string) => Promise<void>;
  closePopovers: () => void;
  onOpenSettings: (page: SettingsPage) => void;
  settingsShortcut?: string;
}

export function SidebarFloatingMenusAndFooter({
  cwd,
  currentSessionFile,
  leftSidebarSections,
  projectMenu,
  setProjectMenu,
  groups,
  projectConfig,
  updateProjectConfig,
  onOpenProjectFolder,
  onCreateWorktree,
  beginProjectRename,
  onArchiveProject,
  removeProject,
  closePopovers,
  onOpenSettings,
  settingsShortcut,
}: SidebarFloatingMenusAndFooterProps) {
  return (
    <>
      {projectMenu && (() => {
        const chats = groups.find(([workspace]) => workspace === projectMenu.workspace)?.[1] ?? [];
        const pinned = projectConfig(projectMenu.workspace).pinned;
        return (
          <div className="sidebar-popover project-context-menu" style={{ top: projectMenu.top }} data-sidebar-popover>
            <button
              type="button"
              onClick={() => {
                void updateProjectConfig(projectMenu.workspace, { pinned: !pinned });
                setProjectMenu(null);
              }}
            >
              <Pin size={15} />{pinned ? "取消置顶项目" : "置顶项目"}
            </button>
            <button
              type="button"
              onClick={() => {
                onOpenProjectFolder(projectMenu.workspace);
                setProjectMenu(null);
              }}
            >
              <FolderOpen size={15} />在资源管理器中打开
            </button>
            <button
              type="button"
              onClick={() => {
                void onCreateWorktree(projectMenu.workspace);
                setProjectMenu(null);
              }}
            >
              <GitBranch size={15} />创建永久工作树
            </button>
            <button type="button" onClick={() => beginProjectRename(projectMenu.workspace)}>
              <SlidersHorizontal size={15} />编辑项目
            </button>
            <button
              type="button"
              onClick={() => {
                void onArchiveProject(projectMenu.workspace, chats);
                setProjectMenu(null);
              }}
            >
              <Archive size={15} />归档聊天
            </button>
            <PluginMenuItems
              location="sidebar.project"
              context={{ workspace: projectMenu.workspace, sessionFiles: chats.map((chat) => chat.file) }}
              onClose={() => setProjectMenu(null)}
              separatorClassName="sidebar-popover-separator"
            />
            <div className="sidebar-popover-separator" />
            <button type="button" className="danger" onClick={() => void removeProject(projectMenu.workspace)}>
              <X size={15} />移除本地项目
            </button>
          </div>
        );
      })()}

      {leftSidebarSections !== undefined && leftSidebarSections.length > 0 && (
        <div className="pid-sidebar-plugin-slot" data-slot="sidebar-plugins">
          {leftSidebarSections.map((section) => (
            <div key={section.id} className="pid-sidebar-plugin-section">
              <SlotEntryHost
                entry={section}
                context={{ cwd, sessionFile: currentSessionFile }}
                slotName="leftSidebar"
              />
            </div>
          ))}
        </div>
      )}

      <div className="sidebar-footer codex-footer">
        <button
          type="button"
          className="footer-account dsh-claude-account-btn"
          onClick={() => {
            closePopovers();
            onOpenSettings("general");
          }}
          title={settingsShortcut ? `设置 (${settingsShortcut})` : "设置"}
          aria-label="设置"
        >
          <Settings size={15} strokeWidth={1.7} aria-hidden="true" />
          <span className="dsh-claude-account-user">设置</span>
          {settingsShortcut && <span className="sidebar-footer-shortcut" aria-hidden="true">{settingsShortcut}</span>}
        </button>
      </div>
    </>
  );
}
