/**
 * Sentinel-fenced local tool bridge for `local-win-pip` (`packages/host/src/bot/computer/fenced-tool-bridge.ts`).
 *
 * Bridges `read`, `write`, `edit`, `ls`, `find`, `grep`, `bash`, and `powershell`
 * inside `fencedRoots` (`[botWorkspaceDir, ...sharedFolders.map(f => f.path)]`).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { BotSharedFolderRule } from "@qianji/protocol";
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
import { textOutput, type ToolCall, type ToolOutput } from "@qianji/tools";
import { computeFencedRoots, listFencedFiles, readFencedFile, resolveFencedPath } from "./sentinel-fence.ts";

function runFencedShell(
  command: string,
  cwd: string,
  fencedRoots: readonly string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const isWin = process.platform === "win32";
  return new Promise((resolvePromise) => {
    const child = spawn(
      isWin ? "powershell.exe" : "/bin/sh",
      isWin ? ["-NoLogo", "-NoProfile", "-Command", command] : ["-c", command],
      {
        cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, QIANJI_FENCED_ROOTS: fencedRoots.join(isWin ? ";" : ":") },
      },
    );
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill();
      resolvePromise({ stdout, stderr: `${stderr}\nCommand timed out`.trim(), exitCode: null });
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => {
      if (stdout.length < 256 * 1024) stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      if (stderr.length < 256 * 1024) stderr += c.toString("utf8");
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, exitCode: code });
    });
    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise({ stdout, stderr: err.message, exitCode: null });
    });
  });
}

export async function executeFencedHostTool(
  call: ToolCall,
  botWorkspaceDir: string,
  sharedFolders: readonly BotSharedFolderRule[],
): Promise<ToolOutput> {
  const fencedRoots = computeFencedRoots(botWorkspaceDir, sharedFolders);
  try {
    if (call.name === "bash" || call.name === "powershell") {
      const command = String(call.args.command ?? "");
      const rawTimeout = typeof call.args.timeout === "number" ? call.args.timeout * 1000 : 60_000;
      const res = await runFencedShell(command, botWorkspaceDir, fencedRoots, Math.min(300_000, Math.max(1000, rawTimeout)));
      const combined = [res.stdout.trimEnd(), res.stderr.trimEnd()].filter(Boolean).join("\n");
      const suffix = res.exitCode === 0 ? "" : `\n[exit code: ${res.exitCode ?? "terminated"}]`;
      return textOutput((combined || (res.exitCode === 0 ? "(completed with no output)" : "(failed)")) + suffix, res.exitCode !== 0);
    }

    if (call.name === "ls") {
      const listed = listFencedFiles("local-win-pip", call.args.path as string | undefined, botWorkspaceDir, sharedFolders, true);
      if (listed.entries.length === 0) return textOutput("(empty directory)");
      return textOutput(listed.entries.map((e) => (e.isDir ? `${e.name}/` : e.name)).join("\n"));
    }

    if (call.name === "read") {
      const rawPath = String(call.args.path ?? "");
      const readRes = readFencedFile(rawPath, MAX_BYTES * 2, botWorkspaceDir, sharedFolders, true);
      if (readRes.isBinary && readRes.mimeType?.startsWith("image/") && readRes.dataBase64) {
        return {
          content: [
            { type: "text", text: `Image ${rawPath}:` },
            { type: "image", mimeType: readRes.mimeType, data: readRes.dataBase64 },
          ],
        };
      }
      const lines = (readRes.content ?? "").split("\n");
      const offset = Math.max(1, Number(call.args.offset ?? 1));
      const limit = call.args.limit === undefined ? undefined : Math.max(1, Number(call.args.limit));
      const wanted = lines.slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit);
      const display = call.args.hashlines === true ? formatHashlines(wanted, offset) : wanted;
      const { text } = truncateHead(display.join("\n"), MAX_LINES, MAX_BYTES);
      return textOutput(text);
    }

    if (call.name === "write") {
      const rawPath = String(call.args.path ?? "");
      const content = String(call.args.content ?? "");
      const target = resolveFencedPath(rawPath, botWorkspaceDir, sharedFolders, { requireWritable: true });
      mkdirSync(dirname(target.hostPath), { recursive: true });
      writeFileSync(target.hostPath, content, "utf8");
      return textOutput(`Wrote ${Buffer.byteLength(content)} bytes to ${target.hostPath}.`);
    }

    if (call.name === "edit") {
      const rawPath = String(call.args.path ?? "");
      const target = resolveFencedPath(rawPath, botWorkspaceDir, sharedFolders, { requireWritable: true });
      if (!existsSync(target.hostPath)) return textOutput(`${rawPath} does not exist; use write to create it.`, true);
      const edits = (Array.isArray(call.args.edits) ? call.args.edits : []) as FileEdit[];
      for (const item of edits) {
        if (isHashlineEdit(item)) {
          if (item.op !== "delete" && typeof item.newText !== "string") {
            return textOutput("Hashline edits require newText unless op is 'delete'.", true);
          }
        } else if (typeof item?.oldText !== "string" || typeof item?.newText !== "string") {
          return textOutput("Each edit needs oldText and newText strings.", true);
        }
      }
      const { hasBom, text: orig } = stripBom(readFileSync(target.hostPath, "utf8"));
      const updated = applyEdits(orig, edits);
      writeFileSync(target.hostPath, hasBom ? `\uFEFF${updated}` : updated, "utf8");
      return textOutput(`Applied ${edits.length} edit(s) to ${target.hostPath}.`);
    }

    if (call.name === "find" || call.name === "grep") {
      const target = resolveFencedPath(call.args.path as string | undefined, botWorkspaceDir, sharedFolders);
      const pattern = String(call.args.pattern ?? (call.name === "find" ? "*" : "")).trim();
      const matches: string[] = [];
      const re = call.name === "find"
        ? new RegExp(pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"), "i")
        : new RegExp(pattern, call.args.ignoreCase === true ? "i" : "");
      const walk = (dir: string, depth: number) => {
        if (depth > 6 || matches.length >= 200) return;
        for (const d of readdirSync(dir, { withFileTypes: true })) {
          if (d.name === ".git" || d.name === "node_modules") continue;
          const full = join(dir, d.name);
          if (d.isDirectory()) walk(full, depth + 1);
          else if (d.isFile()) {
            const rel = relative(target.hostPath, full).replace(/\\/g, "/");
            if (call.name === "find") {
              if (re.test(rel)) matches.push(rel);
            } else {
              const lines = readFileSync(full, "utf8").split(/\r?\n/);
              lines.forEach((ln, idx) => {
                if (matches.length < 200 && re.test(ln)) matches.push(`${rel}:${idx + 1}:${ln}`);
              });
            }
          }
        }
      };
      walk(target.hostPath, 0);
      return textOutput(matches.join("\n") || (call.name === "find" ? "(no matching files)" : "(no matches)"));
    }

    return textOutput(`Unsupported fenced tool: ${call.name}`, true);
  } catch (err) {
    return textOutput(err instanceof Error ? err.message : String(err), true);
  }
}
