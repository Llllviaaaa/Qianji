import { execFile } from "node:child_process";
import type { Context } from "@deepseek-ai/cordis";
import "@qianji/commands";
import "@qianji/rpc";
import { textOutput } from "@qianji/tools";

export const name = "code-review";
export const inject = ["tools", "commands", "rpc"];

export interface CodeReviewConfig {
  maxDiffChars?: number;
  strictSeverityFilter?: boolean;
}

export interface CodeReviewSummary {
  isRepo: boolean;
  branch: string;
  changedFiles: number;
}

function execGit(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
        });
      },
    );
  });
}

function clampMaxChars(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 24000;
  return Math.max(4000, Math.min(100000, Math.round(raw)));
}

function buildReviewPrompt(baseBranch: string, strictSeverity: boolean): string {
  const scopeText = baseBranch
    ? `当前分支相对基准分支 \`${baseBranch}\` 的变更（${baseBranch}...HEAD）`
    : "当前工作区的全部未提交变更（含暂存区与未跟踪文件）";
  return [
    `请对${scopeText}进行专业代码审查：`,
    ``,
    `1. 先调用 \`code_review_diff\` 查看变更统计与完整 Diff（如文件较多可结合文件读取工具核实上下文）。`,
    `2. 重点关注正确性 Bug、并发或边界条件、类型/空值隐患、安全与权限漏洞，以及明显的架构/资源泄漏问题。`,
    strictSeverity
      ? `3. 仅提出能从代码上下文直接证实的具体问题，避免泛泛而谈或纯粹风格偏好。`
      : `3. 同时列出潜在风险点与可维护性改进建议。`,
    `4. 针对每条具体代码问题，可使用 \`::code-comment{file="相对路径" start=起始行 end=结束行 severity="critical|warning|suggestion" title="问题简述"}\` 输出内联定位批注，并在最后给出简要总体结论。`,
  ].join("\n");
}

export function apply(ctx: Context, rawConfig: CodeReviewConfig = {}): void {
  const maxDiffChars = clampMaxChars(rawConfig.maxDiffChars);
  const strictSeverity = rawConfig.strictSeverityFilter !== false;

  ctx.effect(
    () =>
      ctx.tools.register<{
        base?: string;
        filePath?: string;
        stagedOnly?: boolean;
      }>({
        name: "code_review_diff",
        description: "只读获取工作区 Git 状态摘要与 Diff 内容（支持指定文件或对比基准分支）。",
        readOnly: true,
        parameters: {
          type: "object",
          properties: {
            base: {
              type: "string",
              description: "可选：对比的基准分支名，例如 main / origin/main；留空则查看工作区未提交变更",
            },
            filePath: {
              type: "string",
              description: "可选：仅查看特定文件的 Diff",
            },
            stagedOnly: {
              type: "boolean",
              description: "仅查看已暂存区（--cached）变更",
            },
          },
        },
        async execute(args, env) {
          const check = await execGit(["rev-parse", "--is-inside-work-tree"], env.cwd);
          if (!check.ok) {
            return textOutput("当前工作区不是有效的 Git 仓库。", true);
          }
          const base = typeof args.base === "string" ? args.base.trim() : "";
          const filePath = typeof args.filePath === "string" ? args.filePath.trim() : "";
          const statusRes = await execGit(["status", "--short"], env.cwd);
          const diffArgs = ["diff", "--no-color"];
          if (base) {
            diffArgs.push(`${base}...HEAD`);
          } else if (args.stagedOnly === true) {
            diffArgs.push("--cached");
          }
          if (filePath) {
            diffArgs.push("--", filePath);
          }
          const diffRes = await execGit(diffArgs, env.cwd);
          const combined = [
            "=== git status --short ===",
            statusRes.stdout.trim() || "(工作区干净)",
            "",
            `=== git ${diffArgs.join(" ")} ===`,
            diffRes.stdout.trim() || "(无文本差异)",
          ].join("\n");
          const truncated =
            combined.length > maxDiffChars
              ? `${combined.slice(0, maxDiffChars)}\n\n... [Diff 已截断至 ${maxDiffChars} 字符，可传入 filePath 分文件查看]`
              : combined;
          return textOutput(truncated);
        },
      }),
    "code-review: code_review_diff",
  );

  ctx.effect(
    () =>
      ctx.commands.register({
        name: "review",
        argsHint: "[base-branch]",
        description: "对未提交变更或对比指定分支发起 AI 代码审查",
        source: "plugin",
        execute(rawArgs) {
          return {
            prompt: buildReviewPrompt(rawArgs.trim(), strictSeverity),
          };
        },
      }),
    "code-review: /review command",
  );

  ctx.effect(
    () =>
      ctx.rpc.method("codeReview.summary", async (rawParams): Promise<CodeReviewSummary> => {
        const p = typeof rawParams === "object" && rawParams !== null ? (rawParams as Record<string, unknown>) : {};
        const cwd = typeof p.cwd === "string" && p.cwd.trim() !== "" ? p.cwd.trim() : process.cwd();
        const inside = await execGit(["rev-parse", "--is-inside-work-tree"], cwd);
        if (!inside.ok) {
          return { isRepo: false, branch: "", changedFiles: 0 };
        }
        const [branchRes, statusRes] = await Promise.all([
          execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
          execGit(["status", "--porcelain"], cwd),
        ]);
        const changedFiles = statusRes.stdout
          .split(/\r?\n/)
          .filter((line) => line.trim() !== "").length;
        return {
          isRepo: true,
          branch: branchRes.stdout.trim() || "HEAD",
          changedFiles,
        };
      }),
    "code-review: codeReview.summary",
  );
}

export default {
  name,
  inject,
  apply,
};
