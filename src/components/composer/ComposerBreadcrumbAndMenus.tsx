import {
  Check,
  ChevronDown,
  File,
  Folder,
  GitBranch,
  Image as ImageIcon,
  Monitor,
  Search,
  X,
} from "lucide-react";
import type {
  AttachmentPayload,
  ManagedQueuedMessage,
} from "../../types";

export { ComposerSuggestionMenus } from "./ComposerSuggestionMenus";

export function ComposerBreadcrumbTrail({
  workspace,
  workspaceName,
  isDefaultWorkspaceMode,
  visibleWorkspaces,
  workspaceOpen,
  setWorkspaceOpen,
  workspaceQuery,
  setWorkspaceQuery,
  environment,
  environmentOpen,
  setEnvironmentOpen,
  setActionsOpen,
  branchLabel,
  onWorkspaceSelect,
  onPickWorkspace,
  onQuickChat,
  onEnvironmentChange,
}: {
  workspace: string;
  workspaceName: string;
  isDefaultWorkspaceMode: boolean;
  visibleWorkspaces: string[];
  workspaceOpen: boolean;
  setWorkspaceOpen: React.Dispatch<React.SetStateAction<boolean>>;
  workspaceQuery: string;
  setWorkspaceQuery: (next: string) => void;
  environment: "local" | "worktree";
  environmentOpen: boolean;
  setEnvironmentOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setActionsOpen: (next: boolean) => void;
  branchLabel: string;
  onWorkspaceSelect?: (workspace: string) => void;
  onPickWorkspace?: () => void;
  onQuickChat?: () => void;
  onEnvironmentChange?: (environment: "local" | "worktree") => void;
}) {
  return (
    <div className="composer-breadcrumb-trail" aria-label="项目与工作环境">
      <div className="workspace-context-wrap">
        <button
          type="button"
          className="chip chip-project"
          onClick={() => {
            setEnvironmentOpen(false);
            setActionsOpen(false);
            setWorkspaceOpen((v) => !v);
          }}
          title={isDefaultWorkspaceMode ? "默认工作区（快速对话）" : workspace}
        >
          <Folder size={13} strokeWidth={1.75} />
          <span>{workspaceName}</span>
          <ChevronDown size={11} strokeWidth={1.75} />
        </button>
        {workspaceOpen && (
          <div className="workspace-context-menu">
            <label>
              <Search size={13} />
              <input
                autoFocus
                value={workspaceQuery}
                onChange={(e) => setWorkspaceQuery(e.target.value)}
                placeholder="搜索项目"
              />
            </label>
            <div className="workspace-context-list">
              {visibleWorkspaces.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => {
                    onWorkspaceSelect?.(item);
                    setWorkspaceOpen(false);
                    setWorkspaceQuery("");
                  }}
                  title={item}
                >
                  <span>{item.split(/[\\/]/).filter(Boolean).pop()}</span>
                  {!isDefaultWorkspaceMode && item === workspace && <Check size={13} />}
                </button>
              ))}
              {visibleWorkspaces.length === 0 && <small>没有已知项目</small>}
            </div>
            <button
              type="button"
              className="workspace-context-new"
              onClick={() => {
                setWorkspaceOpen(false);
                onPickWorkspace?.();
              }}
            >
              打开其他文件夹…
            </button>
            <button
              type="button"
              className="workspace-context-new"
              onClick={() => {
                setWorkspaceOpen(false);
                onQuickChat?.();
              }}
            >
              <span>默认工作区（快速对话）</span>
              {isDefaultWorkspaceMode && <Check size={13} />}
            </button>
          </div>
        )}
      </div>
      {!isDefaultWorkspaceMode && (
        <div className="environment-context-wrap">
          <button
            type="button"
            className={`chip chip-env ${environment === "worktree" ? "worktree" : "local"}`}
            onClick={() => {
              setWorkspaceOpen(false);
              setActionsOpen(false);
              setEnvironmentOpen((value) => !value);
            }}
            title={environment === "worktree" ? "Worktree 隔离检出" : "本地工作区"}
            aria-haspopup="menu"
            aria-expanded={environmentOpen}
          >
            {environment === "worktree" ? <GitBranch size={13} /> : <Monitor size={13} />}
            <span>{environment === "worktree" ? "Worktree" : "本地"}</span>
            <ChevronDown size={11} strokeWidth={1.75} />
          </button>
          {environmentOpen && (
            <div className="workspace-context-menu environment-context-menu" role="menu">
              <div className="workspace-context-list">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onEnvironmentChange?.("local");
                    setEnvironmentOpen(false);
                  }}
                >
                  <Monitor size={13} />
                  <span>本地</span>
                  {environment === "local" && <Check size={13} />}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onEnvironmentChange?.("worktree");
                    setEnvironmentOpen(false);
                  }}
                >
                  <GitBranch size={13} />
                  <span>Worktree</span>
                  {environment === "worktree" && <Check size={13} />}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {branchLabel ? (
        <span className="chip chip-branch" title="当前分支">
          <GitBranch size={13} strokeWidth={1.75} />
          <span>{branchLabel}</span>
        </span>
      ) : null}
    </div>
  );
}

export function ComposerAttachmentStrip({
  attachments,
  onRemoveAttachment,
}: {
  attachments: AttachmentPayload[];
  onRemoveAttachment: (path: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="attachment-strip">
      {attachments.map((attachment) => (
        <div className="attachment-chip" key={attachment.path}>
          {attachment.kind === "image" ? <ImageIcon size={14} /> : <File size={14} />}
          <span>{attachment.fileName}</span>
          <button type="button" onClick={() => onRemoveAttachment(attachment.path)} title="移除附件">
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function ComposerQueuedDrawer(_props: {
  pendingCount: number;
  queuedMessages: ManagedQueuedMessage[];
  queueOpen: boolean;
  setQueueOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onMoveQueuedMessage?: (id: string, direction: -1 | 1) => void;
  onSteerQueuedMessage?: (id: string) => void | Promise<void>;
  onRemoveQueuedMessage?: (id: string) => void;
}) {
  return null;
}

export const ComposerQueue = ComposerQueuedDrawer;
