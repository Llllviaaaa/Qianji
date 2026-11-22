/**
 * Local & Remote Virtual Server Console (`虚拟服务器` tab inside Bot Settings).
 *
 * Matches `qianji-dual-mode-hifi.html` 1:1 while driving real Host metrics,
 * controlled shared-folder mounting, snapshot reset, and real TCP latency probes.
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

  const [endpointDraft, setEndpointDraft] = useState(
    vs.remote.host ? `${vs.remote.host}:${vs.remote.port || 22}` : "",
  );
  const [userDraft, setUserDraft] = useState(vs.remote.username || "ubuntu");
  const [dirDraft, setDirDraft] = useState(vs.remote.workDir || "~/.qianji-vm");

  const handleMountSharedFolder = async () => {
    const picked = await workspaceService?.pickFolder().catch(() => null);
    if (picked && picked.trim() !== "") {
      await ctrl.configureServer({
        sharedFolderAdd: { path: picked.trim(), access: "isolated-copy" },
      });
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
    });
    await ctrl.runServerAction(action);
  };

  const modes = [
    {
      id: "local" as const,
      title: "本地虚拟服务器（本机隔离环境）",
      desc: "在本机开辟与个人电脑严格隔离的分身专属虚拟服务器，支持资源限额、受控共享目录与空闲自动休眠",
    },
    {
      id: "remote" as const,
      title: "远端虚拟服务器（7×24h 全天候在线）",
      desc: "连接你自己的远端虚拟服务器，笔记本合盖关机后依然持续巡检、收信与执行通宵任务",
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>虚拟服务器</h3>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--qj-text-secondary)" }}>
            分身在独立的专属虚拟服务器内运行任务与浏览器，不弄乱你的个人电脑。
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

      {/* Mode Selector Cards */}
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
                padding: 14,
                textAlign: "left",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                gap: 10,
                cursor: "pointer",
                background: "var(--muse-soft-fill)",
                color: "var(--qj-text-primary)",
                outline: active ? "2px solid var(--qj-text-primary)" : "none",
              }}
            >
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{m.title}</div>
                <div style={{ fontSize: 12, marginTop: 4, lineHeight: 1.55, color: "var(--qj-text-secondary)" }}>
                  {m.desc}
                </div>
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
                {active ? "当前运行中" : "切换至此环境"}
              </span>
            </button>
          );
        })}
      </div>

      {ui.serverFeedback !== null && (
        <div
          style={{
            padding: "9px 14px",
            borderRadius: 14,
            background: "var(--muse-soft-fill)",
            fontSize: 12,
            color: "var(--qj-text-primary)",
          }}
        >
          {ui.serverFeedback}
        </div>
      )}

      {vs.mode === "local" ? (
        <div
          style={{
            padding: 16,
            borderRadius: 18,
            background: "var(--muse-soft-fill)",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            fontSize: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              本地虚拟服务器状态 · {vs.lifecycle === "sleeping" ? "已休眠" : "运行中"}（{vs.uptimeLabel}）
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--qj-text-secondary)" }}>
              <span>空闲自动休眠</span>
              <Switch
                checked={vs.local.autoSleepIdle}
                onCheckedChange={(checked) => void ctrl.configureServer({ autoSleepIdle: checked })}
                aria-label="空闲自动休眠"
              />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
            <div style={{ padding: 10, borderRadius: 12, background: "var(--qj-bg-surface)" }}>
              <div style={{ color: "var(--qj-text-muted)" }}>处理器配额</div>
              <div style={{ fontWeight: 600, marginTop: 3, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>{vs.local.cpuCores} 核（占用 {vs.local.cpuUsagePercent}%）</span>
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
              <div style={{ color: "var(--qj-text-muted)" }}>内存限额</div>
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
              <div style={{ color: "var(--qj-text-muted)" }}>虚拟磁盘</div>
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
              <span>受控共享目录：</span>
              {vs.local.sharedFolders.length === 0 ? (
                <span style={{ color: "var(--qj-text-muted)" }}>未挂载外部目录</span>
              ) : (
                vs.local.sharedFolders.map((sf) => (
                  <span
                    key={sf.path}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "2px 8px",
                      borderRadius: 9999,
                      background: "var(--qj-bg-surface)",
                      color: "var(--qj-text-primary)",
                    }}
                  >
                    <span>{sf.path.split(/[\\/]/).pop() || sf.path}</span>
                    <button
                      type="button"
                      aria-label={`移除目录 ${sf.path}`}
                      onClick={() => void ctrl.configureServer({ sharedFolderRemove: sf.path })}
                      style={{ border: 0, background: "transparent", color: "var(--qj-text-muted)", cursor: "pointer", padding: 0 }}
                    >
                      ×
                    </button>
                  </span>
                ))
              )}
              <button
                type="button"
                onClick={() => void handleMountSharedFolder()}
                style={{
                  border: 0,
                  borderRadius: 9999,
                  padding: "3px 9px",
                  fontSize: 11.5,
                  background: "var(--qj-bg-surface)",
                  color: "var(--qj-text-primary)",
                  cursor: "pointer",
                }}
              >
                + 挂载目录
              </button>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => void ctrl.runServerAction(vs.lifecycle === "sleeping" ? "start" : "sleep")}
                style={{
                  height: 32,
                  padding: "0 12px",
                  borderRadius: 9999,
                  border: 0,
                  background: "var(--qj-bg-surface)",
                  color: "var(--qj-text-primary)",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {vs.lifecycle === "sleeping" ? "唤醒" : "休眠"}
              </button>
              <button
                type="button"
                onClick={() => void ctrl.runServerAction("reset-snapshot")}
                style={{
                  height: 32,
                  padding: "0 12px",
                  borderRadius: 9999,
                  border: 0,
                  background: "var(--qj-bg-surface)",
                  color: "var(--qj-text-primary)",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                一键重置环境
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div
          style={{
            padding: 16,
            borderRadius: 18,
            background: "var(--muse-soft-fill)",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            fontSize: 12,
          }}
        >
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <div style={{ marginBottom: 4, color: "var(--qj-text-secondary)" }}>远端虚拟服务器地址</div>
              <input
                type="text"
                value={endpointDraft}
                onChange={(e) => setEndpointDraft(e.target.value)}
                placeholder="host.example.com:22 或 192.168.1.10:22"
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  borderRadius: 12,
                  border: 0,
                  outline: "none",
                  fontFamily: "var(--qj-font-mono)",
                  fontSize: 12,
                  background: "var(--qj-bg-surface)",
                  color: "var(--qj-text-primary)",
                }}
              />
            </div>
            <div>
              <div style={{ marginBottom: 4, color: "var(--qj-text-secondary)" }}>账号与隔离工作目录</div>
              <div style={{ display: "grid", gridTemplateColumns: "92px 1fr", gap: 6 }}>
                <input
                  type="text"
                  aria-label="远端用户名"
                  value={userDraft}
                  onChange={(e) => setUserDraft(e.target.value)}
                  placeholder="ubuntu"
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    borderRadius: 12,
                    border: 0,
                    outline: "none",
                    fontFamily: "var(--qj-font-mono)",
                    fontSize: 12,
                    background: "var(--qj-bg-surface)",
                    color: "var(--qj-text-primary)",
                  }}
                />
                <input
                  type="text"
                  aria-label="远端工作目录"
                  value={dirDraft}
                  onChange={(e) => setDirDraft(e.target.value)}
                  placeholder="~/.qianji-vm"
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    borderRadius: 12,
                    border: 0,
                    outline: "none",
                    fontFamily: "var(--qj-font-mono)",
                    fontSize: 12,
                    background: "var(--qj-bg-surface)",
                    color: "var(--qj-text-primary)",
                  }}
                />
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, paddingTop: 4 }}>
            <span style={{ color: vs.lifecycle === "running" ? "var(--qj-status-success)" : "var(--qj-text-secondary)" }}>
              {vs.lifecycle === "running"
                ? `● 远端虚拟服务器在线${vs.latencyMs ? ` · 延迟 ${vs.latencyMs}ms` : ""}`
                : "○ 尚未连接远端虚拟服务器"}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => void syncRemoteAndRun("test-remote")}
                style={{
                  height: 32,
                  padding: "0 12px",
                  borderRadius: 9999,
                  border: 0,
                  background: "var(--qj-bg-surface)",
                  color: "var(--qj-text-primary)",
                  fontSize: 12,
                  fontWeight: 520,
                  cursor: "pointer",
                }}
              >
                测试连接
              </button>
              <button
                type="button"
                className="qj-primary-pill-btn"
                style={{ height: 32, padding: "0 14px", fontSize: 12, fontWeight: 520 }}
                onClick={() => void syncRemoteAndRun("init-remote")}
              >
                一键初始化环境
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
