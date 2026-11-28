/**
 * Local `2x2` Virtual Computer Configuration (`本地 Linux GUI 沙盒` + `本地 Windows 多开虚拟桌面`).
 */
import { useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { Cpu, Monitor, Play, RotateCcw, ShieldCheck } from "lucide-react";
import { useAppStore, useFrontendService } from "@qianji/client";
import { Switch } from "@qianji/client-primitives";
import { closeActiveBotModal, useBotController, useBotSnapshot, useBotUiState } from "../botStore";
import { openComputerStudio } from "./computerStudioStore";
import { useComputerStudio } from "./useComputerStudio";

export function BotVirtualServerLocalSection({ ctx }: { readonly ctx?: Context }): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const studio = useComputerStudio(ctx);
  const workspaceService = useFrontendService("workspaceService", ctx);
  const navigationService = useFrontendService("navigationService", ctx);
  const appSettings = useAppStore((s) => s.settings);
  const saveAppSettings = useAppStore((s) => s.saveSettings);

  const vs = snapshot.virtualServer;
  const localLinux = studio.snapshot.localLinux;
  const localWinPip = studio.snapshot.localWinPip;

  const [storageDraft, setStorageDraft] = useState(vs.local.customStorageDir ?? "");
  const [storageKey, setStorageKey] = useState(vs.local.customStorageDir ?? "");
  if (storageKey !== (vs.local.customStorageDir ?? "")) {
    setStorageKey(vs.local.customStorageDir ?? "");
    setStorageDraft(vs.local.customStorageDir ?? "");
  }
  const [shareAccess, setShareAccess] = useState<"read-only" | "isolated-copy">("read-only");

  const applyStorageDir = async (nextDir: string) => {
    const clean = nextDir.trim();
    setStorageDraft(clean);
    await ctrl.configureServer({ storageDir: clean });
    if (appSettings !== null) await saveAppSettings({ ...appSettings, botStorageDir: clean });
    navigationService?.showToast(
      clean ? `虚拟服务器存储目录已迁移至：${clean}` : "已恢复默认虚拟服务器存储目录",
      "info",
    );
  };

  const handleMountSharedFolder = async () => {
    const picked = await workspaceService?.pickFolder().catch(() => null);
    if (picked && picked.trim() !== "") {
      await ctrl.configureServer({ sharedFolderAdd: { path: picked.trim(), access: shareAccess } });
    }
  };

  const isWsl = vs.local.engine === "wsl2";
  const needsProvision = isWsl && vs.local.engineState === "not-installed";
  const isSleeping = vs.lifecycle === "sleeping" || vs.local.engineState === "stopped";
  const memPct = Math.min(100, Math.round((vs.local.memoryUsedGb / Math.max(1, vs.local.memoryLimitGb)) * 100));
  const diskPct = Math.min(100, Math.round((vs.local.diskUsedGb / Math.max(1, vs.local.diskLimitGb)) * 100));
  const cpuPct = Math.min(100, Math.round((vs.local.cpuCores / 8) * 100));

  const winBackendText =
    localWinPip?.backend === "unavailable"
      ? "仅在 Windows 宿主机可用"
      : localWinPip?.signOutRequired
        ? "RDP 子会话（已开启，待注销重登激活）"
        : localWinPip?.childSessionActive
          ? `RDP 子会话运行中 (Session #${localWinPip.childSessionId ?? 2}${localWinPip.viewerOpen ? " · 独立窗口已打开" : ""})`
          : localWinPip?.childSessionEnabled
            ? `RDP 子会话已就绪 (${localWinPip.desktopName})`
            : "RDP 子会话（尚未启用，首次需管理员开启）";

  const quotaItems = [
    {
      label: "cgroup CPU 上限",
      ariaLabel: "处理器核数",
      value: String(vs.local.cpuCores),
      options: [["2", "2 核"], ["4", "4 核"], ["8", "8 核"]] as const,
      summary: `${vs.local.cpuCores} 核配额`,
      pct: cpuPct,
      onChange: (n: number) => void ctrl.configureServer({ cpuCores: n }),
    },
    {
      label: "cgroup 内存限额",
      ariaLabel: "内存限额",
      value: String(vs.local.memoryLimitGb),
      options: [["2", "2 GB"], ["4", "4 GB"], ["8", "8 GB"]] as const,
      summary: `${vs.local.memoryUsedGb} / ${vs.local.memoryLimitGb} GB`,
      pct: memPct,
      onChange: (n: number) => void ctrl.configureServer({ memoryLimitGb: n }),
    },
    {
      label: "VHDX 虚拟磁盘",
      ariaLabel: "磁盘配额",
      value: String(vs.local.diskLimitGb),
      options: [["16", "16 GB"], ["32", "32 GB"], ["64", "64 GB"]] as const,
      summary: `${vs.local.diskUsedGb} / ${vs.local.diskLimitGb} GB`,
      pct: diskPct,
      onChange: (n: number) => void ctrl.configureServer({ diskLimitGb: n }),
    },
  ];

  return (
    <>
      <section className="qj-bset-group" data-testid="vserver-local-linux-card">
        <div className="qj-bset-group-head">
          <span className="qj-bset-group-title">本地 Linux GUI 沙盒（WSL2 容器 + Xvfb 桌面）</span>
          <button
            type="button"
            className="qj-bset-text-link"
            onClick={() => { closeActiveBotModal(); openComputerStudio({ engine: "local-linux", tab: "desktop" }); }}
          >
            <Cpu size={12.5} />
            <span>打开 Linux 桌面</span>
          </button>
        </div>

        <div className="qj-bset-card">
          <div className="qj-bset-row">
            <div className="qj-bset-row-copy">
              <div className="qj-bset-row-title">
                <span className="qj-bset-status-dot" data-tone={needsProvision ? "muted" : isSleeping ? "warning" : "success"} />
                <span>
                  {isWsl ? `WSL2 容器 (${vs.local.distroName ?? "qianji-bot-vm"})` : "宿主机隔离目录"} ·{" "}
                  {needsProvision ? "尚未初始化" : isSleeping ? "休眠待命" : "运行中"}（{vs.uptimeLabel}）
                </span>
                <span className="qj-bset-tag">
                  {localLinux?.provisioningStep
                    ? `部署中 (${localLinux.provisioningStep})`
                    : localLinux?.vncReady
                      ? `GUI ${localLinux.display} · ${localLinux.resolution} · VNC`
                      : localLinux?.guiReady
                        ? `GUI ${localLinux.display} · ${localLinux.resolution}`
                        : "CLI 模式"}
                </span>
              </div>
              <div className="qj-bset-row-desc qj-bset-mono-sub">
                {vs.local.kernelVersion ? `${vs.local.kernelVersion} · ` : ""}
                {vs.local.isolationSummary ?? "独立隔离执行环境"}
              </div>
            </div>
            <div className="qj-bset-inline-controls">
              <button
                type="button"
                data-testid="provision-linux-gui-btn"
                className="qj-bset-btn soft xs"
                disabled={studio.ui.busyAction === "provision-linux-gui"}
                onClick={() => void studio.runEngineAction({ engine: "local-linux", action: "provision-linux-gui" })}
              >
                {localLinux?.guiReady ? "校准 GUI 桌面" : "部署 GUI 桌面"}
              </button>
              <label className="qj-bset-inline-field">
                <span>空闲自动休眠</span>
                <Switch
                  checked={vs.local.autoSleepIdle}
                  onCheckedChange={(checked) => void ctrl.configureServer({ autoSleepIdle: checked })}
                  aria-label="空闲自动休眠"
                />
              </label>
            </div>
          </div>

          {needsProvision && (
            <div className="qj-bset-row">
              <div className="qj-bset-row-copy">
                <div className="qj-bset-row-title">创建专属 WSL2 容器实例（约 3.5 MB 轻量镜像）</div>
                <div className="qj-bset-row-desc">自动下载 Alpine/Ubuntu rootfs、禁用宿主机盘符透传并生成纯净恢复快照。</div>
              </div>
              <button
                type="button"
                data-testid="provision-wsl-btn"
                className="qj-bset-btn primary sm"
                disabled={ui.serverBusy}
                onClick={() => void ctrl.runServerAction("provision-local")}
              >
                {ui.serverBusy ? "初始化中…" : "一键初始化 WSL2 容器"}
              </button>
            </div>
          )}

          <div className="qj-bset-quota-grid">
            {quotaItems.map((q) => (
              <div key={q.label} className="qj-bset-quota-card">
                <div className="qj-bset-quota-head">
                  <span>{q.label}</span>
                  <select
                    aria-label={q.ariaLabel}
                    value={q.value}
                    onChange={(e) => q.onChange(Number(e.target.value))}
                    className="qj-bset-quota-select"
                  >
                    {q.options.map(([val, text]) => (
                      <option key={val} value={val}>{text}</option>
                    ))}
                  </select>
                </div>
                <div className="qj-bset-quota-val">{q.summary}</div>
                <div className="qj-bset-meter"><span style={{ width: `${q.pct}%` }} /></div>
              </div>
            ))}
          </div>

          <div className="qj-bset-subbar between">
            <div className="qj-bset-chip-editor">
              <span className="qj-bset-muted-label">挂载至 /shared：</span>
              {vs.local.sharedFolders.map((sf) => (
                <span key={sf.path} className="qj-connector-chip">
                  <span>{sf.path.split(/[\\/]/).pop() || sf.path} ({sf.access === "read-only" ? "只读" : "Git Worktree 副本"})</span>
                  <button type="button" aria-label={`移除目录 ${sf.path}`} onClick={() => void ctrl.configureServer({ sharedFolderRemove: sf.path })}>×</button>
                </span>
              ))}
              <select
                aria-label="共享权限"
                value={shareAccess}
                onChange={(e) => setShareAccess(e.target.value === "isolated-copy" ? "isolated-copy" : "read-only")}
                className="qj-bset-select compact"
              >
                <option value="read-only">只读挂载</option>
                <option value="isolated-copy">独立副本</option>
              </select>
              <button type="button" className="qj-bset-btn soft xs" onClick={() => void handleMountSharedFolder()}>+ 挂载目录</button>
            </div>

            <div className="qj-bset-inline-controls">
              <button
                type="button"
                disabled={ui.serverBusy}
                className="qj-bset-btn soft sm"
                onClick={() => void ctrl.runServerAction(isSleeping || needsProvision ? "start" : "sleep")}
              >
                <Play size={12} />
                <span>{isSleeping || needsProvision ? "唤醒启动" : "休眠释放内存"}</span>
              </button>
              <button type="button" disabled={ui.serverBusy} className="qj-bset-btn soft sm" onClick={() => void ctrl.runServerAction("reset-snapshot")}>
                <RotateCcw size={12} />
                <span>一键重置环境</span>
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="qj-bset-group" data-testid="vserver-local-win-pip-card">
        <div className="qj-bset-group-head">
          <span className="qj-bset-group-title">本地 Windows 多开虚拟桌面 · 当前账号派生不抢鼠标</span>
          <button
            type="button"
            className="qj-bset-text-link"
            onClick={() => { closeActiveBotModal(); openComputerStudio({ engine: "local-win-pip", tab: "desktop" }); }}
          >
            <Monitor size={12.5} />
            <span>打开 Win 多开副屏</span>
          </button>
        </div>

        <div className="qj-bset-card">
          <div className="qj-bset-row">
            <div className="qj-bset-row-copy">
              <div className="qj-bset-row-title">
                <span
                  className="qj-bset-status-dot"
                  data-tone={!localWinPip?.childSessionEnabled ? "muted" : localWinPip.signOutRequired ? "warning" : "success"}
                />
                <span>{winBackendText}</span>
                <span className="qj-bset-tag">当前账号派生 · 零锁屏免改密</span>
              </div>
              <div className="qj-bset-row-desc">
                复用当前登录 Windows 用户（非新建隐藏账号），独立子会话内执行键鼠与浏览器隔离，不抢占物理鼠标与前台输入焦点。
              </div>
            </div>
            <button
              type="button"
              data-testid="enable-win-child-session-btn"
              className="qj-bset-btn soft sm"
              disabled={studio.ui.busyAction === "enable-win-child-session" || studio.ui.busyAction === "open-native-desktop"}
              onClick={() =>
                void studio.runEngineAction({
                  engine: "local-win-pip",
                  action:
                    localWinPip?.childSessionEnabled && !localWinPip.signOutRequired
                      ? "open-native-desktop"
                      : "enable-win-child-session",
                })
              }
            >
              {localWinPip?.signOutRequired
                ? "待注销重登生效"
                : localWinPip?.childSessionEnabled
                  ? localWinPip.viewerOpen
                    ? "聚焦独立桌面窗口"
                    : "打开独立桌面窗口"
                  : "启用 RDP 子会话"}
            </button>
          </div>

          <div className="qj-bset-row">
            <div className="qj-bset-row-copy">
              <div className="qj-bset-row-title">
                <ShieldCheck size={14} className="qj-bset-inline-icon" />
                <span>独立浏览器 Profile 与 Sentinel 受控路径围栏</span>
              </div>
              <div className="qj-bset-row-desc qj-bset-mono-sub">
                Profile：{localWinPip?.isolatedProfileDir ?? "~/.qianji/bot/win-pip-browser-profile"} · 围栏根目录：
                {(localWinPip?.fencedRoots ?? []).length > 0 ? (localWinPip?.fencedRoots ?? []).join(" , ") : (snapshot.botCwd || "/workspace")}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="qj-bset-group">
        <div className="qj-bset-group-head">
          <span className="qj-bset-group-title">存储与磁盘迁移</span>
        </div>
        <div className="qj-bset-card">
          <div className="qj-bset-row stack">
            <div className="qj-bset-row-top">
              <div className="qj-bset-row-copy">
                <div className="qj-bset-row-title">虚拟磁盘与容器存储位置（释放 C 盘空间）</div>
                <div className="qj-bset-row-desc qj-bset-mono-sub">
                  当前存储：{vs.local.storageDir || "默认 (~/.qianji/bot)"} · /workspace → {snapshot.botCwd || "默认"}
                </div>
              </div>
              {Boolean(vs.local.customStorageDir) && (
                <button type="button" className="qj-bset-btn soft xs" onClick={() => void applyStorageDir("")}>恢复默认</button>
              )}
            </div>
            <div className="qj-bset-path-bar">
              <input
                type="text"
                aria-label="虚拟服务器存储目录"
                value={storageDraft}
                onChange={(e) => setStorageDraft(e.target.value)}
                placeholder="如 D:\QianjiVM（存放 ext4.vhdx、缓存与隔离副本）"
                className="qj-bset-input mono"
              />
              <button
                type="button"
                className="qj-bset-btn soft sm"
                onClick={async () => {
                  const picked = await workspaceService?.pickFolder().catch(() => null);
                  if (picked && picked.trim() !== "") await applyStorageDir(picked.trim());
                }}
              >
                选择目录
              </button>
              <button type="button" className="qj-bset-btn primary sm" onClick={() => void applyStorageDir(storageDraft)}>
                迁移存储目录
              </button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
