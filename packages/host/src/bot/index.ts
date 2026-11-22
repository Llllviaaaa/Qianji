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
import "@qianji/session";
import "@qianji/tools";
import { registerBotRpcMethods } from "./bot-rpc.ts";
import { BotCompanionHarness } from "./harness/bot-harness.ts";
import { ProactivePulseEngine } from "./harness/bot-proactive-pulse.ts";
import { createBotHarnessHost } from "./harness/bot-tools-host.ts";
import { BotStateStore, type BotStoreConfig } from "./store.ts";

export { BotCompanionHarness, BotStateStore, ProactivePulseEngine, type BotStoreConfig };
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
  const credentials = ctx.get("credentials") as Credentials | undefined;
  const store = new BotStateStore(ctx.sessions, config, credentials);

  const notifyUpdated = (reason: string, extra?: Record<string, unknown>) => {
    ctx.get("rpc")?.broadcast("bot/updated", { reason, ts: Date.now(), ...extra });
  };

  const harnessHost = createBotHarnessHost(store, notifyUpdated);
  const botHarness = new BotCompanionHarness(ctx, harnessHost);
  ctx.provide("botHarness", botHarness);

  const pulseEngine = new ProactivePulseEngine({
    ctx,
    botWorkspaceDir: store.botWorkspaceDir,
    ensureLoaded: () => store.ensureLoaded(),
    persist: () => store.persist(),
    collectDelta: (nowMs) => store.collectConnectorDelta(nowMs),
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

  ctx.effect(() => () => {
    clearInterval(idleTimer);
    pulseEngine.stop();
    void store.liveView.close();
  });

  // Queue external side-effect shell commands in Bot sessions into the Approvals inbox.
  ctx.on(
    "tools/pre-execute",
    async (call, env) => {
      if (!store.isBotSession(env.sessionId)) return undefined;
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
      return next();
    },
    true,
  );

  ctx.inject(["rpc"], (rpcCtx) => {
    registerBotRpcMethods(rpcCtx, store, pulseEngine);
  });
}