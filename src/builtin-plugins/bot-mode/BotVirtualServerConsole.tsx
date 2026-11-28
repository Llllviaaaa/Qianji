/**
 * Local (WSL2 Container) & Remote (OpenSSH) Virtual Server Console (`虚拟服务器` tab).
 */
import { useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { HardDrive, Play, RotateCcw, Server } from "lucide-react";
import { useAppStore, useFrontendService } from "@qianji/client";
import { Switch } from "@qianji/client-primitives";
import { useBotController, useBotSnapshot, useBotUiState } from "./botStore";

function parseHostPort(raw: string, fallbackPort: number): { readonly host: string; readonly port: number } {
  const trimmed = raw.trim();
  const idx = trimmed.lastIndexOf(":");
  if (idx > 0 && idx < trimmed.length - 1) {
    const portNum = Number(trimmed.slice(idx + 1));
    if (Number.isFinite(portNum) && portNum > 0 && portNum <= 65535) {
      return { host: trimmed.slice(0, idx).trim(), port: Math.round(portNum) };
    }
  }
  return { host: trimmed, port: fallbackPort };
}

export function VirtualServerConsole({ ctx }: { readonly ctx?: Context }): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const workspaceService = useFrontendService("workspaceService", ctx);
  const navigationService = useFrontendService("navigationService", ctx);
  const appSettings = useAppStore((s) => s.settings);
  const saveAppSettings = useAppStore((s) => s.saveSettings);
  const vs = snapshot.virtualServer;

  const [storageDraft, setStorageDraft] = useState(vs.local.customStorageDir ?? "");
  const [storageKey, setStorageKey] = useState(vs.local.customStorageDir ?? "");
  if (storageKey !== (vs.local.customStorageDir ?? "")) {
    setStorageKey(vs.local.customStorageDir ?? "");
    setStorageDraft(vs.local.customStorageDir ?? "");
  }

  const applyStorageDir = async (nextDir: string) => {
    const clean = nextDir.trim();
    setStorageDraft(clean);
    await ctrl.configureServer({ storageDir: clean });
    if (appSettings !== null) {
      await saveAppSettings({ ...appSettings, botStorageDir: clean });
    }
    navigationService?.showToast(
      clean ? `虚拟服务器存储目录已迁移至：${clean}` : "已恢复默认虚拟服务器存储目录",
      "info",
    );
  };

  const [shareAccess, setShareAccess] = useState<"read-only" | "isolated-copy">("read-only");
  const [endpointDraft, setEndpointDraft] = useState(
    vs.remote.host ? `${vs.remote.host}:${vs.remote.port || 22}` : "",
  );
  const [userDraft, setUserDraft] = useState(vs.remote.username || "ubuntu");
  const [dirDraft, setDirDraft] = useState(vs.remote.workDir || "~/.qianji-vm");
  const [authMethod, setAuthMethod] = useState<"agent-or-key" | "password">(
    vs.remote.authMethod ?? "agent-or-key",
  );
  const [keyPathDraft, setKeyPathDraft] = useState(vs.remote.privateKeyPath ?? "");
  const [passwordDraft, setPasswordDraft] = useState("");

  const handleMountSharedFolder = async () => {
    const picked = await workspaceService?.pickFolder().catch(() => null);
    if (picked && picked.trim() !== "") {
      await ctrl.configureServer({ sharedFolderAdd: { path: picked.trim(), access: shareAccess } });
    }
  };

  const syncRemoteAndRun = async (action: "test-remote" | "init-remote") => {
    const { host, port } = parseHostPort(endpointDraft, vs.remote.port || 22);
    await ctrl.configureServer({
      mode: "remote",
      remoteHost: host,
      remotePort: port,
      remoteUser: userDraft.trim() || "ubuntu",
      remoteWorkDir: dirDraft.trim() || "~/.qianji-vm",
      remoteAuthMethod: authMethod,
      remotePrivateKeyPath: keyPathDraft.trim(),
      ...(passwordDraft !== "" ? { remotePassword: passwordDraft } : {}),
    });
    setPasswordDraft("");
    await ctrl.runServerAction(action);
  };

  const isWsl = vs.local.engine === "wsl2";
  const needsProvision = isWsl && vs.local.engineState === "not-installed";
  const isSleeping = vs.lifecycle === "sleeping" || vs.local.engineState === "stopped";
  const memPct = Math.min(100, Math.round((vs.local.memoryUsedGb / Math.max(1, vs.local.memoryLimitGb)) * 100));
  const diskPct = Math.min(100, Math.round((vs.local.diskUsedGb / Math.max(1, vs.local.diskLimitGb)) * 100));
  const cpuPct = Math.min(100, Math.round((vs.local.cpuCores / 8) * 100));

  const modes = [
    {
      id: "local" as const,
      Icon: HardDrive,
      title: "本地虚拟服务器（WSL2 隔离容器）",
      desc: "基于本机 WSL2 创建独立 ext4 虚拟磁盘与 Alpine Linux 容器，屏蔽宿主机盘符并限制 CPU/内存配额",
    },
    {
      id: "remote" as const,
      Icon: Server,
      title: "远端虚拟服务器（SSH 7×24h）",
      desc: "通过 OpenSSH 连接自有云服务器或家用 Linux 主机，合盖关机后依然持续在线守护与执行",
    },
  ];

  return (
    <div className="qj-bset-stack">
      <div className="qj-bset-grid-2">
        {modes.map((m) => {
          const active = vs.mode === m.id;
          return (
            <button
              key={m.id}
              type="button"
              data-vserver-mode={m.id}
              onClick={() => void ctrl.configureServer({ mode: m.id })}
              className={`qj-bset-mode-card${active ? " active" : ""}`}
            >
              <div className="qj-bset-mode-top">
                <span className="qj-bset-mode-icon">
                  <m.Icon size={16} />
                </span>
                <span className={`qj-bset-mode-pill${active ? " active" : ""}`}>
                  {active ? "当前运行环境" : "切换至此环境"}
                </span>
              </div>
              <div className="qj-bset-mode-title">{m.title}</div>
              <div className="qj-bset-mode-desc">{m.desc}</div>
            </button>
          );
        })}
      </div>

      {ui.serverFeedback !== null && (
        <div className="qj-bset-callout">{ui.serverFeedback}</div>
      )}

      {vs.mode === "local" ? (
        <>
          <section className="qj-bset-group">
            <div className="qj-bset-group-head">
              <span className="qj-bset-group-title">容器实例与资源配额</span>
            </div>

            <div className="qj-bset-card">
              <div className="qj-bset-row">
                <div className="qj-bset-row-copy">
                  <div className="qj-bset-row-title">
                    <span
                      className="qj-bset-status-dot"
                      data-tone={needsProvision ? "muted" : isSleeping ? "warning" : "success"}
                    />
                    <span>
                      {isWsl ? `WSL2 容器 (${vs.local.distroName ?? "qianji-bot-vm"})` : "宿主机隔离目录"} ·{" "}
                      {needsProvision ? "尚未初始化" : isSleeping ? "休眠待命" : "运行中"}（{vs.uptimeLabel}）
                    </span>
                  </div>
                  <div className="qj-bset-row-desc qj-bset-mono-sub">
                    {vs.local.kernelVersion ? `${vs.local.kernelVersion} · ` : ""}
                    {vs.local.isolationSummary ?? "独立隔离执行环境"}
                  </div>
                </div>
                <label className="qj-bset-inline-field">
                  <span>空闲自动休眠</span>
                  <Switch
                    checked={vs.local.autoSleepIdle}
                    onCheckedChange={(checked) => void ctrl.configureServer({ autoSleepIdle: checked })}
                    aria-label="空闲自动休眠"
                  />
                </label>
              </div>

              {needsProvision && (
                <div className="qj-bset-row">
                  <div className="qj-bset-row-copy">
                    <div className="qj-bset-row-title">创建专属 WSL2 容器实例（约 3.5 MB 轻量镜像）</div>
                    <div className="qj-bset-row-desc">
                      自动下载 Alpine rootfs、禁用宿主机盘符透传并生成纯净恢复快照。
                    </div>
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
                <div className="qj-bset-quota-card">
                  <div className="qj-bset-quota-head">
                    <span>cgroup CPU 上限</span>
                    <select
                      aria-label="处理器核数"
                      value={String(vs.local.cpuCores)}
                      onChange={(e) => void ctrl.configureServer({ cpuCores: Number(e.target.value) })}
                      className="qj-bset-quota-select"
                    >
                      <option value="2">2 核</option>
                      <option value="4">4 核</option>
                      <option value="8">8 核</option>
                    </select>
                  </div>
                  <div className="qj-bset-quota-val">{vs.local.cpuCores} 核配额</div>
                  <div className="qj-bset-meter">
                    <span style={{ width: `${cpuPct}%` }} />
                  </div>
                </div>

                <div className="qj-bset-quota-card">
                  <div className="qj-bset-quota-head">
                    <span>cgroup 内存限额</span>
                    <select
                      aria-label="内存限额"
                      value={String(vs.local.memoryLimitGb)}
                      onChange={(e) => void ctrl.configureServer({ memoryLimitGb: Number(e.target.value) })}
                      className="qj-bset-quota-select"
                    >
                      <option value="2">2 GB</option>
                      <option value="4">4 GB</option>
                      <option value="8">8 GB</option>
                    </select>
                  </div>
                  <div className="qj-bset-quota-val">
                    {vs.local.memoryUsedGb} / {vs.local.memoryLimitGb} GB
                  </div>
                  <div className="qj-bset-meter">
                    <span style={{ width: `${memPct}%` }} />
                  </div>
                </div>

                <div className="qj-bset-quota-card">
                  <div className="qj-bset-quota-head">
                    <span>VHDX 虚拟磁盘</span>
                    <select
                      aria-label="磁盘配额"
                      value={String(vs.local.diskLimitGb)}
                      onChange={(e) => void ctrl.configureServer({ diskLimitGb: Number(e.target.value) })}
                      className="qj-bset-quota-select"
                    >
                      <option value="16">16 GB</option>
                      <option value="32">32 GB</option>
                      <option value="64">64 GB</option>
                    </select>
                  </div>
                  <div className="qj-bset-quota-val">
                    {vs.local.diskUsedGb} / {vs.local.diskLimitGb} GB
                  </div>
                  <div className="qj-bset-meter">
                    <span style={{ width: `${diskPct}%` }} />
                  </div>
                </div>
              </div>

              <div className="qj-bset-subbar between">
                <div className="qj-bset-chip-editor">
                  <span className="qj-bset-muted-label">挂载至 /shared：</span>
                  {vs.local.sharedFolders.map((sf) => (
                    <span key={sf.path} className="qj-connector-chip">
                      <span>
                        {sf.path.split(/[\\/]/).pop() || sf.path} ({sf.access === "read-only" ? "只读" : "副本"})
                      </span>
                      <button
                        type="button"
                        aria-label={`移除目录 ${sf.path}`}
                        onClick={() => void ctrl.configureServer({ sharedFolderRemove: sf.path })}
                      >
                        ×
                      </button>
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
                  <button type="button" className="qj-bset-btn soft xs" onClick={() => void handleMountSharedFolder()}>
                    + 挂载目录
                  </button>
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
                  <button
                    type="button"
                    disabled={ui.serverBusy}
                    className="qj-bset-btn soft sm"
                    onClick={() => void ctrl.runServerAction("reset-snapshot")}
                  >
                    <RotateCcw size={12} />
                    <span>一键重置环境</span>
                  </button>
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
                      当前存储：{vs.local.storageDir || "默认 (~/.qianji/bot)"} · /workspace →{" "}
                      {snapshot.botCwd || "默认"}
                    </div>
                  </div>
                  {Boolean(vs.local.customStorageDir) && (
                    <button
                      type="button"
                      className="qj-bset-btn soft xs"
                      onClick={() => void applyStorageDir("")}
                    >
                      恢复默认
                    </button>
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
                  <button
                    type="button"
                    className="qj-bset-btn primary sm"
                    onClick={() => void applyStorageDir(storageDraft)}
                  >
                    迁移存储目录
                  </button>
                </div>
              </div>
            </div>
          </section>
        </>
      ) : (
        <section className="qj-bset-group">
          <div className="qj-bset-group-head">
            <span className="qj-bset-group-title">远端 OpenSSH 主机配置</span>
          </div>
          <div className="qj-bset-card qj-bset-card-pad">
            <div className="qj-bset-grid-2">
              <label className="qj-bset-field">
                <span className="qj-bset-field-label">远端虚拟服务器地址</span>
                <input
                  type="text"
                  value={endpointDraft}
                  onChange={(e) => setEndpointDraft(e.target.value)}
                  placeholder="host.example.com:22 或 192.168.1.10:22"
                  className="qj-bset-input mono"
                />
              </label>

              <div className="qj-bset-field">
                <span className="qj-bset-field-label">账号与隔离工作目录</span>
                <div className="qj-bset-ssh-user-grid">
                  <input
                    type="text"
                    aria-label="远端用户名"
                    value={userDraft}
                    onChange={(e) => setUserDraft(e.target.value)}
                    placeholder="ubuntu"
                    className="qj-bset-input mono"
                  />
                  <input
                    type="text"
                    aria-label="远端工作目录"
                    value={dirDraft}
                    onChange={(e) => setDirDraft(e.target.value)}
                    placeholder="~/.qianji-vm"
                    className="qj-bset-input mono"
                  />
                </div>
              </div>
            </div>

            <div className="qj-bset-ssh-auth-grid">
              <label className="qj-bset-field">
                <span className="qj-bset-field-label">SSH 认证方式</span>
                <select
                  aria-label="SSH 认证方式"
                  value={authMethod}
                  onChange={(e) => setAuthMethod(e.target.value === "password" ? "password" : "agent-or-key")}
                  className="qj-bset-select"
                >
                  <option value="agent-or-key">密钥 / ssh-agent</option>
                  <option value="password">密码（安全存储）</option>
                </select>
              </label>

              {authMethod === "agent-or-key" ? (
                <label className="qj-bset-field">
                  <span className="qj-bset-field-label">SSH 私钥路径（留空则走系统 ssh-agent / ~/.ssh）</span>
                  <input
                    type="text"
                    value={keyPathDraft}
                    onChange={(e) => setKeyPathDraft(e.target.value)}
                    placeholder="如 C:\Users\you\.ssh\id_ed25519"
                    className="qj-bset-input mono"
                  />
                </label>
              ) : (
                <label className="qj-bset-field">
                  <span className="qj-bset-field-label">
                    SSH 密码{vs.remote.hasStoredSecret ? "（已加密存入安全存储，留空沿用）" : "（加密存入 OS Keychain）"}
                  </span>
                  <input
                    type="password"
                    value={passwordDraft}
                    onChange={(e) => setPasswordDraft(e.target.value)}
                    placeholder={vs.remote.hasStoredSecret ? "••••••••（已保存，输入可覆盖）" : "输入远端 SSH 登录密码"}
                    className="qj-bset-input mono"
                  />
                </label>
              )}
            </div>

            <div className="qj-bset-ssh-foot">
              <span className={`qj-bset-ssh-status${vs.lifecycle === "running" ? " online" : ""}`}>
                {vs.lifecycle === "running"
                  ? `● SSH 在线${vs.remote.osSummary ? ` (${vs.remote.osSummary})` : ""}${vs.latencyMs ? ` · ${vs.latencyMs}ms` : ""}`
                  : "○ 尚未完成远端 SSH 初始化"}
              </span>
              <div className="qj-bset-inline-controls">
                <button
                  type="button"
                  disabled={ui.serverBusy}
                  className="qj-bset-btn soft sm"
                  onClick={() => void syncRemoteAndRun("test-remote")}
                >
                  测试连接
                </button>
                <button
                  type="button"
                  disabled={ui.serverBusy}
                  className="qj-bset-btn primary sm"
                  onClick={() => void syncRemoteAndRun("init-remote")}
                >
                  {ui.serverBusy ? "连接中…" : "一键初始化环境"}
                </button>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
