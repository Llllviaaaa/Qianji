import type { Context } from "@deepseek-ai/cordis";
import {
  openPluginPage,
  openWorkbenchTab,
  sendChatPrompt,
  useHostRpcQuery,
  usePluginConfig,
} from "@qianji/client";
import { ExternalLink, Globe, Play, Terminal } from "lucide-react";

export const name = "web-preview";
export const inject = ["contributions", "styles"];

interface WebPreviewConfig {
  defaultPreviewUrl?: string;
}

interface DetectedScript {
  name: string;
  command: string;
}

interface WebProjectDetection {
  hasPackageJson: boolean;
  projectName: string;
  framework: string;
  scripts: DetectedScript[];
}

function WebPreviewHubPage({ cwd }: { cwd: string }) {
  const cfg = usePluginConfig<WebPreviewConfig>("web-preview", {
    defaultPreviewUrl: "http://localhost:5173",
  });
  const { data, loading } = useHostRpcQuery<WebProjectDetection>(
    "webPreview.detectProject",
    { cwd },
    { enabled: Boolean(cwd) },
  );

  const projectName = data?.projectName || cwd.split(/[\\/]/).filter(Boolean).pop() || "当前项目";
  const defaultUrl = cfg.defaultPreviewUrl?.trim() || "http://localhost:5173";

  return (
    <div className="wp-hub">
      <div className="wp-head">
        <span className="wp-icon">
          <Globe size={22} />
        </span>
        <div>
          <h1>站点预览中心</h1>
          <p>自动识别当前项目中的 Web 应用脚本，并配合右侧内置浏览器实时预览调试。</p>
        </div>
      </div>

      <div className="wp-card">
        <div className="wp-meta">
          <strong>{projectName}</strong>
          <span>{loading ? "正在识别工作区…" : data?.framework ?? "本地 Web 工作区"}</span>
        </div>

        <div className="wp-actions">
          <button
            type="button"
            className="wp-btn is-primary"
            onClick={() => openWorkbenchTab("preview")}
          >
            <ExternalLink size={13} />
            <span>打开右侧预览面板</span>
          </button>
          <button
            type="button"
            className="wp-btn"
            onClick={() => {
              void sendChatPrompt(
                `识别当前工作区的 Web 应用，启动本地开发服务器（参考默认预览地址 ${defaultUrl}），检查首页是否可用并报告真实地址；若启动失败请直接排查修复。`,
              );
            }}
          >
            <Play size={13} />
            <span>让 AI 启动并检查</span>
          </button>
        </div>
      </div>

      {data && data.scripts.length > 0 && (
        <div className="wp-scripts">
          <div className="wp-scripts-title">
            <Terminal size={13} />
            <span>已检测到可运行脚本</span>
          </div>
          <ul>
            {data.scripts.map((s) => (
              <li key={s.name}>
                <code>npm run {s.name}</code>
                <span>{s.command}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const SCOPED_CSS = `
.wp-hub {
  max-width: 720px;
  margin: 40px auto;
  padding: 0 24px;
  color: var(--text, inherit);
}
.wp-head {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 22px;
}
.wp-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: rgba(14, 165, 233, 0.14);
  color: #0ea5e9;
  flex-shrink: 0;
}
.wp-head h1 {
  margin: 0 0 4px;
  font-size: 20px;
  font-weight: 650;
}
.wp-head p {
  margin: 0;
  color: var(--text-2, #888);
  font-size: 13px;
}
.wp-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 18px 20px;
  border-radius: 14px;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.22));
  background: var(--panel, rgba(255, 255, 255, 0.04));
}
.wp-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.wp-meta strong {
  font-size: 15px;
}
.wp-meta span {
  font-size: 12px;
  color: var(--text-3, #888);
}
.wp-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.wp-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.28));
  background: transparent;
  color: var(--text, inherit);
  font-size: 12.5px;
  cursor: pointer;
}
.wp-btn.is-primary {
  background: var(--accent, #2563eb);
  border-color: transparent;
  color: #fff;
}
.wp-scripts {
  margin-top: 16px;
  padding: 14px 18px;
  border-radius: 12px;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.2));
}
.wp-scripts-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2, #888);
  margin-bottom: 10px;
}
.wp-scripts ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wp-scripts li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
}
.wp-scripts li span {
  color: var(--text-3, #888);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`;

export function apply(ctx: Context): void {
  ctx.styles.inject(SCOPED_CSS);

  ctx.contributions.registerPage({
    id: "sites",
    label: "站点预览",
    icon: <Globe size={15} />,
    order: 30,
    render: ({ cwd }) => <WebPreviewHubPage cwd={cwd} />,
  });

  ctx.contributions.registerSlashInterceptor({
    id: "web-preview:slash",
    order: 20,
    onSlashCommand: (cmd, rawArgs) => {
      if (cmd.toLowerCase() !== "preview") return false;
      const arg = rawArgs.trim().toLowerCase();
      if (arg === "hub" || arg === "sites") {
        return openPluginPage("sites");
      }
      if (arg === "") {
        openWorkbenchTab("preview");
        return true;
      }
      return false;
    },
  });

  ctx.contributions.registerMenuItem({
    id: "web-preview:sites-menu",
    location: "menubar.tools",
    label: "站点预览中心",
    icon: <Globe size={13} />,
    order: 25,
    onSelect: () => {
      openPluginPage("sites");
    },
  });
}

export default {
  name,
  inject,
  apply,
};
