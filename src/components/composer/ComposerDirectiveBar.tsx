import { useMemo } from "react";
import { Target, X } from "lucide-react";
import type { SlashCommand } from "../../types";
import { formatCommandDescription, resolveSlashCommandMeta } from "./slashCommandHelpers";

export interface ActiveComposerDirective {
  readonly kind: "skill" | "command";
  readonly badgeLabel: string;
  readonly displayName: string;
  readonly description: string;
  readonly remainingText: string;
  readonly Icon: ReturnType<typeof resolveSlashCommandMeta>["Icon"];
}

const COMMITTED_LEADING_SLASH_RE = /^(\/([a-zA-Z0-9][a-zA-Z0-9:_-]*)\s+)([\s\S]*)$/;

export function resolveActiveComposerDirective(
  text: string,
  commands: readonly SlashCommand[],
): ActiveComposerDirective | null {
  const match = COMMITTED_LEADING_SLASH_RE.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const rawName = match[2];
  const remainingText = match[3] ?? "";
  const lower = rawName.toLowerCase();

  if (lower === "goal") {
    return {
      kind: "command",
      badgeLabel: "长程目标",
      displayName: "/goal",
      description: "自动拆解、持续推进并在达成前反复核查验收",
      remainingText,
      Icon: Target,
    };
  }

  if (lower.startsWith("skill:") && rawName.length > 6) {
    const slug = rawName.slice(6);
    const matched = commands.find((cmd) => cmd.name.toLowerCase() === lower);
    const meta = resolveSlashCommandMeta(matched ?? { name: rawName, source: "skill" });
    return {
      kind: "skill",
      badgeLabel: "技能",
      displayName: slug,
      description: formatCommandDescription(matched?.description, "遵循该技能的步骤与规范执行任务"),
      remainingText,
      Icon: meta.Icon,
    };
  }

  const matched =
    commands.find((cmd) => cmd.name.toLowerCase() === lower) ??
    commands.find((cmd) => cmd.name.toLowerCase() === `skill:${lower}`);
  if (!matched) return null;

  const meta = resolveSlashCommandMeta(matched);
  const isSkill = meta.tone === "skill";
  const slug = matched.name.startsWith("skill:") ? matched.name.slice(6) : matched.name;

  return {
    kind: isSkill ? "skill" : "command",
    badgeLabel: meta.badgeLabel,
    displayName: isSkill ? slug : `/${matched.name}`,
    description: formatCommandDescription(matched.description, meta.badgeLabel),
    remainingText,
    Icon: meta.Icon,
  };
}

export function ComposerDirectiveBar({
  text,
  commands,
  suppress = false,
  onClear,
}: {
  readonly text: string;
  readonly commands: readonly SlashCommand[];
  readonly suppress?: boolean;
  readonly onClear: (remainingText: string) => void;
}) {
  const directive = useMemo(
    () => (suppress ? null : resolveActiveComposerDirective(text, commands)),
    [commands, suppress, text],
  );
  if (directive === null) return null;

  const { Icon } = directive;
  return (
    <div
      className="qj-composer-directive-bar"
      data-kind={directive.kind}
      data-testid="composer-directive-bar"
    >
      <div className="qj-composer-directive-main">
        <span className="qj-composer-directive-pill">
          <Icon size={12} strokeWidth={2} aria-hidden="true" />
          <span className="qj-composer-directive-kind">{directive.badgeLabel}</span>
          <span>{directive.displayName}</span>
        </span>
        <span className="qj-composer-directive-desc">{directive.description}</span>
      </div>
      <button
        type="button"
        className="qj-composer-directive-clear"
        title={`移除${directive.badgeLabel}前缀`}
        aria-label={`移除${directive.badgeLabel} ${directive.displayName}`}
        onClick={() => onClear(directive.remainingText)}
      >
        <X size={12.5} strokeWidth={2} />
      </button>
    </div>
  );
}
