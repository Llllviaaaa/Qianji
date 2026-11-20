/**
 * Workspace directory tree rail for `CoreCodeWorkspacePane` (`core-workbench`, ADR 0023).
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Globe,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type { WorkbenchService, WorkspaceService } from "@qianji/client";

interface DirEntry {
  readonly name: string;
  readonly path: string;
  readonly isDir: boolean;
}

const CODE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "c", "cpp",
  "h", "hpp", "css", "scss", "json", "toml", "yaml", "yml", "sh", "ps1", "sql",
]);

function renderFileGlyph(fileName: string): ReactElement {
  const dot = fileName.lastIndexOf(".");
  const ext = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  if (ext === "html" || ext === "htm" || ext === "svg") {
    return <Globe size={14} className="pid-wb-icon-file is-web" />;
  }
  if (CODE_EXTS.has(ext)) {
    return <FileCode2 size={14} className="pid-wb-icon-file is-code" />;
  }
  return <FileText size={14} className="pid-wb-icon-file" />;
}

function sortEntries(entries: readonly DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

export function CoreWorkspaceFileTree({
  cwd,
  activeFilePath,
  workspaceService,
  workbenchService,
}: {
  readonly cwd: string;
  readonly activeFilePath: string | null;
  readonly workspaceService: WorkspaceService | undefined;
  readonly workbenchService: WorkbenchService | undefined;
}): ReactElement {
  const [filterQuery, setFilterQuery] = useState("");
  const [rootEntries, setRootEntries] = useState<readonly DirEntry[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({});
  const [childDirs, setChildDirs] = useState<Record<string, readonly DirEntry[]>>({});
  const [loadedCwd, setLoadedCwd] = useState("");

  const loadRootDir = useCallback(async (targetCwd: string) => {
    if (workspaceService === undefined || targetCwd === "") return;
    try {
      const listed = await workspaceService.listDir(undefined, targetCwd);
      setRootEntries(sortEntries(listed));
      setLoadedCwd(targetCwd);
    } catch {
      setRootEntries([]);
      setLoadedCwd(targetCwd);
    }
  }, [workspaceService]);

  useEffect(() => {
    if (cwd === "" || cwd === loadedCwd || workspaceService === undefined) return;
    let cancelled = false;
    void workspaceService
      .listDir(undefined, cwd)
      .then((listed) => {
        if (cancelled) return;
        setRootEntries(sortEntries(listed));
        setLoadedCwd(cwd);
      })
      .catch(() => {
        if (cancelled) return;
        setRootEntries([]);
        setLoadedCwd(cwd);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, loadedCwd, workspaceService]);

  const toggleDir = useCallback(async (dirPath: string) => {
    const nextOpen = !expandedDirs[dirPath];
    setExpandedDirs((prev) => ({ ...prev, [dirPath]: nextOpen }));
    if (!nextOpen || childDirs[dirPath] !== undefined || workspaceService === undefined || cwd === "") return;
    try {
      const listed = await workspaceService.listDir(dirPath, cwd);
      setChildDirs((prev) => ({ ...prev, [dirPath]: sortEntries(listed) }));
    } catch {
      setChildDirs((prev) => ({ ...prev, [dirPath]: [] }));
    }
  }, [childDirs, cwd, expandedDirs, workspaceService]);

  const filteredRoot = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    if (q === "") return rootEntries;
    return rootEntries.filter((entry) => entry.name.toLowerCase().includes(q) || entry.path.toLowerCase().includes(q));
  }, [filterQuery, rootEntries]);

  const renderTree = (entries: readonly DirEntry[], depth: number): ReactElement => (
    <ul className="pid-wb-tree-list" role={depth === 0 ? "tree" : "group"}>
      {entries.map((entry) => {
        const isOpen = expandedDirs[entry.path] === true;
        const children = childDirs[entry.path] ?? [];
        const selected = !entry.isDir && activeFilePath === entry.path;
        return (
          <li key={entry.path} className="pid-wb-tree-item" role="treeitem" aria-expanded={entry.isDir ? isOpen : undefined}>
            <div className={`pid-wb-tree-row${selected ? " active" : ""}`} style={{ paddingLeft: `${8 + depth * 14}px` }}>
              <button
                type="button"
                className="pid-wb-tree-main"
                title={entry.path}
                onClick={() => {
                  if (entry.isDir) void toggleDir(entry.path);
                  else void workbenchService?.openFile(entry.path, { cwd });
                }}
              >
                {entry.isDir ? (
                  <>
                    <span className="pid-wb-tree-chevron">
                      {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    </span>
                    {isOpen ? <FolderOpen size={14} className="pid-wb-icon-folder" /> : <Folder size={14} className="pid-wb-icon-folder" />}
                  </>
                ) : (
                  <>
                    <span className="pid-wb-tree-chevron" />
                    {renderFileGlyph(entry.name)}
                  </>
                )}
                <span className="pid-wb-tree-name">{entry.name}</span>
              </button>
            </div>
            {entry.isDir && isOpen && children.length > 0 && renderTree(children, depth + 1)}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="pid-wb-file-tree-rail" aria-label="工作区文件树">
      <div className="pid-wb-pane">
        <div className="pid-wb-subbar pid-wb-tree-filterbar">
          <div className="pid-wb-search-box is-flat">
            <Search size={13} className="pid-wb-search-icon" />
            <input
              type="text"
              className="pid-wb-search-input"
              placeholder="筛选文件…"
              value={filterQuery}
              onChange={(event) => setFilterQuery(event.target.value)}
            />
            {filterQuery !== "" && (
              <button type="button" className="pid-wb-icon-btn" title="清除筛选" onClick={() => setFilterQuery("")}>
                <X size={13} />
              </button>
            )}
          </div>
          <button type="button" className="pid-wb-icon-btn" title="刷新目录" onClick={() => void loadRootDir(cwd)}>
            <RefreshCw size={12} />
          </button>
        </div>
        <div className="pid-wb-scroll">
          {cwd === "" ? (
            <div className="pid-wb-empty">先打开一个项目工作区以浏览文件。</div>
          ) : filteredRoot.length === 0 ? (
            <div className="pid-wb-empty">此工作区中暂无匹配文件</div>
          ) : (
            renderTree(filteredRoot, 0)
          )}
        </div>
      </div>
    </div>
  );
}
