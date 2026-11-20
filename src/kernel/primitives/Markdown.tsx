import { useContext, useMemo, type ReactElement } from "react";
import {
  Markdown as HostMarkdown,
  WorkspaceFileOpenContext,
  type OpenWorkspaceFile,
} from "../../components/Markdown";
import { cn } from "../../components/ui/cn";
import { resolveWorkspacePath } from "../../lib/workspaceEditors";
import type { MarkdownProps } from "./types";

/**
 * SemVer-stable public `Markdown` primitive wrapping Qianji's renderer without
 * exposing host-private context internals (`WorkspaceFileOpenContext`).
 */
export function Markdown({
  content,
  className,
  cwd,
  onOpenFile,
  allowRichContent = false,
  isStreaming = false,
}: MarkdownProps): ReactElement {
  const inheritedOpenFile = useContext(WorkspaceFileOpenContext);

  const resolvedOpenFile = useMemo<OpenWorkspaceFile | null>(() => {
    const baseHandler = onOpenFile ?? inheritedOpenFile;
    if (baseHandler === null) return null;
    const normalizedCwd = cwd?.trim() ?? "";
    if (normalizedCwd === "") {
      return baseHandler;
    }
    return (filePath: string, line?: number) => {
      baseHandler(resolveWorkspacePath(normalizedCwd, filePath), line);
    };
  }, [cwd, inheritedOpenFile, onOpenFile]);

  const rendered = (
    <HostMarkdown
      content={content}
      allowRichContent={allowRichContent}
      isStreaming={isStreaming}
    />
  );

  return (
    <div className={cn("qj-markdown", className)} data-qj-primitive="markdown">
      {resolvedOpenFile !== null ? (
        <WorkspaceFileOpenContext.Provider value={resolvedOpenFile}>
          {rendered}
        </WorkspaceFileOpenContext.Provider>
      ) : (
        rendered
      )}
    </div>
  );
}
