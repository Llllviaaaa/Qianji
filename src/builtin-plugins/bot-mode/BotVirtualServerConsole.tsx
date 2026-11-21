/**
 * Local & Remote Virtual Server Console (`虚拟服务器` tab inside Bot Settings).
 */
import { useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { Eye, HardDrive, RefreshCw, RotateCcw, Server, Wifi } from "lucide-react";
import { Switch } from "@qianji/client-primitives";
import { openBotModal, useBotController, useBotSnapshot, useBotUiState } from "./botStore";

export function VirtualServerConsole({ ctx }: { readonly ctx?: Context }): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const vs = snapshot.virtualServer;

  const [hostDraft, setHostDraft] = useState(vs.remote.host || "bot-node.example.com");
  const [portDraft, setPortDraft] = useState(String(vs.remote.port || 22));
  const [userDraft, setUserDraft] = useState(vs.remote.username || "ubuntu");
  const [dirDraft, setDirDraft] = useState(vs.remote.workDir || "/home/ubuntu/.qianji-bot");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <strong style={{ fontSize: 16 }}>虚拟服务器底座</strong>
        <div style={{ fontSize: 12.5, color: "var(--qj-text-secondary)", marginTop: 2 }}>
          让千机分身拥有安全受控的独立运行环境，支持本地虚拟服务器与远端 24×7 云端虚拟服务器一键切换
        </div>
      </div>

      {/* Mode Selector */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <button
          type="button"
          data-vserver-mode="local"
          className="qj-bot-soft-card interactive"
          style={{
            border: vs.mode === "local" ? "1.5px solid var(--qj-text-primary)" : "1.5px solid transparent",
            textAlign: "left",
          }}
          onClick={() => void ctrl.configureServer({ mode: "local" })}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 7, fontWeight: 620, fontSize: 13.5 }}>
            <HardDrive size={15} />
            <span>本地虚拟服务器</span>
          </div>
          <span style={{ fontSize: 12, color: "var(--qj-text-secondary)" }}>
            零配置开箱即用，数据留在本地受控目录，闲置自动休眠
          </span>
        </button>

        <button
          type="button"
          data-vserver-mode="remote"
          className="qj-bot-soft-card interactive"
          style={{
            border: vs.mode === "remote" ? "1.5px solid var(--qj-text-primary)" : "1.5px solid transparent",
            textAlign: "left",
          }}
          onClick={() => void ctrl.configureServer({ mode: "remote" })}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 7, fontWeight: 620, fontSize: 13.5 }}>
            <Server size={15} />
            <span>远端虚拟服务器</span>
          </div>
          <span style={{ fontSize: 12, color: "var(--qj-text-secondary)" }}>
            连接自有云主机或家庭服务器，合上电脑仍 24×7 持续在线守护
          </span>
        </button>
      </div>

      {ui.serverFeedback && (
        <div className="qj-bot-soft-card" style={{ padding: "10px 14px", fontSize: 12.5 }}>
          {ui.serverFeedback}
        </div>
      )}

      {vs.mode === "local" ? (
        <div className="qj-bot-soft-card" style={{ gap: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong style={{ fontSize: 13.5 }}>本地虚拟服务器状态 · {vs.uptimeLabel}</strong>
            <span style={{ fontSize: 12, color: "var(--qj-text-muted)" }}>
              CPU {vs.local.cpuUsagePercent}% · 内存 {vs.local.memoryUsedGb} / {vs.local.memoryLimitGb} GB
            </span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <div className="qj-bot-field">
              <label>CPU 核数上限</label>
              <select
                className="qj-bot-select"
                value={String(vs.local.cpuCores)}
                onChange={(e) => void ctrl.configureServer({ cpuCores: Number(e.target.value) })}
              >
                <option value="2">2 核（轻量省电）</option>
                <option value="4">4 核（均衡推荐）</option>
                <option value="8">8 核（重度多任务）</option>
              </select>
            </div>
            <div className="qj-bot-field">
              <label>内存上限 (GB)</label>
              <select
                className="qj-bot-select"
                value={String(vs.local.memoryLimitGb)}
                onChange={(e) => void ctrl.configureServer({ memoryLimitGb: Number(e.target.value) })}
              >
                <option value="2">2 GB</option>
                <option value="4">4 GB</option>
                <option value="8">8 GB</option>
              </select>
            </div>
            <div className="qj-bot-field">
              <label>磁盘配额 (GB)</label>
              <select
                className="qj-bot-select"
                value={String(vs.local.diskLimitGb)}
                onChange={(e) => void ctrl.configureServer({ diskLimitGb: Number(e.target.value) })}
              >
                <option value="10">10 GB</option>
                <option value="20">20 GB</option>
                <option value="50">50 GB</option>
              </select>
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12.5, color: "var(--qj-text-secondary)" }}>
              空闲时自动休眠释放本机算力（新消息或定时心跳自动秒级唤醒）
            </span>
            <Switch
              checked={vs.local.autoSleepIdle}
              onCheckedChange={(checked) => void ctrl.configureServer({ autoSleepIdle: checked })}
              aria-label="空闲自动休眠"
            />
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {vs.lifecycle === "running" ? (
              <button type="button" className="qj-bot-pill-btn" onClick={() => void ctrl.runServerAction("sleep")}>
                休眠实例
              </button>
            ) : (
              <button
                type="button"
                className="qj-bot-task-handoff-btn"
                onClick={() => void ctrl.runServerAction("start")}
              >
                唤醒启动
              </button>
            )}
            <button type="button" className="qj-bot-pill-btn" onClick={() => void ctrl.runServerAction("restart")}>
              <RefreshCw size={13} />
              <span>平滑重启</span>
            </button>
            <button
              type="button"
              className="qj-bot-pill-btn"
              onClick={() => void ctrl.runServerAction("reset-snapshot")}
              title="清理临时包与缓存，完整保留 SOUL.md 与长期记忆"
            >
              <RotateCcw size={13} />
              <span>恢复干净快照（保留身份与记忆）</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="qj-bot-soft-card" style={{ gap: 12 }}>
          <strong style={{ fontSize: 13.5 }}>远端虚拟服务器连接配置</strong>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
            <div className="qj-bot-field">
              <label>主机地址 (Host / IP)</label>
              <input
                className="qj-bot-input"
                value={hostDraft}
                onChange={(e) => setHostDraft(e.target.value)}
                placeholder="例如：192.168.1.88 或 bot.mycloud.dev"
              />
            </div>
            <div className="qj-bot-field">
              <label>端口</label>
              <input
                className="qj-bot-input"
                value={portDraft}
                onChange={(e) => setPortDraft(e.target.value)}
              />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 10 }}>
            <div className="qj-bot-field">
              <label>登录用户</label>
              <input className="qj-bot-input" value={userDraft} onChange={(e) => setUserDraft(e.target.value)} />
            </div>
            <div className="qj-bot-field">
              <label>远端受控工作目录</label>
              <input className="qj-bot-input" value={dirDraft} onChange={(e) => setDirDraft(e.target.value)} />
            </div>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button
              type="button"
              className="qj-bot-pill-btn"
              onClick={() => {
                void ctrl.configureServer({
                  mode: "remote",
                  remoteHost: hostDraft,
                  remotePort: Number(portDraft) || 22,
                  remoteUser: userDraft,
                  remoteWorkDir: dirDraft,
                });
                void ctrl.runServerAction("test-remote");
              }}
            >
              <Wifi size={13} />
              <span>连通性测试</span>
            </button>
            <button
              type="button"
              className="qj-bot-task-handoff-btn"
              onClick={() => {
                void ctrl.configureServer({
                  mode: "remote",
                  remoteHost: hostDraft,
                  remotePort: Number(portDraft) || 22,
                  remoteUser: userDraft,
                  remoteWorkDir: dirDraft,
                });
                void ctrl.runServerAction("init-remote");
              }}
            >
              一键初始化远端环境并同步记忆
            </button>
          </div>
        </div>
      )}

      {/* Live View & Human Takeover Card */}
      <div
        className="qj-bot-soft-card"
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
      >
        <div>
          <strong style={{ fontSize: 13 }}>实时画面与人工接管</strong>
          <div style={{ fontSize: 12, color: "var(--qj-text-secondary)" }}>
            {vs.liveViewTaskTitle ?? "遇到站点登录或安全验证时，可随时查看实时画面并手动完成验证后交还分身"}
          </div>
        </div>
        <button type="button" className="qj-bot-pill-btn" onClick={() => openBotModal("live-view")}>
          <Eye size={14} />
          <span>查看画面</span>
        </button>
      </div>
    </div>
  );
}
