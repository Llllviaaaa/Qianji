import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import "@qianji/commands";
import "@qianji/rpc";

export const name = "web-preview";
export const inject = ["commands", "rpc"];

export interface DetectedScript {
  name: string;
  command: string;
}

export interface WebProjectDetection {
  hasPackageJson: boolean;
  projectName: string;
  framework: string;
  scripts: DetectedScript[];
}

function detectFrameworkFromDeps(deps: Record<string, string>): string {
  if ("@tauri-apps/api" in deps && "vite" in deps) return "Tauri + Vite";
  if ("next" in deps) return "Next.js";
  if ("astro" in deps) return "Astro";
  if ("nuxt" in deps) return "Nuxt";
  if ("vite" in deps) return "Vite";
  if ("react" in deps) return "React";
  if ("vue" in deps) return "Vue";
  if ("svelte" in deps) return "Svelte";
  return "Web / Node.js";
}

function inspectWebProject(cwd: string): WebProjectDetection {
  const cleanCwd = cwd.trim();
  const fallbackName = cleanCwd ? basename(cleanCwd) : "当前工作区";
  const pkgPath = cleanCwd ? join(cleanCwd, "package.json") : "";
  if (!pkgPath || !existsSync(pkgPath)) {
    return {
      hasPackageJson: false,
      projectName: fallbackName,
      framework: "未检测到 package.json",
      scripts: [],
    };
  }
  try {
    const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      name?: unknown;
      scripts?: unknown;
      dependencies?: unknown;
      devDependencies?: unknown;
    };
    const deps: Record<string, string> = {
      ...(typeof raw.dependencies === "object" && raw.dependencies !== null ? (raw.dependencies as Record<string, string>) : {}),
      ...(typeof raw.devDependencies === "object" && raw.devDependencies !== null ? (raw.devDependencies as Record<string, string>) : {}),
    };
    const allScripts =
      typeof raw.scripts === "object" && raw.scripts !== null
        ? (raw.scripts as Record<string, unknown>)
        : {};
    const preferredOrder = ["dev", "start", "preview", "serve", "tauri:dev"];
    const scripts: DetectedScript[] = [];
    for (const key of preferredOrder) {
      const cmd = allScripts[key];
      if (typeof cmd === "string" && cmd.trim() !== "") {
        scripts.push({ name: key, command: cmd });
      }
    }
    return {
      hasPackageJson: true,
      projectName: typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name : fallbackName,
      framework: detectFrameworkFromDeps(deps),
      scripts,
    };
  } catch {
    return {
      hasPackageJson: false,
      projectName: fallbackName,
      framework: "package.json 解析失败",
      scripts: [],
    };
  }
}

export function apply(ctx: Context): void {
  ctx.effect(
    () =>
      ctx.rpc.method("webPreview.detectProject", (rawParams): WebProjectDetection => {
        const p = typeof rawParams === "object" && rawParams !== null ? (rawParams as Record<string, unknown>) : {};
        const cwd = typeof p.cwd === "string" ? p.cwd : "";
        return inspectWebProject(cwd);
      }),
    "web-preview: webPreview.detectProject",
  );

  ctx.effect(
    () =>
      ctx.commands.register({
        name: "preview",
        description: "识别当前工作区 Web 脚本并打开右侧内置浏览器预览面板",
        source: "plugin",
        execute(_rawArgs, env) {
          const info = inspectWebProject(env.cwd);
          const scriptLines =
            info.scripts.length > 0
              ? info.scripts.map((s) => `- \`npm run ${s.name}\`: \`${s.command}\``).join("\n")
              : "- 未发现 `dev` / `start` / `preview` 脚本";
          return {
            output: `### Web 工程识别（${info.projectName}）\n\n- **技术栈**：${info.framework}\n${scriptLines}`,
          };
        },
      }),
    "web-preview: /preview command",
  );
}

export default {
  name,
  inject,
  apply,
};
