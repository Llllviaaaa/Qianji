/**
 * Taken from the Pi engine's pidesktop-rules.ts, which went with Pi in P6c (ADR 0009).
 */
import { inspectSelfKillCommand, isSelfKillCommand } from "@qianji/protocol";
import {
  commandMatchesAllowPrefix,
  insideWorkspace,
  matchingToolRule,
  parseAllowPrefixes,
  parseToolRules,
  pathsFromToolInput,
  resolveAgainstWorkspace,
  shellCommandFromInput,
  isForcePush,
  type PermissionRules,
} from "./helpers.ts";

export { inspectSelfKillCommand, isSelfKillCommand };
export * from "./helpers.ts";

export type PermissionMode = "read-only" | "ask" | "workspace-write" | "full-access";
export type AgentMode = "agent" | "plan" | "ask";

export function normalizeAgentMode(value: string | undefined | null): AgentMode {
  return value === "plan" || value === "ask" ? value : "agent";
}

export function normalizePermissionMode(value: string | undefined | null): PermissionMode {
  return value === "read-only" || value === "workspace-write" || value === "full-access" ? value : "ask";
}

export function shouldConfirmInteractiveAction(
  permissionMode: string | undefined | null,
  confirmActions: boolean,
): boolean {
  return confirmActions && normalizePermissionMode(permissionMode) !== "full-access";
}

export function permissionForAgentMode(agentMode: AgentMode, permissionMode: PermissionMode): PermissionMode {
  return agentMode === "agent" ? permissionMode : "read-only";
}

export function agentModeSystemInstructions(mode: AgentMode): string {
  if (mode === "ask") {
    return "Qianji mode: Ask. Investigate with read-only tools and answer the user's question. Do not edit files, run shell commands, or perform side-effecting actions.";
  }
  if (mode === "plan") {
    return "Qianji mode: Plan. Investigate with read-only tools, record the proposed ordered steps with update_plan, then produce an implementation-ready plan with affected files, key symbols, risks, and verification. Do not edit files, run shell commands, or perform side-effecting actions.";
  }
  return "";
}

export type ToolDecision =
  | { action: "allow" }
  | { action: "block"; reason: string }
  | { action: "confirm"; title: string; message: string };

/** Keep web search inline unless the caller explicitly requests a curator workflow. */
export function applyDesktopToolDefaults(toolName: string, input: Record<string, unknown>): void {
  if (toolName.toLowerCase() === "web_search" && input.workflow === undefined) {
    input.workflow = "none";
  }
}

/**
 * Decide whether a model tool call is allowed, blocked, or needs confirmation.
 * Read-only is a hard cap. Explicit tool rules then apply before the mode defaults.
 */
export function evaluateToolPermission(options: {
  mode: PermissionMode;
  rules: PermissionRules;
  workspace: string;
  toolName: string;
  input: Record<string, unknown>;
  quickChat?: boolean;
  protectedPids?: ReadonlySet<number>;
  readOnlyTool?: boolean;
}): ToolDecision {
  const { mode, rules, workspace, input } = options;
  const tool = options.toolName.toLowerCase();
  const isWrite = tool === "write" || tool === "edit" || tool === "apply_patch";
  const isShell = tool === "bash" || tool === "powershell" || tool === "shell" || tool === "exec";
  const action = typeof input.action === "string" ? input.action.toLowerCase() : "";
  const isBrowserTool = tool === "browser" || tool.startsWith("browser_");
  const isComputerTool = tool === "computer" || tool.startsWith("computer_");
  const isInteractiveBrowser = tool === "browser_click"
    || tool === "browser_type"
    || tool === "browser_press"
    || tool === "browser_select"
    || tool === "browser_upload"
    || tool === "browser_navigate"
    || (tool === "browser_tabs" && action !== "list" && action !== "")
    || (tool === "browser" && ["open", "new_tab", "close_tab", "click", "type", "press", "select", "upload", "download", "close"].includes(action));
  const isBrowserDownload = tool === "browser_upload" || (tool === "browser" && action === "download");
  const isInteractiveComputer = tool === "computer_click"
    || tool === "computer_move"
    || tool === "computer_scroll"
    || tool === "computer_type"
    || tool === "computer_key"
    || (tool === "computer_start" && (typeof input.mode === "string" ? input.mode.toLowerCase() : "") === "control")
    || (tool === "computer" && [
      "focus_window",
      "move",
      "click",
      "double_click",
      "drag",
      "scroll",
      "type",
      "key",
      "keypress",
      "invoke",
      "set_value",
      "toggle",
      "select",
      "focus_element",
      "scroll_element",
    ].includes(action));
  const isMcpTool = tool.startsWith("mcp__");
  const isSubagent = tool === "delegate_task" || tool === "spawn_agent";
  const isSubagentControl = tool === "send_input" || tool === "wait_agent" || tool === "close_agent";
  const isSwarmControl = tool === "swarm" || tool === "post_message" || tool === "swarm_tasks";
  const isSwarmWorktreeMerge = tool === "swarm"
    && (
      ["merge", "merge_worktree", "mergeworktree", "merge-worktree", "apply", "apply_worktree"].includes(action)
      || input.applyChanges === true
      || input.mergeWorktree === true
      || input.merge === true
    );
  const isMemoryRead = tool === "desktop_memory" && (action === "read" || action === "list" || action === "search");
  const isMemoryWrite = tool === "desktop_memory" && !isMemoryRead;
  const isBgProcess = tool === "bg_process";
  const isBgProcessRead = isBgProcess && (action === "list" || action === "logs" || action === "wait" || action === "");
  const isBgProcessStop = isBgProcess && !isBgProcessRead;
  const isPluginManagerRead = tool === "plugin_manager" && (action === "list" || action === "verify");
  const isPluginManagerWrite = tool === "plugin_manager" && !isPluginManagerRead;
  const subagentPermission = input.permission === "workspace-write" ? "workspace-write" : "read-only";
  const subagentAllowShell = input.allowShell === true;
  const subagentIsolateWorktree = input.isolateWorktree === true;
  const targets = pathsFromToolInput(input);
  const target = targets[0];
  const outsideTarget = (isWrite || isBrowserDownload)
    ? targets.find((candidate) => !insideWorkspace(candidate, workspace))
    : undefined;
  const command = shellCommandFromInput(input);
  const knownReadOnlyTools = new Set([
    "read",
    "grep",
    "find",
    "glob",
    "ls",
    "diagnostics",
    "view_image",
    "web_search",
    "web_fetch",
    "fetch",
    "update_plan",
    "sidebar_open",
    "render_ui",
    "update_ui",
    "activate_tools",
    "qianji_inspect",
    "question",
    "ask_question",
    "request_permission",
    "read_board",
    "swarm_wait",
    "mcp_list_resources",
    "mcp_read_resource",
    "mcp_subscribe_resource",
    "mcp_unsubscribe_resource",
    "mcp_list_prompts",
    "mcp_get_prompt",
  ]);
  const isDeclaredReadOnly = options.readOnlyTool === true
    && !isWrite
    && !isShell
    && !isInteractiveBrowser
    && !isInteractiveComputer
    && !isMemoryWrite
    && !isPluginManagerWrite
    && !isBgProcessStop
    && !isSwarmWorktreeMerge;
  const isKnownTool = isWrite
    || isShell
    || isBrowserTool
    || isComputerTool
    || isMcpTool
    || isSubagent
    || isSubagentControl
    || isSwarmControl
    || tool === "desktop_memory"
    || tool === "plugin_manager"
    || isBgProcess
    || isDeclaredReadOnly
    || knownReadOnlyTools.has(tool);

  if (options.quickChat && (["read", "write", "edit", "apply_patch", "grep", "find", "diagnostics", "bash", "powershell", "shell", "exec", "bg_process", "plugin_manager", "read_board", "swarm_wait"].includes(tool) || isSubagent || isSubagentControl || isSwarmControl)) {
    return { action: "block", reason: "Quick chat does not use local project files or shell commands" };
  }

  if (mode === "read-only" && (isWrite || isShell || isInteractiveBrowser || isInteractiveComputer || (isMcpTool && !isDeclaredReadOnly) || isMemoryWrite || isPluginManagerWrite || isBgProcessStop || isSwarmWorktreeMerge)) {
    return { action: "block", reason: "Qianji is in read-only mode" };
  }

  if (mode === "read-only" && isSubagent && subagentPermission !== "read-only") {
    return { action: "block", reason: "Qianji read-only mode only permits read-only subagents" };
  }

  if (mode === "read-only" && !isKnownTool) {
    return { action: "block", reason: `Qianji read-only mode blocks unclassified tool: ${tool}` };
  }

  // Workspace confinement is a hard cap, like read-only mode. A broad custom
  // allow rule must not silently override it.
  if (outsideTarget && rules.blockWriteOutsideWorkspace && mode !== "full-access") {
    const resolved = resolveAgainstWorkspace(outsideTarget, workspace);
    return {
      action: "block",
      reason: `${isBrowserDownload ? "Browser download" : "Write"} outside workspace blocked by rule: ${outsideTarget} → ${resolved}`,
    };
  }

  // Self-preservation holds in every mode (including full-access) and ahead of custom
  // allow rules so an agent cannot terminate qianji.exe or qianji-harness.exe.
  if (isShell) {
    const selfKillReason = inspectSelfKillCommand(command, options.protectedPids);
    if (selfKillReason !== undefined) {
      return { action: "block", reason: selfKillReason };
    }
  }

  // A force push rewrites history others may have; like workspace confinement it holds
  // in every mode and ahead of custom allow rules, until the user turns it on in settings.
  if (isShell && rules.allowForcePush !== true && isForcePush(command)) {
    return {
      action: "block",
      reason: "强制推送已被设置禁止（设置 → Git 与工程 → 允许强制推送）。需要改写远程分支时，请让用户先打开这个开关。",
    };
  }

  const customRule = matchingToolRule({ rules, workspace, toolName: tool, input });
  if (customRule) {
    if (customRule.action === "allow") return { action: "allow" };
    if (customRule.action === "block") {
      return { action: "block", reason: `Blocked by tool rule: ${customRule.id}` };
    }
    // Block rules stay a hard cap under full-access, but "confirm" means "ask me",
    // and full-access is the mode where the user asked not to be asked.
    if (mode === "full-access") return { action: "allow" };
    return {
      action: "confirm",
      title: "允许调用工具？",
      message: `${tool} 匹配了规则 ${customRule.id}`,
    };
  }

  if (mode === "full-access") {
    return { action: "allow" };
  }

  // Note: `desktop_memory` performs its own unified-diff confirmation via `ctx.ui.confirm`
  // when effective mode is `ask` or `workspace-write`, while `read-only` and custom
  // `toolRules` above still govern it here.

  if ((mode === "ask" || mode === "workspace-write") && isSubagent && subagentPermission === "workspace-write") {
    let message = "子代理可以在当前工作区读取、编辑和写入文件，但不能使用 Shell。";
    if (subagentAllowShell && subagentIsolateWorktree) {
      message = "子代理将在独立 Git Worktree 中修改文件并执行验证 Shell 命令，完成后尝试合并补丁。";
    } else if (subagentAllowShell) {
      message = "子代理可以在当前工作区读取、编辑和写入文件，并执行验证 Shell 命令。";
    } else if (subagentIsolateWorktree) {
      message = "子代理将在独立 Git Worktree 中读取、编辑和写入文件（不使用 Shell），完成后尝试合并补丁。";
    }
    return {
      action: "confirm",
      title: "允许子代理修改这个工作区？",
      message,
    };
  }

  if (isWrite && outsideTarget) {
    const resolved = resolveAgainstWorkspace(outsideTarget, workspace);
    return {
      action: "confirm",
      title: "写入工作区以外的位置？",
      message: `${tool}: ${outsideTarget}\n解析为：${resolved}\n\n工作区：${workspace}`,
    };
  }

  if (isWrite && targets.length === 0 && (mode === "ask" || mode === "workspace-write")) {
    return {
      action: "confirm",
      title: "允许修改未指定路径的文件？",
      message: `${tool}: ${JSON.stringify(input)}`,
    };
  }

  if (mode === "ask" && isWrite) {
    return {
      action: "confirm",
      title: "允许修改文件？",
      message: `${tool}: ${target || JSON.stringify(input)}`,
    };
  }

  if (isShell) {
    const allowlisted = commandMatchesAllowPrefix(command, rules.shellAllowPrefixes);
    // Allowlist only skips confirm when alwaysConfirmShell is off (ask / workspace-write).
    if (allowlisted && !rules.alwaysConfirmShell && (mode === "ask" || mode === "workspace-write")) {
      return { action: "allow" };
    }
    if (rules.alwaysConfirmShell || mode === "ask" || mode === "workspace-write") {
      return {
        action: "confirm",
        title: "允许执行命令？",
        message: command,
      };
    }
  }

  if (!isKnownTool && (mode === "ask" || mode === "workspace-write")) {
    return {
      action: "confirm",
      title: "允许调用未分类的工具？",
      message: `${tool}: ${JSON.stringify(input).slice(0, 1800)}`,
    };
  }

  return { action: "allow" };
}

export function rulesFromEnv(env: {
  alwaysConfirmShell?: string;
  blockWriteOutsideWorkspace?: string;
  shellAllowPrefixes?: string;
  toolRulesEncoded?: string;
}): PermissionRules {
  const always = env.alwaysConfirmShell;
  const block = env.blockWriteOutsideWorkspace;
  return {
    // Default on: always confirm shell unless explicitly disabled
    alwaysConfirmShell: always !== "0" && always !== "false",
    // Default on: block outside-workspace writes unless explicitly disabled
    blockWriteOutsideWorkspace: block !== "0" && block !== "false",
    shellAllowPrefixes: parseAllowPrefixes(env.shellAllowPrefixes),
    toolRules: parseToolRules(env.toolRulesEncoded),
  };
}
