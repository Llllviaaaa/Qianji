/**
 * Workspace breadcrumb trail and model/thinking picker controls for
 * `core-composer` (ADR 0023 Wave 2B).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Folder, GitBranch, Monitor, Search } from "lucide-react";
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
  quickChat = false,
  environment = "local",
  onSelectWorkspace,
  onPickWorkspace,
  onQuickChat,
  onEnvironmentChange,
}: {
  readonly workspace: string;
  readonly workspaceOptions: readonly string[];
  readonly branchLabel: string;
  readonly quickChat?: boolean;
  readonly environment?: "local" | "worktree";
  readonly onSelectWorkspace: (next: string) => void;
  readonly onPickWorkspace: () => void;
  readonly onQuickChat?: () => void;
  readonly onEnvironmentChange?: (next: "local" | "worktree") => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  const [query, setQuery] = useState("");
  const workspaceWrapRef = useRef<HTMLDivElement>(null);
  const envWrapRef = useRef<HTMLDivElement>(null);

  const isDefaultWorkspaceMode = quickChat || workspace.trim() === "";
  const workspaceName = isDefaultWorkspaceMode ? "默认工作区" : formatWorkspaceName(workspace);

  useEffect(() => {
    if ((!open && !envOpen) || typeof document === "undefined") return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (open && (workspaceWrapRef.current === null || !workspaceWrapRef.current.contains(target))) {
        setOpen(false);
        setQuery("");
      }
      if (envOpen && (envWrapRef.current === null || !envWrapRef.current.contains(target))) {
        setEnvOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (open) {
        setOpen(false);
        setQuery("");
        event.stopPropagation();
      } else if (envOpen) {
        setEnvOpen(false);
        event.stopPropagation();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [envOpen, open]);

  const visibleWorkspaces = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return workspaceOptions
      .filter((item, idx, all) => item !== "" && all.indexOf(item) === idx)
      .filter((item) => normalized === "" || item.toLowerCase().includes(normalized))
      .slice(0, 8);
  }, [query, workspaceOptions]);

  return (
    <div className="composer-breadcrumb-trail" aria-label="项目与工作环境">
      <div className="workspace-context-wrap" ref={workspaceWrapRef}>
        <button
          type="button"
          className="chip chip-project"
          title={isDefaultWorkspaceMode ? "默认工作区（快速对话）" : workspace}
          aria-expanded={open}
          onClick={() => {
            setEnvOpen(false);
            setOpen((value) => !value);
          }}
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
                autoFocus
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
                  {!isDefaultWorkspaceMode && item === workspace && <Check size={13} />}
                </button>
              ))}
              {visibleWorkspaces.length === 0 && <small>没有已知项目</small>}
            </div>
            <button
              type="button"
              className="workspace-context-new"
              onClick={() => {
                setOpen(false);
                setQuery("");
                onPickWorkspace();
              }}
            >
              打开其他文件夹…
            </button>
            {onQuickChat !== undefined && (
              <button
                type="button"
                className="workspace-context-new"
                onClick={() => {
                  setOpen(false);
                  setQuery("");
                  onQuickChat();
                }}
              >
                <span>默认工作区（快速对话）</span>
                {isDefaultWorkspaceMode && <Check size={13} />}
              </button>
            )}
          </div>
        )}
      </div>

      {!isDefaultWorkspaceMode && onEnvironmentChange !== undefined && (
        <div className="environment-context-wrap" ref={envWrapRef}>
          <button
            type="button"
            className={`chip chip-env ${environment === "worktree" ? "worktree" : "local"}`}
            title={environment === "worktree" ? "Worktree 隔离检出" : "本地工作区"}
            aria-haspopup="menu"
            aria-expanded={envOpen}
            onClick={() => {
              setOpen(false);
              setEnvOpen((value) => !value);
            }}
          >
            {environment === "worktree" ? <GitBranch size={13} /> : <Monitor size={13} />}
            <span>{environment === "worktree" ? "Worktree" : "本地"}</span>
            <ChevronDown size={11} strokeWidth={1.75} />
          </button>
          {envOpen && (
            <div className="workspace-context-menu environment-context-menu" role="menu">
              <div className="workspace-context-list">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onEnvironmentChange("local");
                    setEnvOpen(false);
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
                    onEnvironmentChange("worktree");
                    setEnvOpen(false);
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

      {!isDefaultWorkspaceMode && branchLabel !== "" && (
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
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || typeof document === "undefined") return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target !== null && wrapRef.current !== null && wrapRef.current.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        event.stopPropagation();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const model = handleSnap?.model ?? sessionState?.model ?? null;
  const models = handleSnap?.availableModels ?? sessionState?.availableModels ?? [];
  const thinkingLevel = handleSnap?.thinkingLevel ?? sessionState?.thinkingLevel ?? "medium";
  const thinkingLevels = handleSnap?.availableThinkingLevels ?? sessionState?.availableThinkingLevels ?? [];
  const isSwitching = sessionState?.isSwitchingModel ?? false;

  const modelLabel = model !== null ? (model.name || model.id) : "选择模型";

  return (
    <div className="model-picker-wrap" ref={wrapRef}>
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
