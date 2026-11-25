/**
 * User hooks (ADR 0009, ADR 0024): shell commands run on agent events, with
 * the event as JSON on stdin. The Pi extension's event names map onto the
 * harness's:
 *
 * | hook event           | harness event                         |
 * |----------------------|---------------------------------------|
 * | `session_start`      | `session/created`                     |
 * | `before_agent_start` | `agent/before-start`                  |
 * | `stop`               | `agent/before-stop` (may block stop)  |
 * | `agent_end`          | `agent/settled` (first)               |
 * | `agent_settled`      | `agent/settled` (then)                |
 * | `tool_call`          | `tools/pre-execute` (may block)       |
 * | `tool_result`        | `tools/execute` + `tools/result`      |
 *
 * A failing `tool_call` hook marked blocking denies the call; a `stop` hook
 * exiting with code 2 or JSON `{"decision":"block","reason":"..."}` continues
 * the run; a `tool_result` hook returning JSON `{"additionalContext":"..."}`
 * appends that context for the model's next turn.
 */
import { spawn } from "node:child_process";
import type { Context } from "@deepseek-ai/cordis";
import "@qianji/agent";
import { CONTINUATION_NAMESPACE, type Session } from "@qianji/session";
import type { ToolCall, ToolEnv, ToolOutput } from "@qianji/tools";
import "@qianji/ui";
import { validateDesktopHooks, type DesktopHookConfig, type DesktopHookEvent } from "./core.ts";

export * from "./core.ts";

export const name = "qianji-hooks";
export const inject = ["sessions", "tools", "ui"];

export interface Config {
  hooks: DesktopHookConfig[];
  /** Pass secrets-looking variables (keys, tokens, passwords) to hooks too. Default false. */
  inheritEnvironment?: boolean;
}

export interface HookExecutionResult {
  ok: boolean;
  output: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

const OUTPUT_LIMIT = 64 * 1024;
const SENSITIVE = /(api.?key|token|secret|password|credential|authorization|cookie)/i;

export function hookEnvironment(
  inheritEnvironment: boolean,
  event: DesktopHookEvent,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = inheritEnvironment
    ? { ...env }
    : Object.fromEntries(Object.entries(env).filter(([key]) => !SENSITIVE.test(key)));
  environment.PIDESKTOP_HOOK_EVENT = event;
  environment.PIDESKTOP_WORKSPACE = cwd;
  return environment;
}

export function executeHook(
  hook: DesktopHookConfig,
  event: DesktopHookEvent,
  payload: unknown,
  cwd: string,
  inheritEnvironment: boolean,
): Promise<HookExecutionResult> {
  return new Promise((resolve) => {
    const windows = process.platform === "win32";
    const executable = windows ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
    // cmd.exe does not understand the \" escaping Node applies to arguments,
    // so the command line goes through verbatim; /s strips the outer quotes.
    const args = windows ? ["/d", "/s", "/c", `"${hook.command}"`] : ["-lc", hook.command];
    const child = spawn(executable, args, {
      cwd,
      env: hookEnvironment(inheritEnvironment, event, cwd),
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: windows,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const appendCapped = (current: string, chunk: Buffer): string => {
      if (current.length >= OUTPUT_LIMIT) return current;
      return current + chunk.toString("utf8").slice(0, OUTPUT_LIMIT - current.length);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk);
      output = appendCapped(output, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk);
      output = appendCapped(output, chunk);
    });
    child.on("error", (error) => {
      resolve({
        ok: false,
        output: error.message,
        stdout: stdout.trim(),
        stderr: stderr.trim() || error.message,
        exitCode: null,
      });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, hook.timeoutSeconds * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const trimmedOut = stdout.trim();
      const trimmedErr = stderr.trim();
      resolve({
        ok: !timedOut && code === 0,
        output: timedOut ? `Timed out after ${hook.timeoutSeconds}s` : output.trim(),
        stdout: trimmedOut,
        stderr: trimmedErr,
        exitCode: timedOut ? null : code,
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ event, cwd, payload }));
  });
}

function parseHookJson(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function extractAdditionalContext(stdout: string): string | undefined {
  const parsed = parseHookJson(stdout);
  if (parsed === undefined) return undefined;
  const direct = parsed.additionalContext;
  if (typeof direct === "string" && direct.trim() !== "") return direct.trim();
  const nested = parsed.hookSpecificOutput;
  if (typeof nested === "object" && nested !== null) {
    const nestedCtx = (nested as { additionalContext?: unknown }).additionalContext;
    if (typeof nestedCtx === "string" && nestedCtx.trim() !== "") return nestedCtx.trim();
  }
  return undefined;
}

function lastPrompt(session: Session): string {
  const user = session.events.findLast((event) => event.type === "user");
  if (user?.type !== "user") return "";
  return user.data.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

export function apply(ctx: Context, config: Config): void {
  let hooks: DesktopHookConfig[];
  try {
    hooks = validateDesktopHooks(config.hooks ?? []);
  } catch (error) {
    ctx.logger("hooks").error("hooks config is invalid: %s", error instanceof Error ? error.message : String(error));
    return;
  }
  const inherit = config.inheritEnvironment === true;
  const enabledFor = (event: DesktopHookEvent) => hooks.filter((candidate) => candidate.enabled && candidate.event === event);

  const reportFailure = (hook: DesktopHookConfig, result: HookExecutionResult, sessionId: string): string => {
    const message = `${hook.name}: ${result.output || "command failed"}`;
    ctx.logger("hooks").warn("hook failed: %s", message);
    ctx.ui.notify(sessionId, `Hook 失败：${message}`, "error");
    return message;
  };

  /** Run the hooks of `event`; the failure message of a blocking one, if any. */
  const run = async (event: DesktopHookEvent, payload: unknown, sessionId: string, cwd: string): Promise<string | undefined> => {
    for (const hook of enabledFor(event)) {
      const result = await executeHook(hook, event, payload, cwd, inherit);
      if (result.ok) continue;
      const message = `${hook.name}: ${result.output || "command failed"}`;
      ctx.logger("hooks").warn("hook failed: %s", message);
      if (hook.blocking && event === "tool_call") return message;
      ctx.ui.notify(sessionId, `Hook 失败：${message}`, "error");
    }
    return undefined;
  };
  const has = (event: DesktopHookEvent) => enabledFor(event).length > 0;

  if (has("session_start")) {
    ctx.on("session/created", (session) => {
      void run("session_start", { sessionId: session.id }, session.id, session.header.cwd);
    });
  }
  if (has("before_agent_start")) {
    ctx.on("agent/before-start", async (session) => {
      await run("before_agent_start", { messageType: "user", prompt: lastPrompt(session) }, session.id, session.header.cwd);
    });
  }
  if (has("stop")) {
    ctx.on("agent/before-stop", async (session, info) => {
      const reasons: string[] = [];
      const payload = { sessionId: session.id, turn: info.turn, stop: info.stop, hasText: info.hasText };
      for (const hook of enabledFor("stop")) {
        const result = await executeHook(hook, "stop", payload, session.header.cwd, inherit);
        const parsed = parseHookJson(result.stdout);
        const jsonReason = typeof parsed?.reason === "string" ? parsed.reason.trim() : "";
        if (parsed?.decision === "block") {
          reasons.push(jsonReason || result.stderr || result.output || `Stop blocked by hook ${hook.name}.`);
          continue;
        }
        if (result.exitCode === 2) {
          reasons.push(jsonReason || result.stderr || result.stdout || result.output || `Stop blocked by hook ${hook.name}.`);
          continue;
        }
        if (!result.ok) reportFailure(hook, result, session.id);
      }
      return reasons.length > 0 ? reasons.join("\n\n") : undefined;
    });
  }
  if (has("agent_end") || has("agent_settled")) {
    ctx.on("agent/settled", async (session, outcome) => {
      const messageCount = session.state().messages.length;
      await run("agent_end", { messageCount }, session.id, session.header.cwd);
      await run("agent_settled", { outcome }, session.id, session.header.cwd);
    });
  }
  if (has("tool_call")) {
    ctx.on("tools/pre-execute", async (call, env) => {
      const reason = await run("tool_call", { toolCallId: call.id, toolName: call.name, input: call.args }, env.sessionId, env.cwd);
      return reason === undefined ? undefined : { deny: true, reason };
    });
  }
  if (has("tool_result")) {
    const handledEnvs = new WeakSet<ToolEnv>();
    const runToolResultHooks = async (call: ToolCall, env: ToolEnv, output: ToolOutput): Promise<string[]> => {
      const extras: string[] = [];
      const payload = {
        toolCallId: call.id,
        toolName: call.name,
        input: call.args,
        isError: output.isError === true,
        content: output.content,
      };
      for (const hook of enabledFor("tool_result")) {
        const result = await executeHook(hook, "tool_result", payload, env.cwd, inherit);
        if (!result.ok) {
          reportFailure(hook, result, env.sessionId);
          continue;
        }
        const extra = extractAdditionalContext(result.stdout);
        if (extra !== undefined) extras.push(extra);
      }
      return extras;
    };

    ctx.on("tools/execute", async (call, env, next) => {
      handledEnvs.add(env);
      const output = await next();
      const extras = await runToolResultHooks(call, env, output);
      if (extras.length === 0) return output;
      const joined = extras.join("\n\n");
      return {
        ...output,
        content: output.content.length > 0
          ? [...output.content, { type: "text", text: `\n\n${joined}` }]
          : [{ type: "text", text: joined }],
      };
    });

    ctx.on("tools/result", (call, env, output) => {
      if (handledEnvs.has(env)) return;
      void runToolResultHooks(call, env, output).then((extras) => {
        if (extras.length === 0) return;
        const session = ctx.sessions.peek(env.sessionId);
        if (session !== undefined) {
          session.append("custom", {
            ns: CONTINUATION_NAMESPACE,
            data: { reason: "before-stop", text: extras.join("\n\n") },
          });
        }
      });
    });
  }
}
