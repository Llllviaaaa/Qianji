/**
 * Routes Bot-session tool execution (`bash`, `powershell`, `read`, `write`, `edit`,
 * `ls`, `find`, `grep`) into either the dedicated WSL2 Linux container (`qianji-bot-vm`)
 * or the authenticated OpenSSH remote server when active.
 */
import { isAbsolute, relative, posix } from "node:path";
import {
  applyEdits,
  formatHashlines,
  isHashlineEdit,
  MAX_BYTES,
  MAX_LINES,
  stripBom,
  truncateHead,
  type FileEdit,
} from "@qianji/tool-fs";
import { textOutput, type ToolCall, type ToolEnv, type ToolOutput } from "@qianji/tools";
import type { BotVirtualServerStatus } from "@qianji/protocol";
import type { SshExecResult, SshRemoteRuntime } from "./ssh-runtime.ts";
import type { WslContainerRuntime } from "./wsl-runtime.ts";

export const VM_BRIDGED_TOOLS = new Set([
  "bash",
  "powershell",
  "read",
  "write",
  "edit",
  "ls",
  "find",
  "grep",
]);

const IMAGE_EXTS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export interface VmBridgeDeps {
  status: BotVirtualServerStatus;
  hostWorkspaceDir: string;
  wsl: WslContainerRuntime;
  ssh: SshRemoteRuntime;
  getRemotePassword: () => Promise<string | undefined>;
}

export function resolveGuestPath(
  rawPath: string | undefined,
  workspaceRoot: string,
  hostWorkspaceDir: string,
): string {
  const input = (rawPath ?? ".").trim();
  if (input === "" || input === ".") return workspaceRoot;
  const slashInput = input.replace(/\\/g, "/");
  const relFromHost = relative(hostWorkspaceDir, input);
  if (relFromHost === "") return workspaceRoot;
  if (!relFromHost.startsWith("..") && !isAbsolute(relFromHost)) {
    return posix.join(workspaceRoot, relFromHost.replace(/\\/g, "/"));
  }
  if (slashInput === "~" || slashInput.startsWith("~/")) return slashInput;
  if (slashInput.startsWith("/")) return slashInput;
  return posix.normalize(posix.join(workspaceRoot, slashInput));
}

async function execInActiveVm(
  deps: VmBridgeDeps,
  command: string,
  guestCwd: string,
  timeoutMs?: number,
): Promise<SshExecResult> {
  const vs = deps.status;
  if (vs.mode === "remote") {
    const password = await deps.getRemotePassword();
    return deps.ssh.exec(vs.remote, command, { cwd: guestCwd, password, timeoutMs });
  }
  return deps.wsl.exec(command, {
    guestCwd,
    cpuCores: vs.local.cpuCores,
    memoryLimitGb: vs.local.memoryLimitGb,
    sharedFolders: vs.local.sharedFolders,
    timeoutMs,
  });
}

function formatShellOutput(res: SshExecResult): ToolOutput {
  const combined = [res.stdout.trimEnd(), res.stderr.trimEnd()].filter(Boolean).join("\n");
  const suffix = res.exitCode === 0 ? "" : `\n[exit code: ${res.exitCode ?? "terminated"}]`;
  const text = (combined || (res.exitCode === 0 ? "(completed with no output)" : "(failed with no output)")) + suffix;
  return textOutput(text, res.exitCode !== 0);
}

export async function executeBotToolInVm(
  call: ToolCall,
  _env: ToolEnv,
  deps: VmBridgeDeps,
): Promise<ToolOutput> {
  const vs = deps.status;
  const guestRoot =
    vs.mode === "remote" ? `${vs.remote.workDir.trim() || "~/.qianji-vm"}/workspace` : "/workspace";

  if (call.name === "bash" || call.name === "powershell") {
    const command = String(call.args.command ?? "");
    const rawTimeout = typeof call.args.timeout === "number" ? call.args.timeout * 1000 : undefined;
    const timeoutMs = rawTimeout ? Math.min(300_000, Math.max(1000, rawTimeout)) : 60_000;
    const res = await execInActiveVm(deps, command, guestRoot, timeoutMs);
    return formatShellOutput(res);
  }

  if (call.name === "ls") {
    const target = resolveGuestPath(call.args.path as string | undefined, guestRoot, deps.hostWorkspaceDir);
    const res = await execInActiveVm(
      deps,
      `ls -1pa -- ${JSON.stringify(target)} 2>&1 | grep -v -E '^\\./$|^\\.\\./$' | head -n 500`,
      guestRoot,
    );
    if (res.exitCode !== 0 && res.stdout.trim() === "") {
      return textOutput(res.stderr.trim() || `Cannot list ${target}`, true);
    }
    const text = res.stdout.trim();
    return textOutput(text === "" ? "(empty directory)" : text);
  }

  if (call.name === "find") {
    const pattern = String(call.args.pattern ?? "*").trim() || "*";
    const target = resolveGuestPath(call.args.path as string | undefined, guestRoot, deps.hostWorkspaceDir);
    const cmd = `cd ${JSON.stringify(target)} && find . -maxdepth 6 \\( -name .git -o -name node_modules \\) -prune -o -type f -print | sed 's|^\\./||' | grep -E ${JSON.stringify(pattern.replace(/\*/g, ".*"))} | head -n 500 || true`;
    const res = await execInActiveVm(deps, cmd, guestRoot);
    return textOutput(res.stdout.trim() || "(no matching files)");
  }

  if (call.name === "grep") {
    const pattern = String(call.args.pattern ?? "");
    const target = resolveGuestPath(call.args.path as string | undefined, guestRoot, deps.hostWorkspaceDir);
    const ignoreCase = call.args.ignoreCase === true ? "-i" : "";
    const cmd = `if command -v rg >/dev/null 2>&1; then rg -n --no-heading ${ignoreCase} -e ${JSON.stringify(pattern)} -- ${JSON.stringify(target)} | head -n 200; else grep -rnE ${ignoreCase} -e ${JSON.stringify(pattern)} -- ${JSON.stringify(target)} | head -n 200; fi`;
    const res = await execInActiveVm(deps, cmd, guestRoot);
    return textOutput(res.stdout.trim() || "(no matches)");
  }

  if (call.name === "read") {
    const rawPath = String(call.args.path ?? "");
    const target = resolveGuestPath(rawPath, guestRoot, deps.hostWorkspaceDir);
    const res = await execInActiveVm(
      deps,
      `if [ ! -f ${JSON.stringify(target)} ]; then echo "ENOENT" >&2; exit 2; fi; base64 -w 0 ${JSON.stringify(target)} 2>/dev/null || base64 ${JSON.stringify(target)} | tr -d '\\r\\n'`,
      guestRoot,
    );
    if (res.exitCode !== 0) {
      return textOutput(`Cannot read ${rawPath}: ${res.stderr.trim() || "file not found"}`, true);
    }
    const rawBytes = Buffer.from(res.stdout.trim(), "base64");
    const ext = posix.extname(target).toLowerCase();
    const mime = IMAGE_EXTS[ext];
    if (mime !== undefined) {
      return { content: [{ type: "text", text: `Image ${rawPath}:` }, { type: "image", mimeType: mime, data: rawBytes.toString("base64") }] };
    }
    const { text: fileText } = stripBom(rawBytes.toString("utf8"));
    const lines = fileText.split("\n");
    const offset = Math.max(1, Number(call.args.offset ?? 1));
    const limit = call.args.limit === undefined ? undefined : Math.max(1, Number(call.args.limit));
    if (offset > lines.length) {
      return textOutput(`${rawPath} has ${lines.length} lines; offset ${offset} is past the end.`, true);
    }
    const wanted = lines.slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit);
    const displayLines = call.args.hashlines === true ? formatHashlines(wanted, offset) : wanted;
    const { text, truncated } = truncateHead(displayLines.join("\n"), MAX_LINES, MAX_BYTES);
    const shown = text === "" ? 0 : text.split("\n").length;
    const end = offset + shown - 1;
    const more = end < lines.length;
    const note = truncated || more ? `\n\n[Lines ${offset}-${end} of ${lines.length}. Use offset=${end + 1} to read more.]` : "";
    return textOutput(text + note);
  }

  if (call.name === "write") {
    const rawPath = String(call.args.path ?? "");
    const content = String(call.args.content ?? "");
    const target = resolveGuestPath(rawPath, guestRoot, deps.hostWorkspaceDir);
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const cmd = `mkdir -p "$(dirname ${JSON.stringify(target)})" && printf '%s' '${b64}' | base64 -d > ${JSON.stringify(target)}`;
    const res = await execInActiveVm(deps, cmd, guestRoot);
    if (res.exitCode !== 0) {
      return textOutput(`Failed to write ${rawPath}: ${res.stderr.trim() || "write error"}`, true);
    }
    return textOutput(`Wrote ${Buffer.byteLength(content)} bytes to ${target} inside virtual server.`);
  }

  if (call.name === "edit") {
    const rawPath = String(call.args.path ?? "");
    const edits = (Array.isArray(call.args.edits) ? call.args.edits : []) as FileEdit[];
    const target = resolveGuestPath(rawPath, guestRoot, deps.hostWorkspaceDir);
    const readRes = await execInActiveVm(
      deps,
      `if [ ! -f ${JSON.stringify(target)} ]; then exit 2; fi; base64 -w 0 ${JSON.stringify(target)} 2>/dev/null || base64 ${JSON.stringify(target)} | tr -d '\\r\\n'`,
      guestRoot,
    );
    if (readRes.exitCode !== 0) {
      return textOutput(`${rawPath} does not exist inside virtual server; use write to create it.`, true);
    }
    for (const item of edits) {
      if (isHashlineEdit(item)) {
        if (item.op !== "delete" && typeof item.newText !== "string") {
          return textOutput("Hashline edits require newText unless op is 'delete'.", true);
        }
      } else if (typeof item?.oldText !== "string" || typeof item?.newText !== "string") {
        return textOutput("Each edit needs oldText and newText strings, or a hashline anchor.", true);
      }
    }
    const { hasBom, text: original } = stripBom(Buffer.from(readRes.stdout.trim(), "base64").toString("utf8"));
    let updated: string;
    try {
      updated = applyEdits(original, edits);
    } catch (err) {
      return textOutput(`No changes made to ${rawPath}: ${err instanceof Error ? err.message : String(err)}.`, true);
    }
    const b64 = Buffer.from(hasBom ? `\uFEFF${updated}` : updated, "utf8").toString("base64");
    const writeRes = await execInActiveVm(deps, `printf '%s' '${b64}' | base64 -d > ${JSON.stringify(target)}`, guestRoot);
    if (writeRes.exitCode !== 0) {
      return textOutput(`Failed to save edit to ${rawPath}: ${writeRes.stderr.trim()}`, true);
    }
    return textOutput(`Applied ${edits.length} edit(s) to ${target} inside virtual server.`);
  }

  return textOutput(`Unsupported VM tool ${call.name}`, true);
}
