// Slash commands (ADR 0002, 0003).

export interface CommandInfo {
  name: string;
  description: string;
  argsHint?: string;
  source: string;
}

export interface CommandListParams {
  cwd?: string;
}

export interface CommandListResult {
  commands: CommandInfo[];
}

export interface CommandRunParams {
  name: string;
  args?: string;
  sessionId?: string;
  cwd?: string;
}

export interface CommandRunResult {
  handled: boolean;
  output?: string;
  prompt?: string;
  clientAction?: "clear" | "compact";
  isError?: boolean;
}

/** Notification `command/changed`. */
export interface CommandChangedNotification {
  reason: string;
}

// Memory 2.0 & Skills Lifecycle (M3).

export type MemoryScope = "user" | "project";

export interface MemoryGetParams {
  scope?: MemoryScope;
  cwd?: string;
}

export interface MemoryGetResult {
  scope: MemoryScope;
  path: string;
  content: string;
  trusted: boolean;
}

export interface MemorySetParams {
  scope?: MemoryScope;
  cwd?: string;
  content: string;
}

export interface MemoryDeleteParams {
  scope?: MemoryScope;
  cwd?: string;
}

export interface MemoryExportParams {
  scope?: MemoryScope;
  cwd?: string;
  destination: string;
}

export interface MemoryExportResult {
  path: string;
}

export type SkillScope = "builtin" | "user" | "project";

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  scope: SkillScope;
  enabled: boolean;
  trusted: boolean;
  readOnly?: boolean;
}

export interface SkillListParams {
  cwd?: string;
}

export interface SkillListResult {
  skills: SkillInfo[];
}

export interface SkillReadParams {
  path: string;
  cwd?: string;
}

export interface SkillReadResult {
  path: string;
  content: string;
  name: string;
  description: string;
}

export interface SkillCreateParams {
  scope: "user" | "project";
  cwd?: string;
  name: string;
  description: string;
  body?: string;
}

export interface SkillCreateResult {
  skill: SkillInfo;
  content: string;
}

export interface SkillSaveParams {
  path: string;
  cwd?: string;
  content: string;
}

export interface SkillToggleParams {
  path: string;
  cwd?: string;
  enabled: boolean;
}

export interface SkillDeleteParams {
  path: string;
  cwd?: string;
}

export type SandboxConfigKind = "wsb" | "devcontainer";

export interface SandboxGenerateConfigParams {
  kind: SandboxConfigKind;
  cwd: string;
  overwrite?: boolean;
}

export interface SandboxGenerateConfigResult {
  kind: SandboxConfigKind;
  path: string;
  content: string;
}

// Unified native workbench (Stage 3).

export type BuiltinWorkbenchOpenTarget =
  | "files"
  | "editor"
  | "review"
  | "preview"
  | "summary"
  | "side-chat"
  | "terminal";

export type WorkbenchOpenTarget = BuiltinWorkbenchOpenTarget | (string & {});

export interface WorkbenchOpenParams {
  sessionId?: string;
  cwd?: string;
  target: WorkbenchOpenTarget;
  path?: string;
  line?: number;
  endLine?: number;
  url?: string;
}

/** Notification `workbench/open`. */
export type WorkbenchOpenNotification = WorkbenchOpenParams;

export interface WorkbenchPreviewUrlParams {
  cwd: string;
  path: string;
}

export interface WorkbenchPreviewUrlResult {
  url: string | null;
  path: string;
}
