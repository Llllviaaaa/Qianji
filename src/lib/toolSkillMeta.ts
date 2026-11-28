/**
 * Skill `SKILL.md` read recognition and built-in Qianji meta-tool copy helpers
 * extracted from `toolPresentation.ts` to keep every module compact.
 */

const SKILL_MD_PATH_RE = /(?:^|[/\\])([^/\\]+)[/\\]SKILL\.md$/i;

export function extractSkillSlugFromPath(path: string | undefined): string | null {
  if (!path) return null;
  const match = SKILL_MD_PATH_RE.exec(path.trim());
  const slug = match?.[1]?.trim();
  if (!slug || slug === "." || slug === "..") return null;
  return slug;
}

function readShortArg(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const val = args[key];
    if (typeof val === "string" && val.trim() !== "") return val.trim();
  }
  return undefined;
}

function clipMetaText(value: string, max = 48): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

export interface BuiltinMetaToolCopy {
  readonly title: string;
  readonly detail?: string;
  readonly heading: string;
}

export function presentBuiltinMetaTool(
  normalizedName: string,
  args: Record<string, unknown>,
): BuiltinMetaToolCopy | null {
  if (normalizedName === "activate_tools") {
    const requested = Array.isArray(args.names)
      ? args.names.filter((item): item is string => typeof item === "string" && item.trim() !== "").join(", ")
      : readShortArg(args, ["name", "tool"]) ?? "";
    const detail = requested ? clipMetaText(requested) : undefined;
    return {
      title: "加载扩展工具",
      ...(detail ? { detail } : {}),
      heading: detail ? `加载扩展工具 · ${detail}` : "加载扩展工具",
    };
  }
  if (normalizedName === "qianji_inspect") {
    const topic = readShortArg(args, ["topic", "target", "section"]);
    const detail = topic ? clipMetaText(topic) : undefined;
    return {
      title: "检查宿主架构",
      ...(detail ? { detail } : {}),
      heading: detail ? `检查宿主架构 · ${detail}` : "检查宿主架构",
    };
  }
  if (normalizedName === "plugin_manager") {
    const action = readShortArg(args, ["action"]);
    const target = readShortArg(args, ["pluginId", "id", "path", "template"]);
    const rawDetail = [action, target].filter(Boolean).join(" · ");
    const detail = rawDetail ? clipMetaText(rawDetail) : undefined;
    return {
      title: "管理扩展插件",
      ...(detail ? { detail } : {}),
      heading: detail ? `管理扩展插件 · ${detail}` : "管理扩展插件",
    };
  }
  if (normalizedName === "ask_user" || normalizedName === "ask_question") {
    const directQ = readShortArg(args, ["question", "title"]);
    const firstBatchQ =
      !directQ && Array.isArray(args.questions) && typeof args.questions[0] === "object" && args.questions[0] !== null
        ? readShortArg(args.questions[0] as Record<string, unknown>, ["question", "title"])
        : undefined;
    const detail = (directQ ?? firstBatchQ) ? clipMetaText((directQ ?? firstBatchQ) as string) : undefined;
    return {
      title: "向你提问确认",
      ...(detail ? { detail } : {}),
      heading: detail ? `向你提问确认 · ${detail}` : "向你提问确认",
    };
  }
  return null;
}
