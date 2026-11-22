/**
 * Local (WSL2 Container) & Remote (OpenSSH) Virtual Server Console (`虚拟服务器` tab).
 */
import { useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { useFrontendService } from "@qianji/client";
import { Switch } from "@qianji/client-primitives";
import { openBotModal, useBotController, useBotSnapshot, useBotUiState } from "./botStore";

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
  const vs = snapshot.virtualServer;

  const [shareAccess, setShareAccess] = useState<"read-only" | "isolated-copy">("read-only");
  const [endpointDraft, setEndpointDraft] = useState(vs.remote.host ? `${vs.remote.host}:${vs.remote.port || 22}` : "");
  const [userDraft, setUserDraft] = useState(vs.remote.username || "ubuntu");
  const [dirDraft, setDirDraft] = useState(vs.remote.workDir || "~/.qianji-vm");
  const [authMethod, setAuthMethod] = useState<"agent-or-key" | "password">(vs.remote.authMethod ?? "agent-or-key");
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

  const modes = [
    {
      id: "local" as const,
      title: "本地虚拟服务器（WSL2 隔离容器）",
      desc: "基于本机 WSL2 创建独立 ext4 虚拟磁盘与 Alpine Linux 容器，屏蔽宿主机盘符并限制 CPU/内存配额",
    },
    {
      id: "remote" as const,
      title: "远端虚拟服务器（SSH 7×24h）",
      desc: "通过 OpenSSH 连接自有云服务器或家用 Linux 主机，合盖关机后依然持续在线守护与执行",
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>虚拟服务器</h3>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--qj-text-secondary)" }}>
            分身在独立的专属 WSL2 容器或远端 SSH 服务器内执行工具与浏览器，彻底隔离你的个人电脑。
          </p>
        </div>
        <button
          type="button"
          className="qj-soft-btn"
          style={{ height: 32, padding: "0 14px", fontSize: 12, fontWeight: 520, flexShrink: 0 }}
          onClick={() => openBotModal("live-view")}
        >
          查看实时画面
        </button>
      </div>

      {/* Mode Selector */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {modes.map((m) => {
          const active = vs.mode === m.id;
          return (
            <button
              key={m.id}
              type="button"
              data-vserver-mode={m.id}
              onClick={() => void ctrl.configureServer({ mode: m.id })}
              style={{
                border: 0,
                borderRadius: 16,
                padding: 13,
                textAlign: "left",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                gap: 8,
                cursor: "pointer",
                background: "var(--muse-soft-fill)",
                color: "var(--qj-text-primary)",
                outline: active ? "2px solid var(--qj-text-primary)" : "none",
              }}
            >
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{m.title}</div>
                <div style={{ fontSize: 12, marginTop: 4, lineHeight: 1.5, color: "var(--qj-text-secondary)" }}>{m.desc}</div>
              </div>
              <span
                style={{
                  alignSelf: "flex-start",
                  padding: "2px 10px",
                  borderRadius: 9999,
                  fontSize: 11.5,
                  fontWeight: 520,
                  background: active ? "var(--muse-primary-bg)" : "var(--qj-bg-surface)",
                  color: active ? "var(--muse-primary-fg)" : "var(--qj-text-secondary)",
                }}
              >
                {active ? "当前运行模式" : "切换至此环境"}
              </span>
            </button>
          );
        })}
      </div>

      {ui.serverFeedback !== null && (
        <div style={{ padding: "9px 14px", borderRadius: 14, background: "var(--muse-soft-fill)", fontSize: 12 }}>
          {ui.serverFeedback}
        </div>
      )}

      {vs.mode === "local" ? (
        <div style={{ padding: 15, borderRadius: 18, background: "var(--muse-soft-fill)", display: "flex", flexDirection: "column", gap: 11, fontSize: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {isWsl ? `WSL2 容器 (${vs.local.distroName ?? "qianji-bot-vm"})` : "宿主机隔离目录"} ·{" "}
                {needsProvision ? "尚未初始化" : isSleeping ? "休眠待命" : "运行中"}（{vs.uptimeLabel}）
              </div>
              <div style={{ fontSize: 11, color: "var(--qj-text-muted)", marginTop: 2, fontFamily: "var(--qj-font-mono)" }}>
                {vs.local.kernelVersion ? `${vs.local.kernelVersion} · ` : ""}
                {vs.local.isolationSummary ?? "独立隔离执行环境"}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--qj-text-secondary)", flexShrink: 0 }}>
              <span>空闲自动休眠</span>
              <Switch
                checked={vs.local.autoSleepIdle}
                onCheckedChange={(checked) => void ctrl.configureServer({ autoSleepIdle: checked })}
                aria-label="空闲自动休眠"
              />
            </div>
          </div>

          {needsProvision && (
            <div style={{ padding: 12, borderRadius: 14, background: "var(--qj-bg-surface)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 12.5 }}>创建专属 WSL2 容器实例（约 3.5 MB 轻量镜像）</div>
                <div style={{ color: "var(--qj-text-secondary)", marginTop: 2 }}>
                  自动下载 Alpine rootfs、禁用宿主机盘符透传并生成纯净恢复快照。
                </div>
              </div>
              <button
                type="button"
                data-testid="provision-wsl-btn"
                className="qj-primary-pill-btn"
                disabled={ui.serverBusy}
                style={{ height: 34, padding: "0 14px", fontSize: 12, fontWeight: 550, flexShrink: 0 }}
                onClick={() => void ctrl.runServerAction("provision-local")}
              >
                {ui.serverBusy ? "初始化中…" : "一键初始化 WSL2 容器"}
              </button>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
            <div style={{ padding: 10, borderRadius: 12, background: "var(--qj-bg-surface)" }}>
              <div style={{ color: "var(--qj-text-muted)" }}>cgroup CPU 上限</div>
              <div style={{ fontWeight: 600, marginTop: 3, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>{vs.local.cpuCores} 核</span>
                <select
                  aria-label="处理器核数"
                  value={String(vs.local.cpuCores)}
                  onChange={(e) => void ctrl.configureServer({ cpuCores: Number(e.target.value) })}
                  style={{ border: 0, background: "transparent", color: "var(--qj-text-secondary)", fontSize: 11, cursor: "pointer" }}
                >
                  <option value="2">2核</option>
                  <option value="4">4核</option>
                  <option value="8">8核</option>
                </select>
              </div>
            </div>

            <div style={{ padding: 10, borderRadius: 12, background: "var(--qj-bg-surface)" }}>
              <div style={{ color: "var(--qj-text-muted)" }}>cgroup 内存限额</div>
              <div style={{ fontWeight: 600, marginTop: 3, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>{vs.local.memoryUsedGb} / {vs.local.memoryLimitGb} GB</span>
                <select
                  aria-label="内存限额"
                  value={String(vs.local.memoryLimitGb)}
                  onChange={(e) => void ctrl.configureServer({ memoryLimitGb: Number(e.target.value) })}
                  style={{ border: 0, background: "transparent", color: "var(--qj-text-secondary)", fontSize: 11, cursor: "pointer" }}
                >
                  <option value="2">2GB</option>
                  <option value="4">4GB</option>
                  <option value="8">8GB</option>
                </select>
              </div>
            </div>

            <div style={{ padding: 10, borderRadius: 12, background: "var(--qj-bg-surface)" }}>
              <div style={{ color: "var(--qj-text-muted)" }}>VHDX 虚拟磁盘</div>
              <div style={{ fontWeight: 600, marginTop: 3, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>{vs.local.diskUsedGb} / {vs.local.diskLimitGb} GB</span>
                <select
                  aria-label="磁盘配额"
                  value={String(vs.local.diskLimitGb)}
                  onChange={(e) => void ctrl.configureServer({ diskLimitGb: Number(e.target.value) })}
                  style={{ border: 0, background: "transparent", color: "var(--qj-text-secondary)", fontSize: 11, cursor: "pointer" }}
                >
                  <option value="16">16GB</option>
                  <option value="32">32GB</option>
                  <option value="64">64GB</option>
                </select>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", color: "var(--qj-text-secondary)" }}>
              <span>挂载至 /shared：</span>
              {vs.local.sharedFolders.map((sf) => (
                <span key={sf.path} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 9999, background: "var(--qj-bg-surface)", color: "var(--qj-text-primary)" }}>
                  <span>{sf.path.split(/[\\/]/).pop() || sf.path} ({sf.access === "read-only" ? "只读" : "副本"})</span>
                  <button type="button" aria-label={`移除目录 ${sf.path}`} onClick={() => void ctrl.configureServer({ sharedFolderRemove: sf.path })} style={{ border: 0, background: "transparent", color: "var(--qj-text-muted)", cursor: "pointer", padding: 0 }}>
                    ×
                  </button>
                </span>
              ))}
              <select
                aria-label="共享权限"
                value={shareAccess}
                onChange={(e) => setShareAccess(e.target.value === "isolated-copy" ? "isolated-copy" : "read-only")}
                style={{ border: 0, borderRadius: 9999, padding: "2px 8px", fontSize: 11.5, background: "var(--qj-bg-surface)", color: "var(--qj-text-secondary)" }}
              >
                <option value="read-only">只读挂载</option>
                <option value="isolated-copy">独立副本</option>
              </select>
              <button type="button" onClick={() => void handleMountSharedFolder()} style={{ border: 0, borderRadius: 9999, padding: "3px 9px", fontSize: 11.5, background: "var(--qj-bg-surface)", color: "var(--qj-text-primary)", cursor: "pointer" }}>
                + 挂载目录
              </button>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                disabled={ui.serverBusy}
                onClick={() => void ctrl.runServerAction(isSleeping || needsProvision ? "start" : "sleep")}
                style={{ height: 32, padding: "0 12px", borderRadius: 9999, border: 0, background: "var(--qj-bg-surface)", color: "var(--qj-text-primary)", fontSize: 12, cursor: "pointer" }}
              >
                {isSleeping || needsProvision ? "唤醒启动" : "休眠释放内存"}
              </button>
              <button
                type="button"
                disabled={ui.serverBusy}
                onClick={() => void ctrl.runServerAction("reset-snapshot")}
                style={{ height: 32, padding: "0 12px", borderRadius: 9999, border: 0, background: "var(--qj-bg-surface)", color: "var(--qj-text-primary)", fontSize: 12, cursor: "pointer" }}
              >
                一键重置环境
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ padding: 15, borderRadius: 18, background: "var(--muse-soft-fill)", display: "flex", flexDirection: "column", gap: 10, fontSize: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <div style={{ marginBottom: 4, color: "var(--qj-text-secondary)" }}>远端虚拟服务器地址</div>
              <input
                type="text"
                value={endpointDraft}
                onChange={(e) => setEndpointDraft(e.target.value)}
                placeholder="host.example.com:22 或 192.168.1.10:22"
                style={{ width: "100%", padding: "8px 12px", borderRadius: 12, border: 0, outline: "none", fontFamily: "var(--qj-font-mono)", fontSize: 12, background: "var(--qj-bg-surface)", color: "var(--qj-text-primary)" }}
              />
            </div>
            <div>
              <div style={{ marginBottom: 4, color: "var(--qj-text-secondary)" }}>账号与隔离工作目录</div>
              <div style={{ display: "grid", gridTemplateColumns: "88px 1fr", gap: 6 }}>
                <input type="text" aria-label="远端用户名" value={userDraft} onChange={(e) => setUserDraft(e.target.value)} placeholder="ubuntu" style={{ width: "100%", padding: "8px 10px", borderRadius: 12, border: 0, outline: "none", fontFamily: "var(--qj-font-mono)", fontSize: 12, background: "var(--qj-bg-surface)", color: "var(--qj-text-primary)" }} />
                <input type="text" aria-label="远端工作目录" value={dirDraft} onChange={(e) => setDirDraft(e.target.value)} placeholder="~/.qianji-vm" style={{ width: "100%", padding: "8px 10px", borderRadius: 12, border: 0, outline: "none", fontFamily: "var(--qj-font-mono)", fontSize: 12, background: "var(--qj-bg-surface)", color: "var(--qj-text-primary)" }} />
              </div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 10 }}>
            <div>
              <div style={{ marginBottom: 4, color: "var(--qj-text-secondary)" }}>SSH 认证方式</div>
              <select
                aria-label="SSH 认证方式"
                value={authMethod}
                onChange={(e) => setAuthMethod(e.target.value === "password" ? "password" : "agent-or-key")}
                style={{ width: "100%", padding: "8px 10px", borderRadius: 12, border: 0, background: "var(--qj-bg-surface)", color: "var(--qj-text-primary)", fontSize: 12 }}
              >
                <option value="agent-or-key">密钥 / ssh-agent</option>
                <option value="password">密码（安全存储）</option>
              </select>
            </div>
            {authMethod === "agent-or-key" ? (
              <div>
                <div style={{ marginBottom: 4, color: "var(--qj-text-secondary)" }}>SSH 私钥路径（留空则走系统 ssh-agent / ~/.ssh）</div>
                <input
                  type="text"
                  value={keyPathDraft}
                  onChange={(e) => setKeyPathDraft(e.target.value)}
                  placeholder="如 C:\Users\you\.ssh\id_ed25519"
                  style={{ width: "100%", padding: "8px 12px", borderRadius: 12, border: 0, outline: "none", fontFamily: "var(--qj-font-mono)", fontSize: 12, background: "var(--qj-bg-surface)", color: "var(--qj-text-primary)" }}
                />
              </div>
            ) : (
              <div>
                <div style={{ marginBottom: 4, color: "var(--qj-text-secondary)" }}>
                  SSH 密码{vs.remote.hasStoredSecret ? "（已加密存入安全存储，留空沿用）" : "（加密存入 OS Keychain）"}
                </div>
                <input
                  type="password"
                  value={passwordDraft}
                  onChange={(e) => setPasswordDraft(e.target.value)}
                  placeholder={vs.remote.hasStoredSecret ? "••••••••（已保存，输入可覆盖）" : "输入远端 SSH 登录密码"}
                  style={{ width: "100%", padding: "8px 12px", borderRadius: 12, border: 0, outline: "none", fontFamily: "var(--qj-font-mono)", fontSize: 12, background: "var(--qj-bg-surface)", color: "var(--qj-text-primary)" }}
                />
              </div>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, paddingTop: 2 }}>
            <span style={{ color: vs.lifecycle === "running" ? "var(--qj-status-success)" : "var(--qj-text-secondary)" }}>
              {vs.lifecycle === "running"
                ? `● SSH 在线${vs.remote.osSummary ? ` (${vs.remote.osSummary})` : ""}${vs.latencyMs ? ` · ${vs.latencyMs}ms` : ""}`
                : "○ 尚未完成远端 SSH 初始化"}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" disabled={ui.serverBusy} onClick={() => void syncRemoteAndRun("test-remote")} style={{ height: 32, padding: "0 12px", borderRadius: 9999, border: 0, background: "var(--qj-bg-surface)", color: "var(--qj-text-primary)", fontSize: 12, fontWeight: 520, cursor: "pointer" }}>
                测试连接
              </button>
              <button type="button" disabled={ui.serverBusy} className="qj-primary-pill-btn" style={{ height: 32, padding: "0 14px", fontSize: 12, fontWeight: 520 }} onClick={() => void syncRemoteAndRun("init-remote")}>
                {ui.serverBusy ? "连接中…" : "一键初始化环境"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
