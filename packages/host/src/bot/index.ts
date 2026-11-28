/**
 * Built-in Host `bot` Cordis plugin (`packages/host/src/bot/index.ts`).
 *
 * Mounts:
 * 1. `BotStateStore` + real 4-app `ConnectorHub` (`Email`, `Calendar`, `ProcessSensor`, `Meetings/IM`)
 * 2. Independent `BotCompanionHarness` (`ctx.botHarness`) for caring companion turns & reflection
 * 3. `ProactivePulseEngine` (background Heartbeat patrol with quiet-hours & focus-aware delivery)
 * 4. Outbound `tools/pre-execute` safety boundary & JSON-RPC `bot.*` API (`bot-rpc.ts`)
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Credentials } from "@qianji/llm";
import "@qianji/schedule";
import type { Schedule, ScheduledRun } from "@qianji/schedule";
import "@qianji/session";
import "@qianji/tools";
import { HostConnectorsService } from "../plugin-connectors.ts";
import { registerBotRpcMethods } from "./bot-rpc.ts";
import { VirtualComputerManager } from "./computer/manager.ts";
import { SentinelFenceError } from "./computer/sentinel-fence.ts";
import { BotCompanionHarness } from "./harness/bot-harness.ts";
import { ProactivePulseEngine } from "./harness/bot-proactive-pulse.ts";
import { createBotHarnessHost } from "./harness/bot-tools-host.ts";
import { listConnectorsForPlugin, resolvePluginConnectorIdForTool } from "./plugin-connector-rpc.ts";
import { BotStateStore, type BotStoreConfig } from "./store.ts";

export { BotCompanionHarness, BotStateStore, ProactivePulseEngine, SentinelFenceError, VirtualComputerManager, type BotStoreConfig };
export * from "./defaults.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    botHarness?: BotCompanionHarness;
  }
}

export const name = "qianji-bot";
export const inject = ["sessions", "tools"];
export const provide = ["botHarness"];

const EXTERNAL_SIDE_EFFECT_RE =
  /\b(?:gh\s+pr\s+(?:comment|merge|close|review|create)|gh\s+issue\s+(?:comment|create|close)|git\s+push|sendmail|msmtp)\b/i;

export function apply(ctx: Context, config: BotStoreConfig): void {
  if (!ctx.get("connectors")) {
    ctx.plugin(HostConnectorsService);
  }
  const credentials = ctx.get("credentials") as Credentials | undefined;
  const store = new BotStateStore(ctx.sessions, config, credentials);
  store.computer.attachBroadcaster((channel, payload) => {
    ctx.get("rpc")?.broadcast(channel, payload);
  });

  const notifyUpdated = (reason: string, extra?: Record<string, unknown>) => {
    ctx.get("rpc")?.broadcast("bot/updated", { reason, ts: Date.now(), ...extra });
  };

  const offConnectors = (ctx.get("connectors") as HostConnectorsService | undefined)?.onChange(() => {
    notifyUpdated("plugin-connectors-changed");
  });

  ctx.tools.setSessionFilter((sessionId, def) => {
    const manager = config.pluginManager?.();
    const connectorsSvc = ctx.get("connectors") as HostConnectorsService | undefined;
    const isBot = store.isBotSession(sessionId);
    if (isBot) {
      if (def.pluginId && manager && !manager.isPluginEnabledForMode(def.pluginId, "bot")) {
        return false;
      }
      if (def.pluginId) {
        const cand = manager?.getCandidate(def.pluginId);
        const pluginConns = listConnectorsForPlugin(
          def.pluginId,
          cand?.name ?? def.pluginId,
          cand?.connectors,
          connectorsSvc,
        );
        if (def.connectorId) {
          return store.isAppPolicyConnectedSync(def.connectorId);
        }
        if (pluginConns.length > 0) {
          return pluginConns.some((c) => store.isAppPolicyConnectedSync(c.id));
        }
      }
      return true;
    }
    if (def.pluginId && manager && !manager.isPluginEnabledForMode(def.pluginId, "agent")) {
      return false;
    }
    return true;
  });

  ctx.on("session/created", (session) => {
    if (store.matchesBotWorkspace(session.header.cwd)) {
      store.registerBotSession(session.id);
    }
  });

  const harnessHost = createBotHarnessHost(store, notifyUpdated, () => ctx.get("schedule") as Schedule | undefined);
  const botHarness = new BotCompanionHarness(ctx, harnessHost);
  ctx.provide("botHarness", botHarness);

  const pulseEngine = new ProactivePulseEngine({
    ctx,
    get botWorkspaceDir() {
      return store.botWorkspaceDir;
    },
    ensureLoaded: () => store.ensureLoaded(),
    persist: () => store.persist(),
    collectDelta: async (nowMs) => {
      const base = await store.collectConnectorDelta(nowMs);
      const st = await store.ensureLoaded();
      const connectorsSvc = ctx.get("connectors") as HostConnectorsService | undefined;
      for (const reg of connectorsSvc?.list() ?? []) {
        if (!reg.patrol) continue;
        const pol = st.connectorConfigs?.appPolicies?.[reg.id];
        if (!pol?.connected || pol.backgroundSync === false) continue;
        const items = await reg.patrol().catch(() => []);
        for (const item of items) {
          await store.createFeedItem(item.title, item.summary, item.seedPrompt);
        }
      }
      return base;
    },
    stageOutboundDraft: async (input) => {
      const staged = await harnessHost.stageOutboundApproval(input);
      return staged.id;
    },
  });
  pulseEngine.start();

  const idleTimer = setInterval(() => {
    void store.checkIdleAutoSleep().then((slept) => {
      if (slept) notifyUpdated("auto-sleep");
    });
  }, 60_000);
  idleTimer.unref?.();

  ctx.effect(() => async () => {
    offConnectors?.();
    clearInterval(idleTimer);
    pulseEngine.stop();
    ctx.tools.setSessionFilter(undefined);
    await store.computer.dispose();
    await store.liveView.close();
  });

  // Queue external side-effect shell commands and enforce connected MCP & Plugin Connector policies in Bot sessions.
  ctx.on(
    "tools/pre-execute",
    async (call, env) => {
      if (!store.isBotSession(env.sessionId)) return undefined;

      const def = ctx.tools.get(call.name);
      const manager = config.pluginManager?.();
      const connectorsSvc = ctx.get("connectors") as HostConnectorsService | undefined;
      const pluginConnId = def ? resolvePluginConnectorIdForTool(def, manager, connectorsSvc) : undefined;
      const mcpServerId = def?.group?.startsWith("mcp_") ? def.group.slice(4) : undefined;
      const appKey =
        pluginConnId ??
        (mcpServerId
          ? mcpServerId.startsWith("preset-mcp-")
            ? mcpServerId.slice("preset-mcp-".length)
            : mcpServerId
          : undefined);

      if (def && appKey) {
        const st = await store.ensureLoaded();
        const policyCfg =
          st.connectorConfigs?.appPolicies?.[appKey] ??
          (mcpServerId ? st.connectorConfigs?.appPolicies?.[mcpServerId] : undefined);
        if (policyCfg) {
          const override = policyCfg.actionPermissions?.[call.name];
          if (override === "deny" || (policyCfg.policy === "strict-read-only" && def.readOnly !== true)) {
            return { deny: true, reason: `连接器「${appKey}」权限策略已禁用写操作：${call.name}` };
          }
          if (override === "allow" && policyCfg.policy !== "always-ask") {
            return { allow: true };
          }
          const needsApproval =
            override === "ask" ||
            policyCfg.policy === "always-ask" ||
            (override === undefined &&
              def.readOnly !== true &&
              (policyCfg.policy === "low-risk-auto" || policyCfg.policy === "read-only-auto"));
          if (needsApproval) {
            const approval = await store.enqueueApproval(
              {
                kind: "shell",
                title: `允许「${appKey}」执行操作：${call.name}`,
                commandSignature: `connector://${appKey}/${call.name}`,
                summary: `${JSON.stringify(call.args).slice(0, 180)}`,
                sessionId: env.sessionId,
              },
              `${call.name} ${JSON.stringify(call.args)}`,
            );
            notifyUpdated("approval-queued", { approvalId: approval.id });
            return {
              deny: true,
              reason: `Connected app "${appKey}" requires user confirmation in the right-side 批准 tab before running "${call.name}" (approval id: ${approval.id}).`,
            };
          }
          return { allow: true };
        }
      }

      if (call.name !== "bash" && call.name !== "powershell") return undefined;
      const cmd = typeof call.args.command === "string" ? call.args.command.trim() : "";
      if (cmd === "" || !EXTERNAL_SIDE_EFFECT_RE.test(cmd)) return undefined;

      const approval = await store.enqueueApproval(
        {
          kind: "shell",
          title: `执行外部操作：${cmd.slice(0, 48)}`,
          commandSignature: `${cmd.slice(0, 64)} · 外部写操作`,
          summary: "分身请求执行具有外部影响的命令，已自动挂入右侧「批准」栏等待你的确认。",
          sessionId: env.sessionId,
        },
        cmd,
      );
      notifyUpdated("approval-queued", { approvalId: approval.id });
      return {
        deny: true,
        reason: `External write operation queued in Bot Approvals panel (id: ${approval.id}). Tell the user they can approve or deny it in the right-side 批准 tab.`,
      };
    },
    true,
  );

  ctx.on(
    "tools/execute",
    async (call, env, next) => {
      if (!store.isBotSession(env.sessionId)) return next();
      const vmOut = await store.executeToolInVm(call, env);
      if (vmOut !== undefined) return vmOut;
      const fallbackOut = await next();
      await store.recordFallbackBotTool(call, fallbackOut);
      return fallbackOut;
    },
    true,
  );

  ctx.on("schedule/run", (run: ScheduledRun) => {
    const scheduleSvc = ctx.get("schedule") as
      | { list?: () => Array<{ id: string; cwd?: string; scope?: string }> }
      | undefined;
    const matchedTask = scheduleSvc?.list?.().find((t) => t.id === run.taskId);
    const taskCwd = run.cwd ?? matchedTask?.cwd;
    const taskScope = run.scope ?? matchedTask?.scope;
    if (run.sessionId !== undefined && (taskScope === "bot" || store.matchesBotWorkspace(taskCwd))) {
      store.registerBotSession(run.sessionId);
    }
    void store
      .recordScheduledRun(run, taskCwd, taskScope)
      .then((bridged) => {
        if (bridged) {
          notifyUpdated("scheduled-run", {
            runId: run.id,
            taskId: run.taskId,
            status: run.status,
            sessionId: run.sessionId,
          });
        }
      })
      .catch(() => undefined);
  });

  ctx.inject(["rpc"], (rpcCtx) => {
    registerBotRpcMethods(rpcCtx, store, pulseEngine, config.pluginManager);
  });
}