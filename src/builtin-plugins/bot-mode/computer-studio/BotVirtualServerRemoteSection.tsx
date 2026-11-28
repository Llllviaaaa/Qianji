/**
 * Remote `2x2` Virtual Computer Configuration (`远程 Linux 虚拟机 SSH` + `远程个人电脑节点 Mac mini/PC + 离线自治租约`).
 */
import { useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { Cloud, Laptop, Plus, RefreshCw, Trash2 } from "lucide-react";
import { closeActiveBotModal, useBotController, useBotSnapshot, useBotUiState } from "../botStore";
import { openComputerStudio } from "./computerStudioStore";
import { useComputerStudio } from "./useComputerStudio";

export function parseHostPort(
  raw: string,
  fallbackPort: number,
): { readonly host: string; readonly port: number } {
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

export function BotVirtualServerRemoteSection({ ctx }: { readonly ctx?: Context }): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const studio = useComputerStudio(ctx);
  const vs = snapshot.virtualServer;

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

  const [pcAliasDraft, setPcAliasDraft] = useState("");
  const [pcEndpointDraft, setPcEndpointDraft] = useState("");
  const [pcUserDraft, setPcUserDraft] = useState("");

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

  const companionNodes = studio.snapshot.remoteNodes.filter((n) => n.kind === "companion-pc");

  const handleAddCompanionPc = async () => {
    const { host, port } = parseHostPort(pcEndpointDraft, 22);
    if (host === "") return;
    await studio.upsertRemoteNode({
      alias: pcAliasDraft.trim() || `个人电脑 (${host})`,
      kind: "companion-pc",
      host,
      port,
      username: pcUserDraft.trim() || "user",
      authMethod: "agent-or-key",
    });
    setPcAliasDraft("");
    setPcEndpointDraft("");
    setPcUserDraft("");
  };

  return (
    <>
      <section className="qj-bset-group" data-testid="vserver-remote-vm-card">
        <div className="qj-bset-group-head">
          <span className="qj-bset-group-title">远程 Linux 虚拟机 SSH（7×24h 云端沙盒）</span>
          <button
            type="button"
            className="qj-bset-text-link"
            onClick={() => {
              closeActiveBotModal();
              openComputerStudio({ engine: "remote-vm", tab: "terminal" });
            }}
          >
            <Cloud size={12.5} />
            <span>打开远程 VM</span>
          </button>
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

      <section className="qj-bset-group" data-testid="vserver-remote-pc-card">
        <div className="qj-bset-group-head">
          <span className="qj-bset-group-title">远程个人电脑节点（Mac mini / Windows PC + 离线自治租约）</span>
          <button
            type="button"
            className="qj-bset-text-link"
            onClick={() => {
              closeActiveBotModal();
              openComputerStudio({ engine: "remote-pc", tab: "desktop" });
            }}
          >
            <Laptop size={12.5} />
            <span>打开远程个人电脑</span>
          </button>
        </div>

        <div className="qj-bset-card">
          {companionNodes.length > 0 ? (
            companionNodes.map((node) => (
              <div key={node.id} className="qj-bset-row" data-testid="remote-pc-node-row">
                <div className="qj-bset-row-copy">
                  <div className="qj-bset-row-title">
                    <span
                      className="qj-bset-status-dot"
                      data-tone={node.connected ? "success" : "warning"}
                    />
                    <span>{node.alias}</span>
                    <span className="qj-bset-tag">
                      自治租约 #{node.autonomyLease.lastSeq}
                      {node.autonomyLease.queuedOfflineEvents > 0
                        ? ` · 离线缓存 ${node.autonomyLease.queuedOfflineEvents} 条`
                        : ""}
                    </span>
                  </div>
                  <div className="qj-bset-row-desc qj-bset-mono-sub">
                    {node.username ? `${node.username}@` : ""}
                    {node.host}:{node.port}
                    {node.osSummary ? ` · ${node.osSummary}` : ""}
                  </div>
                </div>
                <div className="qj-bset-inline-controls">
                  <button
                    type="button"
                    data-testid={`sync-lease-${node.id}`}
                    className="qj-bset-btn soft xs"
                    onClick={() =>
                      void studio.runEngineAction({
                        engine: "remote-pc",
                        action: "sync-autonomy-lease",
                        remoteNodeId: node.id,
                      })
                    }
                  >
                    <RefreshCw size={11.5} />
                    <span>同步租约</span>
                  </button>
                  <button
                    type="button"
                    className="qj-bset-btn soft xs"
                    onClick={() =>
                      void studio.runEngineAction({
                        engine: "remote-pc",
                        action: node.connected ? "disconnect-remote" : "connect-remote",
                        remoteNodeId: node.id,
                      })
                    }
                  >
                    {node.connected ? "断开" : "连接"}
                  </button>
                  <button
                    type="button"
                    aria-label={`移除节点 ${node.alias}`}
                    className="qj-bset-btn soft xs"
                    onClick={() => void studio.deleteRemoteNode(node.id)}
                  >
                    <Trash2 size={11.5} />
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="qj-bset-row">
              <div className="qj-bset-row-copy">
                <div className="qj-bset-row-title">连接闲置家用 Mac mini 或个人 PC 作为千机专属算力底座</div>
                <div className="qj-bset-row-desc">
                  支持离线自治租约（Autonomy Lease）：即使你随身携带的笔记本合盖断网，远端个人电脑仍按授权队列持续推进，重连后毫秒级回放时间轴。
                </div>
              </div>
            </div>
          )}

          <div className="qj-bset-row stack">
            <div className="qj-bset-grid-2">
              <input
                type="text"
                aria-label="远程个人电脑别名"
                value={pcAliasDraft}
                onChange={(e) => setPcAliasDraft(e.target.value)}
                placeholder="节点名称（如 书房 Mac mini M4）"
                className="qj-bset-input"
              />
              <div className="qj-bset-ssh-user-grid">
                <input
                  type="text"
                  aria-label="远程个人电脑地址"
                  value={pcEndpointDraft}
                  onChange={(e) => setPcEndpointDraft(e.target.value)}
                  placeholder="100.x.y.z:22 (Tailscale / 局域网)"
                  className="qj-bset-input mono"
                />
                <input
                  type="text"
                  aria-label="远程个人电脑账号"
                  value={pcUserDraft}
                  onChange={(e) => setPcUserDraft(e.target.value)}
                  placeholder="用户名"
                  className="qj-bset-input mono"
                />
              </div>
            </div>
            <div className="qj-bset-end-actions">
              <button
                type="button"
                data-testid="add-remote-pc-btn"
                className="qj-bset-btn primary sm"
                disabled={pcEndpointDraft.trim() === ""}
                onClick={() => void handleAddCompanionPc()}
              >
                <Plus size={12.5} />
                <span>添加个人电脑节点</span>
              </button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
