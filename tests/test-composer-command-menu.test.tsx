import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ComposerSuggestionMenus,
  filterAndRankSlashCommands,
  formatCommandDescription,
  resolveSlashCommandMeta,
  splitHighlightSegments,
} from "../src/components/composer/ComposerSuggestionMenus.tsx";
import {
  COMMAND_MENU_MAX_WIDTH,
  COMMAND_MENU_MIN_WIDTH,
  parseCommandMenuLayoutPrefs,
} from "../src/components/composer/slashCommandHelpers.ts";
import type { SlashCommand, WorkspaceDirEntry } from "../src/types.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

const SAMPLE_COMMANDS: SlashCommand[] = [
  { name: "browser-diagnose", description: "检查内置自动化浏览器的本机可执行文件与配置状态", source: "browser" },
  { name: "usage", description: "查看当前会话上下文占比与费用", argsHint: "[print]", source: "plugin" },
  { name: "skill:qianji-plugin-development", description: "千机动态插件开发工作流", argsHint: "[任务说明]", source: "skill" },
  { name: "mcp-status", description: "查看 MCP 服务器连接状态", source: "mcp" },
  { name: "rewind", description: "打开检查点回退时光机（快捷键：双击 `Esc`）", source: "plugin" },
  { name: "doctor", description: "检查宿主运行状态、模型服务商、插件与 MCP 连接", source: "builtin" },
  { name: "ui", description: "生成或查看交互式 Intelligent UI 组件（例如 `/ui 房贷计算器`）", argsHint: "[交互界面需求 | list | clear]", source: "intelligent-ui" },
  { name: "compact", description: "压缩当前会话上下文", source: "builtin" },
  { name: "plan", description: "查看当前会话的任务计划（传入 clear 清空计划）", argsHint: "[clear]", source: "plan" },
  { name: "logs", description: "查看三端闪退取证记录与错误日志", argsHint: "[crashes | plugins | <关键词>]", source: "plugin" },
  { name: "clear", description: "开启新对话", source: "builtin" },
];

describe("Composer `/` command & `@` mention menus", () => {
  it("ranks core commands ahead of plugin, skill and MCP/diagnostic groups when query is empty", () => {
    const ranked = filterAndRankSlashCommands(SAMPLE_COMMANDS, "");
    expect(ranked.map((item) => item.name)).toEqual([
      "clear",
      "compact",
      "plan",
      "ui",
      "doctor",
      "logs",
      "rewind",
      "usage",
      "skill:qianji-plugin-development",
      "browser-diagnose",
      "mcp-status",
    ]);
  });

  it("matches exact/prefix, sub-token, Chinese description keywords, and avoids false positives on paths", () => {
    expect(filterAndRankSlashCommands(SAMPLE_COMMANDS, "mc").map((c) => c.name)).toEqual([
      "mcp-status",
      "doctor",
    ]);
    expect(filterAndRankSlashCommands(SAMPLE_COMMANDS, "status").map((c) => c.name)).toEqual(["mcp-status"]);
    expect(filterAndRankSlashCommands(SAMPLE_COMMANDS, "plug").map((c) => c.name)).toEqual([
      "skill:qianji-plugin-development",
    ]);
    expect(filterAndRankSlashCommands(SAMPLE_COMMANDS, "插件").map((c) => c.name)).toEqual([
      "doctor",
      "logs",
      "rewind",
      "usage",
      "skill:qianji-plugin-development",
    ]);
    expect(filterAndRankSlashCommands(SAMPLE_COMMANDS, "压缩").map((c) => c.name)).toEqual(["compact"]);
    expect(filterAndRankSlashCommands(SAMPLE_COMMANDS, "回退").map((c) => c.name)).toEqual(["rewind"]);
    expect(filterAndRankSlashCommands(SAMPLE_COMMANDS, "usr/local/bin")).toEqual([]);
  });

  it("localizes command sources and strips inline Markdown backticks in descriptions", () => {
    expect(resolveSlashCommandMeta({ name: "clear", source: "builtin" }).badgeLabel).toBe("内置");
    expect(resolveSlashCommandMeta({ name: "plan", source: "plan" }).badgeLabel).toBe("计划");
    expect(resolveSlashCommandMeta({ name: "ui", source: "intelligent-ui" }).badgeLabel).toBe("界面");
    expect(resolveSlashCommandMeta({ name: "browser-diagnose", source: "browser" }).badgeLabel).toBe("诊断");
    expect(resolveSlashCommandMeta({ name: "skill:audit", source: "skill" }).badgeLabel).toBe("技能");
    expect(resolveSlashCommandMeta({ name: "mcp-status", source: "mcp" }).badgeLabel).toBe("MCP");
    expect(resolveSlashCommandMeta({ name: "logs", source: "plugin" }).badgeLabel).toBe("插件");
    expect(resolveSlashCommandMeta({ name: "custom", source: "my-extension" }).badgeLabel).toBe("插件");

    expect(
      formatCommandDescription("生成组件（例如 `/ui 房贷计算器`）", "界面"),
    ).toBe("生成组件（例如 /ui 房贷计算器）");
    expect(formatCommandDescription("   ", "内置")).toBe("内置");
  });

  it("splits highlight segments case-insensitively", () => {
    expect(splitHighlightSegments("mcp-status", "STATUS")).toEqual([
      { text: "mcp-", matched: false },
      { text: "status", matched: true },
    ]);
    expect(splitHighlightSegments("compact", "")).toEqual([{ text: "compact", matched: false }]);
  });

  it("preserves ARIA listbox contract, shows group labels on bare `/`, and separates argsHint from name", () => {
    const bareMatches = filterAndRankSlashCommands(SAMPLE_COMMANDS, "");
    const activeCommand = bareMatches.find((item) => item.name === "ui");
    const htmlBare = renderToStaticMarkup(
      <ComposerSuggestionMenus
        commandMenuOpen={true}
        commandQuery=""
        commandMatches={bareMatches}
        activeCommand={activeCommand}
        chooseCommand={() => undefined}
        mentionMenuOpen={false}
        mentionQuery={null}
        mentionEntries={[]}
        mentionLoading={false}
        activeEntry={undefined}
        chooseEntry={() => undefined}
        suggestionsId="sug-1"
        suggestionMenuRef={{ current: null }}
        setSuggestionIndex={() => undefined}
      />,
    );

    expect(htmlBare).toContain('id="sug-1" role="listbox" aria-label="快捷指令"');
    expect(htmlBare).toContain('class="command-menu-group-label"');
    expect(htmlBare).toContain("常用指令");
    expect(htmlBare).toContain("插件扩展");
    expect(htmlBare).toContain('id="sug-1-3" data-suggestion-index="3" type="button" class="command-menu-item active" role="option" aria-selected="true"');
    expect(htmlBare).toContain('<span class="command-item-name"><span class="command-item-slash">/</span><span>ui</span></span>');
    expect(htmlBare).toContain('<span class="command-item-args">[交互界面需求 | list | clear]</span>');
    expect(htmlBare).not.toContain('class="command-item-match"');
    expect(htmlBare).toContain('class="command-menu-expand-btn"');
    expect(htmlBare).toContain('class="command-menu-resizer"');

    const filtered = filterAndRankSlashCommands(SAMPLE_COMMANDS, "comp");
    const htmlFiltered = renderToStaticMarkup(
      <ComposerSuggestionMenus
        commandMenuOpen={true}
        commandQuery="comp"
        commandMatches={filtered}
        activeCommand={filtered[0]}
        chooseCommand={() => undefined}
        mentionMenuOpen={false}
        mentionQuery={null}
        mentionEntries={[]}
        mentionLoading={false}
        activeEntry={undefined}
        chooseEntry={() => undefined}
        suggestionsId="sug-2"
        suggestionMenuRef={{ current: null }}
        setSuggestionIndex={() => undefined}
      />,
    );

    expect(htmlFiltered).not.toContain('class="command-menu-group-label"');
    expect(htmlFiltered).toContain('<mark class="command-item-match">comp</mark>');
    expect(htmlFiltered).toContain("匹配指令");
  });

  it("renders `@` file mention menu in the unified listbox shell", () => {
    const entries: WorkspaceDirEntry[] = [
      { path: "src/components", name: "components", isDir: true },
      { path: "src/App.tsx", name: "App.tsx", isDir: false },
    ];
    const html = renderToStaticMarkup(
      <ComposerSuggestionMenus
        commandMenuOpen={false}
        commandQuery={null}
        commandMatches={[]}
        activeCommand={undefined}
        chooseCommand={() => undefined}
        mentionMenuOpen={true}
        mentionQuery="app"
        mentionEntries={entries}
        mentionLoading={false}
        activeEntry={entries[0]}
        chooseEntry={() => undefined}
        suggestionsId="mention-1"
        suggestionMenuRef={{ current: null }}
        setSuggestionIndex={() => undefined}
      />,
    );

    expect(html).toContain('class="command-menu mention-menu"');
    expect(html).toContain('id="mention-1" role="listbox" aria-label="引用文件"');
    expect(html).toContain('class="mention-item active" role="option" aria-selected="true"');
    expect(html).toContain('data-dir="true"');
    expect(html).toContain('components/');
    expect(html).toContain('class="command-menu-expand-btn"');
    expect(html).toContain('class="command-menu-resizer"');
  });

  it("parses and clamps persisted command-menu layout preferences safely", () => {
    expect(parseCommandMenuLayoutPrefs(null)).toEqual({ expanded: false, customWidth: null });
    expect(parseCommandMenuLayoutPrefs("not-json")).toEqual({ expanded: false, customWidth: null });
    expect(parseCommandMenuLayoutPrefs(JSON.stringify({ expanded: true, customWidth: null }))).toEqual({
      expanded: true,
      customWidth: null,
    });
    expect(parseCommandMenuLayoutPrefs(JSON.stringify({ expanded: false, customWidth: 120 }))).toEqual({
      expanded: false,
      customWidth: COMMAND_MENU_MIN_WIDTH,
    });
    expect(parseCommandMenuLayoutPrefs(JSON.stringify({ expanded: false, customWidth: 9999 }))).toEqual({
      expanded: false,
      customWidth: COMMAND_MENU_MAX_WIDTH,
    });
    expect(parseCommandMenuLayoutPrefs(JSON.stringify({ expanded: false, customWidth: 824.6 }))).toEqual({
      expanded: false,
      customWidth: 825,
    });
  });

  it("enforces @layer components CSS ordering, adaptive width, expand/resize controls, and tooltip styling", () => {
    const indexCss = readFileSync(resolve(REPO_ROOT, "src/styles/index.css"), "utf8");
    const skinComposerCss = readFileSync(resolve(REPO_ROOT, "src/styles/skin-composer.css"), "utf8");
    const composerMenusCss = readFileSync(resolve(REPO_ROOT, "src/styles/composer-menus.css"), "utf8");

    expect(indexCss).toMatch(/@import\s+"\.\/composer-menus\.css"\s+layer\(components\);/);
    expect(skinComposerCss).not.toContain(".command-menu-item");
    expect(composerMenusCss).not.toContain("width: min(500px");
    expect(composerMenusCss).toContain('[data-expanded="true"]');
    expect(composerMenusCss).toContain(".command-menu-resizer");
    expect(composerMenusCss).toContain(".command-menu-tooltip");
  });
});
