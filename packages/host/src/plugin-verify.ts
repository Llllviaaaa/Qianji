/**
 * Pre-flight checks for a plugin directory (`plugin_manager` `verify`, ADR 0016):
 * the manifest, the host entry's syntax and imports, and a compile of the
 * client bundle, with nothing installed or configured.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { ClientBundleRegistry } from "./client-bundles.ts";
import { HOST_SHARED_MODULES } from "./plugin-bridge.ts";
import { HOST_SERVICE_CATALOG } from "./plugin-dev-catalog.ts";
import { readPluginManifest } from "./plugin-manifest.ts";
import { errorMessage } from "./plugin-util.ts";

interface EsbuildNodeVerifier {
  build(options: {
    entryPoints: string[];
    bundle: boolean;
    write: false;
    format: "cjs";
    platform: "node";
    target: string;
    external: string[];
    logLevel: "silent";
  }): Promise<{ outputFiles: Array<{ text: string }> }>;
}

interface BunBuildVerifier {
  build(options: {
    entrypoints: string[];
    format: "cjs";
    target: "bun" | "node";
    external: string[];
  }): Promise<{
    success: boolean;
    outputs?: Array<{ text(): Promise<string> }>;
    logs: Array<{ message?: string } | string>;
  }>;
}

const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "throw",
  "case",
  "in",
  "of",
  "typeof",
  "void",
  "delete",
  "yield",
  "await",
  "else",
  "do",
  "new",
]);

function maskCommentsAndStrings(code: string): string {
  const out: string[] = [];
  const templateBraceDepth: number[] = [];
  let prevToken: "expr" | "op" = "op";
  let i = 0;

  while (i < code.length) {
    const ch = code[i] ?? "";
    const next = code[i + 1] ?? "";

    if (ch === "/" && next === "/") {
      out.push("  ");
      i += 2;
      while (i < code.length && code[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      out.push("  ");
      i += 2;
      while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) {
        out.push(code[i] === "\n" ? "\n" : " ");
        i += 1;
      }
      if (i < code.length) {
        out.push("  ");
        i += 2;
      }
      continue;
    }

    if (ch === "/" && prevToken === "op") {
      out.push(" ");
      i += 1;
      let inClass = false;
      while (i < code.length) {
        const rc = code[i] ?? "";
        if (rc === "\\") {
          out.push(i + 1 < code.length ? "  " : " ");
          i += i + 1 < code.length ? 2 : 1;
          continue;
        }
        if (rc === "\n") {
          out.push("\n");
          i += 1;
          break;
        }
        if (rc === "[") inClass = true;
        else if (rc === "]" && inClass) inClass = false;
        else if (rc === "/" && !inClass) {
          out.push(" ");
          i += 1;
          while (i < code.length && /[a-zA-Z]/.test(code[i] ?? "")) {
            out.push(" ");
            i += 1;
          }
          break;
        }
        out.push(" ");
        i += 1;
      }
      prevToken = "expr";
      continue;
    }

    if (ch === "'" || ch === "\"") {
      const quote = ch;
      out.push(" ");
      i += 1;
      while (i < code.length) {
        const sc = code[i] ?? "";
        if (sc === "\\") {
          out.push(code[i + 1] === "\n" ? " \n" : i + 1 < code.length ? "  " : " ");
          i += i + 1 < code.length ? 2 : 1;
          continue;
        }
        if (sc === "\n") {
          out.push("\n");
          i += 1;
          break;
        }
        out.push(" ");
        i += 1;
        if (sc === quote) break;
      }
      prevToken = "expr";
      continue;
    }

    const resumingTemplate =
      ch === "}" &&
      templateBraceDepth.length > 0 &&
      (templateBraceDepth[templateBraceDepth.length - 1] ?? 0) === 1;
    if (ch === "`" || resumingTemplate) {
      if (resumingTemplate) templateBraceDepth.pop();
      out.push(" ");
      i += 1;
      let openedExpr = false;
      while (i < code.length) {
        const tc = code[i] ?? "";
        if (tc === "\\") {
          out.push(code[i + 1] === "\n" ? " \n" : i + 1 < code.length ? "  " : " ");
          i += i + 1 < code.length ? 2 : 1;
          continue;
        }
        if (tc === "$" && code[i + 1] === "{") {
          out.push("  ");
          i += 2;
          templateBraceDepth.push(1);
          prevToken = "op";
          openedExpr = true;
          break;
        }
        out.push(tc === "\n" ? "\n" : " ");
        i += 1;
        if (tc === "`") break;
      }
      if (!openedExpr) prevToken = "expr";
      continue;
    }

    if (ch === "{" && templateBraceDepth.length > 0) {
      const last = templateBraceDepth.length - 1;
      templateBraceDepth[last] = (templateBraceDepth[last] ?? 0) + 1;
    } else if (ch === "}" && templateBraceDepth.length > 0) {
      const last = templateBraceDepth.length - 1;
      templateBraceDepth[last] = Math.max(0, (templateBraceDepth[last] ?? 0) - 1);
    }

    if (/[a-zA-Z_$]/.test(ch)) {
      let end = i + 1;
      while (end < code.length && /[a-zA-Z0-9_$]/.test(code[end] ?? "")) end += 1;
      const ident = code.slice(i, end);
      out.push(ident);
      prevToken = REGEX_PRECEDING_KEYWORDS.has(ident) ? "op" : "expr";
      i = end;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let end = i + 1;
      while (end < code.length && /[0-9a-zA-Z_.]/.test(code[end] ?? "")) end += 1;
      out.push(code.slice(i, end));
      prevToken = "expr";
      i = end;
      continue;
    }

    out.push(ch);
    if (!/\s/.test(ch)) {
      prevToken = ch === ")" || ch === "]" ? "expr" : "op";
    }
    i += 1;
  }

  return out.join("");
}

function stripCommentsOnly(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

function collectInjectNamesFromLiteral(literal: string, target: Set<string>): void {
  const trimmed = literal.trim();
  if (trimmed.startsWith("[")) {
    const strRe = /"([a-zA-Z_$][a-zA-Z0-9_$-]*)"|'([a-zA-Z_$][a-zA-Z0-9_$-]*)'/g;
    let m: RegExpExecArray | null;
    while ((m = strRe.exec(trimmed)) !== null) {
      const name = m[1] ?? m[2];
      if (name !== undefined) target.add(name);
    }
    return;
  }
  if (trimmed.startsWith("{")) {
    const keyRe = /(?:^|[{,])\s*(?:"([a-zA-Z_$][a-zA-Z0-9_$-]*)"|'([a-zA-Z_$][a-zA-Z0-9_$-]*)'|([a-zA-Z_$][a-zA-Z0-9_$]*))\s*:/g;
    let m: RegExpExecArray | null;
    while ((m = keyRe.exec(trimmed)) !== null) {
      const name = m[1] ?? m[2] ?? m[3];
      if (name !== undefined) target.add(name);
    }
  }
}

/** Static pre-flight check for Cordis services used via `ctx.<service>` without matching `inject` declarations. */
export function findMissingCordisInjects(
  code: string,
  plane: "host" | "client",
  manifestInject?: readonly string[],
): string[] {
  const declared = new Set<string>(manifestInject ?? []);
  const noComments = stripCommentsOnly(code);

  const constLiterals = new Map<string, string>();
  const constDefRe = /\b(?:var|let|const)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(\[[^\]]*\]|\{[^}]*\})/g;
  let cm: RegExpExecArray | null;
  while ((cm = constDefRe.exec(noComments)) !== null) {
    if (cm[1] !== undefined && cm[2] !== undefined) {
      constLiterals.set(cm[1], cm[2]);
    }
  }

  const declRe =
    /(?:^|[;,{}\s])(?:(?:export\s+)?(?:var|let|const)|static|[a-zA-Z_$][a-zA-Z0-9_$]*\s*\.)\s*inject\s*(?:=|:)\s*(\[[^\]]*\]|\{[^}]*\}|[a-zA-Z_$][a-zA-Z0-9_$]*)|\binject\s*:\s*(\[[^\]]*\]|\{[^}]*\}|[a-zA-Z_$][a-zA-Z0-9_$]*)|\.\s*inject\s*\(\s*(\[[^\]]*\]|\{[^}]*\})/gm;
  let dm: RegExpExecArray | null;
  while ((dm = declRe.exec(noComments)) !== null) {
    const rawValue = dm[1] ?? dm[2] ?? dm[3];
    if (rawValue === undefined) continue;
    if (rawValue.startsWith("[") || rawValue.startsWith("{")) {
      collectInjectNamesFromLiteral(rawValue, declared);
    } else {
      const resolved = constLiterals.get(rawValue);
      if (resolved !== undefined) collectInjectNamesFromLiteral(resolved, declared);
    }
  }

  const masked = maskCommentsAndStrings(code);
  const ctxNames = new Set<string>(["ctx", "context"]);

  const ctxIdentRe = /\b[a-zA-Z_$][a-zA-Z0-9_$]*[Cc]tx\b/g;
  let im: RegExpExecArray | null;
  while ((im = ctxIdentRe.exec(masked)) !== null) {
    ctxNames.add(im[0]);
  }
  const applyParamRe =
    /(?:\bapply\s*\(|\bapply\s*:\s*(?:async\s+)?(?:function\s*(?:[a-zA-Z_$][a-zA-Z0-9_$]*)?\s*)?\(|\.\s*inject\s*\([^)]*,\s*(?:async\s+)?(?:function\s*(?:[a-zA-Z_$][a-zA-Z0-9_$]*)?\s*)?\(?)\s*([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
  while ((im = applyParamRe.exec(masked)) !== null) {
    if (im[1] !== undefined) ctxNames.add(im[1]);
  }

  const planeServices = new Set(
    HOST_SERVICE_CATALOG.filter((entry) => entry.plane === plane).map((entry) => entry.name),
  );
  const ctxAlternation = Array.from(ctxNames)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const serviceAlternation = Array.from(planeServices).join("|");
  if (serviceAlternation === "") return [];

  const used = new Set<string>();
  const memberRe = new RegExp(
    `(?:\\bthis\\s*\\.\\s*ctx|\\b(?:${ctxAlternation}))\\s*\\??\\.\\s*(${serviceAlternation})\\b`,
    "g",
  );
  let mm: RegExpExecArray | null;
  while ((mm = memberRe.exec(masked)) !== null) {
    if (mm[1] !== undefined) used.add(mm[1]);
  }

  const destructureRe = new RegExp(
    `\\b(?:const|let|var)\\s*\\{([^}]+)\\}\\s*=\\s*(?:\\bthis\\s*\\.\\s*ctx|\\b(?:${ctxAlternation}))\\b`,
    "g",
  );
  while ((mm = destructureRe.exec(masked)) !== null) {
    const body = mm[1] ?? "";
    for (const part of body.split(",")) {
      const propMatch = /^\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?::|=|$)/.exec(part);
      const prop = propMatch?.[1];
      if (prop !== undefined && planeServices.has(prop)) {
        used.add(prop);
      }
    }
  }

  return Array.from(used).filter((service) => !declared.has(service)).sort();
}

async function verifyHostEntrySyntaxAndImports(
  hostEntry: string,
): Promise<{ ok: boolean; code?: string; error?: string }> {
  const external = [...Object.keys(HOST_SHARED_MODULES), "node:*"];
  const bunGlobal = (globalThis as { Bun?: BunBuildVerifier }).Bun;
  if (bunGlobal !== undefined && typeof bunGlobal.build === "function" && process.versions.bun !== undefined) {
    try {
      const result = await bunGlobal.build({
        entrypoints: [hostEntry],
        format: "cjs",
        target: "bun",
        external,
      });
      if (!result.success) {
        const msg = result.logs
          .map((item) => (typeof item === "string" ? item : item.message ?? String(item)))
          .join("; ");
        return { ok: false, error: msg || `Failed to compile host entry ${hostEntry}` };
      }
      const code = result.outputs?.[0] !== undefined ? await result.outputs[0].text() : readFileSync(hostEntry, "utf8");
      return { ok: true, code };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  try {
    const req = createRequire(import.meta.url);
    const esbuildPkg = "esbuild";
    const esbuild = req(esbuildPkg) as EsbuildNodeVerifier;
    const built = await esbuild.build({
      entryPoints: [hostEntry],
      bundle: true,
      write: false,
      format: "cjs",
      platform: "node",
      target: "node22",
      external: Object.keys(HOST_SHARED_MODULES),
      logLevel: "silent",
    });
    const code = built.outputFiles[0]?.text;
    return { ok: true, ...(code === undefined ? {} : { code }) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export interface PluginVerifyReport {
  ok: boolean;
  target: string;
  pluginId?: string;
  name?: string;
  version?: string;
  hasHost?: boolean;
  hasClient?: boolean;
  hasSkills?: boolean;
  hostEntry?: string;
  clientEntry?: string;
  skillsDir?: string;
  clientBundleBytes?: number;
  clientCompiled?: { bytes: number; etag: string };
  errors: string[];
  warnings: string[];
}

/** Dry-run manifest validation + Host & Client compilation without mutating `plugins.json`. */
export async function verifyPluginDirectory(targetDir: string): Promise<PluginVerifyReport> {
  const resolvedDir = resolve(targetDir);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!existsSync(resolvedDir)) {
    return {
      ok: false,
      target: resolvedDir,
      errors: [`Directory does not exist: ${resolvedDir}`],
      warnings,
    };
  }

  let manifest;
  try {
    manifest = readPluginManifest(resolvedDir, "user");
  } catch (error) {
    return {
      ok: false,
      target: resolvedDir,
      errors: [errorMessage(error)],
      warnings,
    };
  }

  if (!existsSync(join(resolvedDir, "package.json"))) {
    warnings.push("No package.json found; add package.json with explicit name, version, description, and qianji metadata.");
  }
  if (!manifest.description || manifest.description.trim() === "") {
    warnings.push("Plugin package.json is missing a human-readable `description`.");
  }

  if (manifest.hostEntry !== undefined) {
    const hostCheck = await verifyHostEntrySyntaxAndImports(manifest.hostEntry);
    if (!hostCheck.ok && hostCheck.error !== undefined) {
      errors.push(`Host entry compile error (${manifest.hostEntry}): ${hostCheck.error}`);
    } else if (hostCheck.code !== undefined) {
      const missingHost = findMissingCordisInjects(hostCheck.code, "host", manifest.inject);
      if (missingHost.length > 0) {
        errors.push(
          `Host entry uses Cordis service(s) (${missingHost.join(", ")}) without declaring them in \`export const inject\` or \`package.json -> qianji.inject\`.`,
        );
      }
    }
  }

  let clientBundleBytes: number | undefined;
  let clientCompiled: { bytes: number; etag: string } | undefined;
  if (manifest.clientEntry !== undefined) {
    try {
      const tempRegistry = new ClientBundleRegistry();
      const compiled = await tempRegistry.compile(manifest.id, manifest.dir, manifest.clientEntry);
      clientBundleBytes = Buffer.byteLength(compiled.code, "utf8");
      clientCompiled = { bytes: clientBundleBytes, etag: compiled.etag };
      const missingClient = findMissingCordisInjects(compiled.code, "client");
      if (missingClient.length > 0) {
        errors.push(
          `Client entry uses Cordis service(s) (${missingClient.join(", ")}) without declaring them in client entry \`inject\`.`,
        );
      }
    } catch (error) {
      errors.push(`Client bundle compilation failed (${manifest.clientEntry}): ${errorMessage(error)}`);
    }
  }

  return {
    ok: errors.length === 0,
    target: manifest.dir,
    pluginId: manifest.id,
    name: manifest.name,
    version: manifest.version,
    hasHost: manifest.hostEntry !== undefined,
    hasClient: manifest.clientEntry !== undefined,
    hasSkills: manifest.skillsDir !== undefined,
    ...(manifest.hostEntry === undefined ? {} : { hostEntry: manifest.hostEntry }),
    ...(manifest.clientEntry === undefined ? {} : { clientEntry: manifest.clientEntry }),
    ...(manifest.skillsDir === undefined ? {} : { skillsDir: manifest.skillsDir }),
    ...(clientBundleBytes === undefined ? {} : { clientBundleBytes }),
    ...(clientCompiled === undefined ? {} : { clientCompiled }),
    errors,
    warnings,
  };
}
