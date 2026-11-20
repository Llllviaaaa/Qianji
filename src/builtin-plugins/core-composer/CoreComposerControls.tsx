/**
 * Workspace breadcrumb trail and model/thinking picker controls for
 * `core-composer` (ADR 0023 Wave 2B).
 */
import { useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, Folder, GitBranch, Search } from "lucide-react";
import {
  useFrontendService,
  useSessionHandle,
  useSessionState,
  type SessionHandle,
} from "@qianji/client";
import { formatWorkspaceName } from "./composerHelpers";

export function CoreComposerBreadcrumb({
  workspace,
  workspaceOptions,
  branchLabel,
  onSelectWorkspace,
  onPickWorkspace,
}: {
  readonly workspace: string;
  readonly workspaceOptions: readonly string[];
  readonly branchLabel: string;
  readonly onSelectWorkspace: (next: string) => void;
  readonly onPickWorkspace: () => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const workspaceName = formatWorkspaceName(workspace);

  const visibleWorkspaces = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return workspaceOptions
      .filter((item) => normalized === "" || item.toLowerCase().includes(normalized))
      .slice(0, 8);
  }, [query, workspaceOptions]);

  return (
    <div className="composer-breadcrumb-trail" aria-label="项目与工作环境">
      <div className="workspace-context-wrap">
        <button
          type="button"
          className="chip chip-project"
          title={workspace !== "" ? workspace : "默认工作区"}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Folder size={13} strokeWidth={1.75} />
          <span>{workspaceName}</span>
          <ChevronDown size={11} strokeWidth={1.75} />
        </button>
        {open && (
          <div className="workspace-context-menu">
            <label>
              <Search size={13} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索项目"
              />
            </label>
            <div className="workspace-context-list">
              {visibleWorkspaces.map((item) => (
                <button
                  key={item}
                  type="button"
                  title={item}
                  onClick={() => {
                    onSelectWorkspace(item);
                    setOpen(false);
                    setQuery("");
                  }}
                >
                  <span>{formatWorkspaceName(item)}</span>
                  {item === workspace && <Check size={13} />}
                </button>
              ))}
              {visibleWorkspaces.length === 0 && <small>没有已知项目</small>}
            </div>
            <button
              type="button"
              className="workspace-context-new"
              onClick={() => {
                setOpen(false);
                onPickWorkspace();
              }}
            >
              打开其他文件夹…
            </button>
          </div>
        )}
      </div>
      {branchLabel !== "" && (
        <span className="chip chip-branch" title="当前分支">
          <GitBranch size={13} strokeWidth={1.75} />
          <span>{branchLabel}</span>
        </span>
      )}
    </div>
  );
}

export function CoreComposerModelPicker({
  handle,
  sessionId,
}: {
  readonly handle: SessionHandle | null;
  readonly sessionId: string | null;
}): ReactNode {
  const sessionService = useFrontendService("sessionService");
  const sessionState = useSessionState();
  const { snapshot: handleSnap } = useSessionHandle(sessionId);
  const [open, setOpen] = useState(false);

  const model = handleSnap?.model ?? sessionState?.model ?? null;
  const models = handleSnap?.availableModels ?? sessionState?.availableModels ?? [];
  const thinkingLevel = handleSnap?.thinkingLevel ?? sessionState?.thinkingLevel ?? "medium";
  const thinkingLevels = handleSnap?.availableThinkingLevels ?? sessionState?.availableThinkingLevels ?? [];
  const isSwitching = sessionState?.isSwitchingModel ?? false;

  const modelLabel = model !== null ? (model.name || model.id) : "选择模型";

  return (
    <div className="model-picker-wrap">
      <button
        type="button"
        className={`chip chip-model${open ? " active" : ""}`}
        disabled={isSwitching}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`当前模型：${modelLabel}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{modelLabel}</span>
        {thinkingLevel !== "" && thinkingLevel !== "off" && (
          <span className="chip-model-thinking">{thinkingLevel}</span>
        )}
        <ChevronDown size={11} strokeWidth={1.75} />
      </button>
      {open && (
        <div className="model-picker-menu" role="menu" aria-label="选择模型">
          {models.map((candidate) => {
            const selected =
              model !== null && model.provider === candidate.provider && model.id === candidate.id;
            return (
              <button
                key={`${candidate.provider}:${candidate.id}`}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={selected ? "active" : ""}
                onClick={() => {
                  setOpen(false);
                  if (handle !== null) {
                    void handle.setModel(candidate);
                  } else {
                    void sessionService?.setModel(candidate);
                  }
                }}
              >
                <span>{candidate.name || candidate.id}</span>
                {selected && <Check size={13} />}
              </button>
            );
          })}
          {thinkingLevels.length > 0 && (
            <div className="model-thinking-row" role="group" aria-label="思考深度">
              {thinkingLevels.map((level) => (
                <button
                  key={level}
                  type="button"
                  className={level === thinkingLevel ? "active" : ""}
                  onClick={() => {
                    if (handle !== null) {
                      void handle.setThinkingLevel(level);
                    } else {
                      void sessionService?.setThinkingLevel(level);
                    }
                  }}
                >
                  {level}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
