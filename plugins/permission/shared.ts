export const PERMISSION_ENVELOPE_KEY = "__qianjiPermission";
export const PERMISSION_PLACEHOLDER = "__qianjiPermission__";
export const PERMISSION_GRANTS_NAMESPACE = "qianji-permission-grants";
export const CORE_PERMISSIONS_NAMESPACE = "qianji-permissions";
export const LEGACY_PERMISSIONS_NAMESPACE = "pid-permissions";

export type RiskLevel = "low" | "medium" | "high";
export type PermissionDecisionKind = "allow_once" | "allow_session" | "allow_always" | "deny";
export type PermissionModeValue = "read-only" | "ask" | "workspace-write" | "full-access";
export type AgentModeValue = "agent" | "plan" | "ask";

export interface PermissionGrantSpec {
  toolPattern: string;
  commandPrefix?: string;
  exactCommand?: string;
  pathPrefix?: string;
  label: string;
}

export interface PermissionGrantRule extends PermissionGrantSpec {
  id: string;
  createdAt: number;
}

export interface PermissionPromptEnvelope {
  source: "tool_guard" | "agent_request";
  title: string;
  message: string;
  toolName?: string;
  command?: string;
  targetPath?: string;
  cwd?: string;
  reason?: string;
  requestedPermission?: PermissionModeValue;
  requestedAgentMode?: AgentModeValue;
  riskLevel: RiskLevel;
  riskLabel: string;
  showRiskBadge: boolean;
  suggestedGrant?: PermissionGrantSpec;
  allowSessionOption: boolean;
  allowAlwaysOption: boolean;
  allowDenyFeedback: boolean;
}

export interface PermissionPromptResponse {
  decision: PermissionDecisionKind;
  feedback?: string;
}

export interface RequestPermissionResultPayload {
  status: "granted" | "denied" | "unattended";
  scope: "mode" | "tool";
  decision?: PermissionDecisionKind;
  reason: string;
  requestedPermission?: PermissionModeValue;
  requestedAgentMode?: AgentModeValue;
  grantLabel?: string;
  feedback?: string;
  message: string;
}

export interface PermissionInspectResult {
  modes: {
    permission: PermissionModeValue;
    agentMode: AgentModeValue;
    effective: PermissionModeValue;
  };
  sessionGrants: PermissionGrantRule[];
  alwaysRules: PermissionGrantRule[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SHELL_TOOLS = new Set(["bash", "powershell", "shell", "exec"]);
const WRITE_TOOLS = new Set(["write", "edit", "apply_patch"]);
const SUBCOMMAND_BINS = new Set([
  "git",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "cargo",
  "go",
  "docker",
  "kubectl",
  "python",
  "python3",
  "node",
  "pytest",
  "vitest",
  "npx",
  "pip",
  "uv",
  "dotnet",
  "gh",
]);
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);

export function isShellToolName(toolName: string): boolean {
  return SHELL_TOOLS.has(toolName.trim().toLowerCase());
}

export function isWriteToolName(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName.trim().toLowerCase());
}

export function normalizeSlashPath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function extractPrimaryPath(args: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file", "filePath", "target"]) {
    if (typeof args[key] === "string" && args[key].trim() !== "") {
      return args[key].trim();
    }
  }
  for (const key of ["paths", "files", "targets"]) {
    const arr = args[key];
    if (Array.isArray(arr)) {
      const first = arr.find((item): item is string => typeof item === "string" && item.trim() !== "");
      if (first !== undefined) return first.trim();
    }
  }
  return undefined;
}

export function extractShellCommand(args: Record<string, unknown>): string | undefined {
  if (typeof args.command === "string" && args.command.trim() !== "") {
    return args.command.trim();
  }
  return undefined;
}

export function hasShellHazardOrRedirect(command: string): boolean {
  return /`|\$\(|>>?|<|\r|\n/.test(command);
}

export function isCompoundShellCommand(command: string): boolean {
  return /&&|\|\||[;|\n]/.test(command);
}

export function deriveCommandPrefix(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed === "" || hasShellHazardOrRedirect(trimmed) || isCompoundShellCommand(trimmed)) {
    return null;
  }
  const tokens = trimmed
    .split(/\s+/)
    .map((tok) => tok.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const rawBin = tokens[0] ?? "";
  const baseBin = (rawBin.split(/[\\/]/).pop() ?? rawBin).replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
  if (baseBin === "") return null;

  if (!SUBCOMMAND_BINS.has(baseBin)) {
    return rawBin;
  }

  let idx = 1;
  while (idx < tokens.length && (tokens[idx] ?? "").startsWith("-")) {
    const flag = tokens[idx] ?? "";
    idx += flag === "-C" || flag === "-c" ? 2 : 1;
  }
  const sub = tokens[idx];
  if (!sub) return rawBin;

  // Include script name for `npm run <script>` so allowing `npm run test` never auto-allows `npm run deploy`.
  if (SCRIPT_RUNNERS.has(baseBin) && sub.toLowerCase() === "run" && tokens[idx + 1] && !(tokens[idx + 1] ?? "").startsWith("-")) {
    return tokens.slice(0, idx + 2).join(" ");
  }
  return tokens.slice(0, idx + 1).join(" ");
}

const HIGH_RISK_SHELL_RE =
  /\b(rm\s+-r|rm\s+-f|del\s+\/|rmdir|remove-item|git\s+reset\s+--hard|git\s+clean|git\s+push|drop\s+table|truncate\s+table|format\s+[a-z]:|sudo\s+|shutdown|reboot|reg\s+delete|sc\s+delete)\b/i;

const LOW_RISK_SHELL_RE =
  /^(git\s+(status|diff|log|show|branch)|npm\s+(test|run\s+(test|lint|typecheck|check))|pnpm\s+(test|lint|typecheck)|vitest|pytest|cargo\s+(check|test)|go\s+test|tsc\b|Get-ChildItem\b|ls\b|pwd\b)/i;

export function assessPermissionRisk(options: {
  toolName?: string;
  command?: string;
  message?: string;
  requestedPermission?: PermissionModeValue;
}): { riskLevel: RiskLevel; riskLabel: string } {
  if (options.requestedPermission === "full-access") {
    return { riskLevel: "high", riskLabel: "高风险 · 完全访问" };
  }
  const tool = (options.toolName ?? "").toLowerCase();
  const cmd = (options.command ?? "").trim();
  const msg = options.message ?? "";

  if (msg.includes("工作区以外") || msg.toLowerCase().includes("outside workspace")) {
    return { riskLevel: "high", riskLabel: "高风险 · 工作区外路径" };
  }
  if (tool.startsWith("computer")) {
    return { riskLevel: "high", riskLabel: "高风险 · 桌面键鼠控制" };
  }
  if (cmd !== "") {
    if (HIGH_RISK_SHELL_RE.test(cmd)) {
      return { riskLevel: "high", riskLabel: "高风险 · 破坏性/远端命令" };
    }
    if (!hasShellHazardOrRedirect(cmd) && !isCompoundShellCommand(cmd) && LOW_RISK_SHELL_RE.test(cmd)) {
      return { riskLevel: "low", riskLabel: "低风险 · 检查/测试命令" };
    }
    return { riskLevel: "medium", riskLabel: "中风险 · 终端命令" };
  }
  if (isWriteToolName(tool)) {
    return { riskLevel: "medium", riskLabel: "常规变更 · 文件写入" };
  }
  return { riskLevel: "medium", riskLabel: "常规权限确认" };
}

export function deriveSuggestedGrant(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): { spec: PermissionGrantSpec; allowAlways: boolean } {
  const lowerTool = toolName.trim().toLowerCase();

  if (isShellToolName(lowerTool)) {
    const command = extractShellCommand(args) ?? "";
    const prefix = deriveCommandPrefix(command);
    if (prefix !== null) {
      const highRisk = HIGH_RISK_SHELL_RE.test(command);
      return {
        spec: {
          toolPattern: "bash|powershell|shell|exec",
          commandPrefix: prefix,
          label: `命令前缀 "${prefix}"`,
        },
        allowAlways: !highRisk,
      };
    }
    return {
      spec: {
        toolPattern: "bash|powershell|shell|exec",
        exactCommand: command,
        label: `完全相同命令`,
      },
      allowAlways: false,
    };
  }

  if (isWriteToolName(lowerTool)) {
    const targetPath = extractPrimaryPath(args);
    const normRoot = normalizeSlashPath(cwd);
    let dirScope = "*";
    if (targetPath) {
      const normTarget = normalizeSlashPath(targetPath);
      const rel =
        normRoot !== "" && normTarget.startsWith(`${normRoot}/`)
          ? normTarget.slice(normRoot.length + 1)
          : !/^[a-z]:\//i.test(normTarget) && !normTarget.startsWith("/")
            ? normTarget
            : "";
      const firstSeg = rel.split("/").filter(Boolean)[0];
      if (firstSeg && rel.includes("/")) {
        dirScope = firstSeg;
      }
    }
    return {
      spec: {
        toolPattern: "write|edit|apply_patch",
        pathPrefix: dirScope,
        label: dirScope === "*" ? "工作区内文件编辑" : `${dirScope}/ 目录文件编辑`,
      },
      allowAlways: dirScope !== "*",
    };
  }

  return {
    spec: {
      toolPattern: lowerTool,
      label: `工具 ${toolName}`,
    },
    allowAlways: !lowerTool.startsWith("computer"),
  };
}

function toolMatchesPattern(toolName: string, pattern: string): boolean {
  const lower = toolName.trim().toLowerCase();
  for (const part of pattern.split("|")) {
    const clean = part.trim().toLowerCase();
    if (clean === "") continue;
    if (clean === "*" || clean === lower) return true;
    const regexStr = clean.replace(/[.+?^${}()[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    if (new RegExp(`^${regexStr}$`).test(lower)) return true;
  }
  return false;
}

function singleSegmentMatchesPrefix(segment: string, prefix: string): boolean {
  const segLower = segment.trim().toLowerCase();
  const prefLower = prefix.trim().toLowerCase();
  if (segLower === "" || prefLower === "") return false;
  return segLower === prefLower || segLower.startsWith(`${prefLower} `) || segLower.startsWith(`${prefLower}\t`);
}

function pathMatchesScope(targetPath: string | undefined, pathPrefix: string, cwd: string): boolean {
  if (pathPrefix === "*") {
    if (!targetPath) return true;
    const normTarget = normalizeSlashPath(targetPath);
    if (!/^[a-z]:\//i.test(normTarget) && !normTarget.startsWith("/")) {
      return !normTarget.startsWith("..");
    }
    const normRoot = normalizeSlashPath(cwd);
    return normRoot !== "" && (normTarget === normRoot || normTarget.startsWith(`${normRoot}/`));
  }
  if (!targetPath) return false;
  const normRoot = normalizeSlashPath(cwd);
  const resolvedTarget =
    /^[a-z]:\//i.test(normalizeSlashPath(targetPath)) || targetPath.startsWith("/")
      ? normalizeSlashPath(targetPath)
      : normalizeSlashPath(`${normRoot}/${targetPath}`);
  const resolvedPrefix =
    /^[a-z]:\//i.test(normalizeSlashPath(pathPrefix)) || pathPrefix.startsWith("/")
      ? normalizeSlashPath(pathPrefix)
      : normalizeSlashPath(`${normRoot}/${pathPrefix}`);
  return resolvedTarget === resolvedPrefix || resolvedTarget.startsWith(`${resolvedPrefix}/`);
}

export function matchesGrantRules(
  rules: readonly PermissionGrantSpec[],
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): PermissionGrantSpec | undefined {
  if (rules.length === 0) return undefined;
  const applicable = rules.filter((r) => toolMatchesPattern(toolName, r.toolPattern));
  if (applicable.length === 0) return undefined;

  if (isShellToolName(toolName)) {
    const command = extractShellCommand(args) ?? "";
    if (command === "") return undefined;
    const exactHit = applicable.find((r) => r.exactCommand !== undefined && r.exactCommand === command);
    if (exactHit !== undefined) return exactHit;

    // Never auto-approve commands containing subshells or file redirections via prefix rules.
    if (hasShellHazardOrRedirect(command)) return undefined;

    const segments = command
      .split(/&&|\|\||[;|\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length === 0) return undefined;

    let firstMatched: PermissionGrantSpec | undefined;
    for (const seg of segments) {
      const segRule = applicable.find(
        (r) => r.commandPrefix !== undefined && singleSegmentMatchesPrefix(seg, r.commandPrefix),
      );
      if (segRule === undefined) return undefined;
      firstMatched ??= segRule;
    }
    return firstMatched;
  }

  const targetPath = extractPrimaryPath(args);
  for (const rule of applicable) {
    if (rule.pathPrefix !== undefined) {
      if (pathMatchesScope(targetPath, rule.pathPrefix, cwd)) return rule;
      continue;
    }
    if (rule.commandPrefix === undefined && rule.exactCommand === undefined) {
      return rule;
    }
  }
  return undefined;
}

export function serializePermissionEnvelope(envelope: PermissionPromptEnvelope): string {
  return JSON.stringify({
    [PERMISSION_ENVELOPE_KEY]: 1,
    ...envelope,
  });
}

export function parsePermissionEnvelopeFromRequest(
  request: Record<string, unknown>,
): PermissionPromptEnvelope | null {
  if (request.method !== "input") return null;
  const title = typeof request.title === "string" ? request.title : "";
  const placeholder = typeof request.placeholder === "string" ? request.placeholder : "";
  if (placeholder !== PERMISSION_PLACEHOLDER && !title.includes(PERMISSION_ENVELOPE_KEY)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(title);
    if (!isRecord(parsed) || parsed[PERMISSION_ENVELOPE_KEY] !== 1) return null;
    if (typeof parsed.title !== "string" || typeof parsed.message !== "string") return null;
    return parsed as unknown as PermissionPromptEnvelope;
  } catch {
    return null;
  }
}

export function serializePermissionResponse(response: PermissionPromptResponse): string {
  return JSON.stringify(response);
}

export function parsePermissionResponse(raw: unknown): PermissionPromptResponse {
  if (raw === true || raw === "yes" || raw === "allow") {
    return { decision: "allow_once" };
  }
  if (raw === undefined || raw === null || raw === false) {
    return { decision: "deny" };
  }
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && typeof parsed.decision === "string") {
        const d = parsed.decision;
        if (d === "allow_once" || d === "allow_session" || d === "allow_always" || d === "deny") {
          const feedback =
            typeof parsed.feedback === "string" && parsed.feedback.trim() !== ""
              ? parsed.feedback.trim()
              : undefined;
          return {
            decision: d,
            ...(feedback === undefined ? {} : { feedback }),
          };
        }
      }
    } catch {
      // Fall through to safe deny.
    }
  }
  return { decision: "deny" };
}

export function parseConfirmDiffSegments(message: string): {
  before: string;
  diffLines: string[] | null;
  after: string;
} {
  const lfStart = message.indexOf("```diff\n");
  const crlfStart = lfStart < 0 ? message.indexOf("```diff\r\n") : -1;
  const start = lfStart >= 0 ? lfStart : crlfStart;
  if (start < 0) return { before: message, diffLines: null, after: "" };
  const bodyStart = start + (lfStart >= 0 ? "```diff\n".length : "```diff\r\n".length);
  const fenceEnd = message.indexOf("\n```", bodyStart);
  if (fenceEnd < 0) return { before: message, diffLines: null, after: "" };
  return {
    before: message.slice(0, start).trim(),
    diffLines: message.slice(bodyStart, fenceEnd).replace(/\r\n/g, "\n").split("\n"),
    after: message.slice(fenceEnd + "\n```".length).trim(),
  };
}

export function parseRequestPermissionResult(rawResult: unknown): RequestPermissionResultPayload | null {
  if (typeof rawResult !== "string" || rawResult.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(rawResult);
    if (!isRecord(parsed) || typeof parsed.status !== "string" || typeof parsed.reason !== "string") {
      return null;
    }
    return parsed as unknown as RequestPermissionResultPayload;
  } catch {
    return null;
  }
}
