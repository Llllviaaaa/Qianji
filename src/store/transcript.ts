/** The conversation: the Host's transcript events, sending, queued messages, aborting, compacting. */
import { describeError } from "../lib/errors";
import { clientContributions } from "../lib/clientContributions";
import { buildPromptPayload, harnessRuntimes, parseLeadingSlashCommand } from "../lib/harnessRuntime";
import { requestOpenSettings } from "../lib/shellBridge";
import { appendManagedQueue, insertManagedQueueItem, moveManagedQueueItem, removeManagedQueueItem } from "../lib/managedQueue";
import { completionNotification, isSilentUiRequest, uiRequestNotification } from "../lib/eventNotifications";
import { agentBrowserFromResult, computerFromResult, isGrokBrowserTool, isGrokComputerTool } from "../lib/toolPanels";
import { appendNotice, completeAssistant, endToolCall, interruptTurn, progressToolCall, replaceOrAppend, resetStreamingAssistant, settleStoppedTurn, startAssistant, startToolCall } from "../lib/transcript";
import type { ManagedQueuedMessage } from "../types";
import type { GetState, SetState, StoreContext } from "./context";
import type { TranscriptSlice } from "./types";

export function createTranscriptSlice(set: SetState, get: GetState, ctx: StoreContext): TranscriptSlice {
  return {
    messages: [],
    isStreaming: false,
    isCompacting: false,
    retryStatus: null,
    steeringQueue: [],
    followUpQueue: [],
    managedFollowUpQueue: [],
    agentBrowser: null,
    computer: null,
    terminal: { running: false, command: "", output: "", history: [] },
    extensionWidgets: {},
    handleEvent: (runtimeId, event) => {
      if (event.type === "turn-start") ctx.updateRuntime(runtimeId, { isStreaming: true });
      if (event.type === "turn-end") {
        ctx.clearPendingAssistantUpdate(runtimeId);
        ctx.updateRuntime(runtimeId, { isStreaming: false, extensionRequest: null });
        queueMicrotask(() => void ctx.drainManagedFollowUp(runtimeId));
      }
      if (event.type === "ui-request" && !isSilentUiRequest(event.request.method)) {
        ctx.updateRuntime(runtimeId, { extensionRequest: event.request });
      }
      if (event.type === "ui-cancel") {
        if (get().runtimes[runtimeId]?.extensionRequest?.id === event.requestId) {
          ctx.updateRuntime(runtimeId, { extensionRequest: null });
        }
        if (runtimeId === get().runtimeId && get().extensionRequest?.id === event.requestId) {
          set({ extensionRequest: null });
        }
        return;
      }

      // A task in the background only notifies.
      if (runtimeId !== get().runtimeId) {
        const runtime = get().runtimes[runtimeId];
        const context = { cwd: runtime?.cwd ?? "", sessionFile: runtime?.sessionFile ?? null };
        if (event.type === "turn-end") {
          ctx.raise(completionNotification(runtimeId, context, true));
          void get().refreshSessions();
        }
        if (event.type === "ui-request") ctx.raise(uiRequestNotification(runtimeId, event.request, context, true));
        return;
      }

      switch (event.type) {
        case "turn-start":
          set({ isStreaming: true, retryStatus: null });
          return;
        case "turn-end":
          ctx.clearPendingAssistantUpdate(runtimeId);
          ctx.settleOptimisticPrompt(runtimeId);
          ctx.activeTurnStartedAt = null;
          set((state) => ({
            isStreaming: false,
            isCompacting: false,
            retryStatus: null,
            steeringQueue: [],
            followUpQueue: [],
            extensionRequest: null,
            messages: settleStoppedTurn(state.messages, Date.now(), event.outcome),
          }));
          if ((ctx.managedFollowUpsByRuntime.get(runtimeId) ?? []).length === 0) {
            ctx.raise(completionNotification(runtimeId, {
              cwd: get().cwd,
              sessionFile: get().sessionFile,
              sessionName: get().sessionName,
            }, false));
          }
          void Promise.all([get().refreshSessions(), get().refreshGit(), ctx.refreshStats()]);
          return;
        case "turn-interrupted":
          ctx.flushAssistantDelta();
          set((state) => ({ messages: interruptTurn(state.messages) }));
          return;
        case "user": {
          // The message the composer showed at once becomes the recorded one.
          const optimistic = ctx.pendingOptimisticPrompt?.runtimeId === runtimeId ? ctx.pendingOptimisticPrompt : null;
          set((state) => ({ messages: replaceOrAppend(state.messages, optimistic?.userMessageId, event.message) }));
          return;
        }
        case "notice":
          ctx.flushAssistantDelta();
          if (event.message.noticeKind === "continuation") ctx.activeTurnStartedAt = Date.now();
          set((state) => ({ messages: appendNotice(state.messages, event.message) }));
          return;
        case "assistant-start": {
          ctx.clearPendingAssistantUpdate(runtimeId);
          // The composer's placeholder reply, if there is one, is the reply being streamed.
          set((state) => ({ messages: startAssistant(state.messages) }));
          if (ctx.pendingOptimisticPrompt?.runtimeId === runtimeId) ctx.pendingOptimisticPrompt = null;
          return;
        }
        case "assistant-delta":
          if (get().retryStatus !== null) set({ retryStatus: null });
          ctx.queueAssistantDelta(runtimeId, { text: event.text, thinking: event.thinking });
          return;
        case "assistant-tool-calls":
          if (get().retryStatus !== null) set({ retryStatus: null });
          ctx.queueAssistantDelta(runtimeId, { toolCalls: event.calls });
          return;
        case "assistant": {
          ctx.clearPendingAssistantUpdate(runtimeId);
          const durationMs = ctx.activeTurnStartedAt === null ? undefined : Date.now() - ctx.activeTurnStartedAt;
          set((state) => ({ retryStatus: null, messages: completeAssistant(state.messages, { ...event.message, durationMs }) }));
          return;
        }
        case "retry-status":
          ctx.clearPendingAssistantUpdate(runtimeId);
          set((state) => ({
            retryStatus: event.text,
            messages: resetStreamingAssistant(state.messages),
          }));
          return;
        case "tool-start":
          set((state) => ({ messages: startToolCall(state.messages, event.callId, event.name, event.args) }));
          return;
        case "tool-progress":
          set((state) => ({ messages: progressToolCall(state.messages, event.callId, event.name, event.text) }));
          return;
        case "tool-end":
          set((state) => ({
            messages: endToolCall(state.messages, event.callId, event.name, event.result),
            agentBrowser: isGrokBrowserTool(event.name) ? agentBrowserFromResult(event.result, state.agentBrowser) : state.agentBrowser,
            computer: isGrokComputerTool(event.name) ? computerFromResult(event.result, state.computer) : state.computer,
          }));
          return;
        case "queue":
          set({ steeringQueue: Array(event.steering).fill(""), followUpQueue: Array(event.followUp).fill("") });
          return;
        case "compaction-start":
          set({ isCompacting: true });
          return;
        case "compaction-end":
          set({ isCompacting: false });
          if (event.failed) ctx.toast("上下文压缩失败", "error");
          return;
        case "plan":
          set((state) => {
            const widgets = { ...state.extensionWidgets };
            if (event.lines.length > 0) widgets["qianji-plan"] = event.lines;
            else delete widgets["qianji-plan"];
            delete widgets["pidesktop-plan"];
            return { extensionWidgets: widgets };
          });
          return;
        case "ui-request": {
          const request = event.request;
          if (request.method === "notify") {
            ctx.toast(request.message, request.notifyType ?? "info");
            return;
          }
          set({ extensionRequest: request });
          ctx.raise(uiRequestNotification(runtimeId, request, {
            cwd: get().cwd,
            sessionFile: get().sessionFile,
          }, false));
          return;
        }
      }
    },

    sendMessage: async (text, attachments = [], behavior) => {
      const payload = buildPromptPayload(text, attachments);
      if (!payload.message && payload.images.length === 0) return false;
      // connect() marks the runtime as running before it has applied the picked model;
      // a prompt sent in that gap would be answered by the runtime's default model.
      if (ctx.pendingConnection && (ctx.queuedModelSelection || ctx.queuedThinkingLevel)) {
        await ctx.pendingConnection.promise.catch(() => undefined);
      }
      const initialRuntimeId = get().runtimeId;
      const modelChange = ctx.pendingModelChange?.runtimeId === initialRuntimeId
        ? ctx.pendingModelChange.promise
        : null;
      if (modelChange) {
        try {
          await modelChange;
        } catch {
          return false;
        }
      }
      const runtimeId = get().runtimeId;
      if (!runtimeId) {
        ctx.toast("当前没有活动的任务", "error");
        return false;
      }
      const wasStreaming = get().isStreaming;
      if (wasStreaming && behavior === "followUp") {
        const item: ManagedQueuedMessage = {
          id: typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          text: payload.message,
          attachments: attachments.map((attachment) => ({ ...attachment })),
          createdAt: Date.now(),
        };
        const queue = ctx.managedFollowUpsByRuntime.get(runtimeId) ?? [];
        ctx.setManagedQueueForRuntime(runtimeId, appendManagedQueue(queue, item));
        return true;
      }
      let effectivePayload = payload;
      if (!wasStreaming && payload.images.length === 0) {
        const slash = parseLeadingSlashCommand(payload.message);
        if (slash !== null) {
          try {
            if (slash.rawArgs.trim() === "" && (slash.name === "mcp" || slash.name === "skills")) {
              if (requestOpenSettings(slash.name)) return true;
            }
            const handledByClient = await clientContributions.tryHandleSlashCommand(
              slash.name,
              slash.rawArgs,
              { cwd: get().cwd, sessionFile: get().sessionFile },
            );
            if (handledByClient) return true;
            const needsSession =
              slash.name === "goal"
              && slash.rawArgs.trim() !== ""
              && !["status", "clear", "reset", "done", "complete"].includes(slash.rawArgs.trim().toLowerCase());
            const commandResult = await harnessRuntimes.runCommand(runtimeId, slash.name, slash.rawArgs, { ensureSession: needsSession });
            if (needsSession) {
              ctx.recordStartedSession(runtimeId);
              const stateInfo = await harnessRuntimes.state(runtimeId).catch(() => null);
              if (stateInfo?.sessionId && stateInfo.sessionFile) {
                ctx.updateRuntime(runtimeId, { sessionFile: stateInfo.sessionFile });
                if (get().runtimeId === runtimeId) {
                  set({ sessionId: stateInfo.sessionId, sessionFile: stateInfo.sessionFile });
                }
              }
            }
            if (commandResult.handled) {
              if (commandResult.clientAction === "clear") {
                await get().newSession();
                return true;
              }
              if (commandResult.clientAction === "compact") {
                await get().compact();
                return true;
              }
              if (commandResult.prompt !== undefined && commandResult.prompt.trim() !== "") {
                effectivePayload = { message: payload.message, metaPrompt: commandResult.prompt, images: payload.images };
              } else {
                const now = Date.now();
                const nonce = `${now}-${Math.random().toString(36).slice(2, 7)}`;
                const outputText = commandResult.output ?? `已执行 \`/${slash.name}\`。`;
                set((state) => {
                  const widgets = { ...state.extensionWidgets };
                  if (slash.name === "plan" && slash.rawArgs.trim().toLowerCase() === "clear") {
                    delete widgets["qianji-plan"];
                    delete widgets["pidesktop-plan"];
                  }
                  return {
                    extensionWidgets: widgets,
                    messages: [
                      ...state.messages,
                      {
                        id: `slash-user-${nonce}`,
                        role: "user",
                        content: payload.message,
                        timestamp: now,
                      },
                      {
                        id: `slash-assistant-${nonce}`,
                        role: "assistant",
                        content: outputText,
                        ...(commandResult.isError ? { isError: true } : {}),
                        timestamp: now,
                      },
                    ],
                  };
                });
                return true;
              }
            }
          } catch (error) {
            ctx.toast(describeError(error), "error");
            return false;
          }
        }
      }
      const optimistic = !wasStreaming;
      if (!wasStreaming) ctx.activeTurnStartedAt = Date.now();
      if (optimistic) {
        const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        ctx.pendingOptimisticPrompt = {
          runtimeId,
          userMessageId: `optimistic-user-${nonce}`,
          assistantMessageId: `optimistic-assistant-${nonce}`,
        };
        const pending = ctx.pendingOptimisticPrompt;
        set((state) => ({
          messages: [
            ...state.messages,
            {
              id: pending.userMessageId,
              role: "user",
              content: effectivePayload.message,
              images: effectivePayload.images.length
                ? effectivePayload.images.map(({ data, mimeType }) => ({ type: "image", data, mimeType }))
                : undefined,
              timestamp: Date.now(),
            },
            {
              id: pending.assistantMessageId,
              role: "assistant",
              content: "",
              isStreaming: true,
              timestamp: Date.now(),
            },
          ],
          isStreaming: true,
        }));
      }
      try {
        if (wasStreaming) {
          await harnessRuntimes.queue(runtimeId, behavior === "followUp" ? "followUp" : "steer", effectivePayload);
        } else {
          await harnessRuntimes.prompt(runtimeId, effectivePayload);
          ctx.recordStartedSession(runtimeId);
          // The task has started: its model and thinking level now live in the runtime.
          ctx.queuedModelSelection = null;
          ctx.queuedThinkingLevel = null;
        }
        return true;
      } catch (error) {
        if (optimistic) ctx.rollbackOptimisticPrompt(runtimeId);
        if (!wasStreaming) ctx.activeTurnStartedAt = null;
        ctx.toast(describeError(error), "error");
        return false;
      }
    },

    removeManagedFollowUp: (id) => {
      const runtimeId = get().runtimeId;
      if (!runtimeId) return;
      const current = ctx.managedFollowUpsByRuntime.get(runtimeId) ?? [];
      ctx.setManagedQueueForRuntime(runtimeId, removeManagedQueueItem(current, id).queue);
    },

    moveManagedFollowUp: (id, direction) => {
      const runtimeId = get().runtimeId;
      if (!runtimeId) return;
      const current = ctx.managedFollowUpsByRuntime.get(runtimeId) ?? [];
      ctx.setManagedQueueForRuntime(runtimeId, moveManagedQueueItem(current, id, direction));
    },

    steerManagedFollowUp: async (id) => {
      const runtimeId = get().runtimeId;
      if (!runtimeId) return;
      const current = ctx.managedFollowUpsByRuntime.get(runtimeId) ?? [];
      const removed = removeManagedQueueItem(current, id);
      if (!removed.item) return;
      ctx.setManagedQueueForRuntime(runtimeId, removed.queue);
      const sent = await get().sendMessage(removed.item.text, removed.item.attachments, "steer");
      if (!sent) {
        const latest = ctx.managedFollowUpsByRuntime.get(runtimeId) ?? [];
        ctx.setManagedQueueForRuntime(runtimeId, insertManagedQueueItem(latest, removed.item, removed.index));
      }
    },

    abort: async () => {
      const runtimeId = get().runtimeId;
      if (!runtimeId) {
        ctx.activeTurnStartedAt = null;
        set((state) => ({
          isStreaming: false,
          isCompacting: false,
          retryStatus: null,
          steeringQueue: [],
          followUpQueue: [],
          extensionRequest: null,
          messages: settleStoppedTurn(state.messages),
        }));
        return;
      }
      if ((ctx.managedFollowUpsByRuntime.get(runtimeId)?.length ?? 0) > 0) {
        ctx.suppressManagedDrainFor.add(runtimeId);
      }
      ctx.clearPendingAssistantUpdate(runtimeId);
      if (get().isStreaming) set({ retryStatus: "正在停止…" });
      try {
        await harnessRuntimes.abort(runtimeId);
      } catch (error) {
        ctx.suppressManagedDrainFor.delete(runtimeId);
        const live = await harnessRuntimes.state(runtimeId).catch(() => null);
        if (live?.isStreaming) {
          if (get().runtimeId === runtimeId) set({ retryStatus: null });
          ctx.toast(`停止对话失败：${describeError(error)}`, "error");
          throw error;
        }
      }
      // Let any turn-end microtask queued before abort resolved observe suppressManagedDrainFor.
      await Promise.resolve();
      ctx.suppressManagedDrainFor.delete(runtimeId);
      ctx.clearPendingAssistantUpdate(runtimeId);
      ctx.settleOptimisticPrompt(runtimeId);
      ctx.updateRuntime(runtimeId, { isStreaming: false, extensionRequest: null });
      if (get().runtimeId === runtimeId) {
        ctx.activeTurnStartedAt = null;
        set((state) => ({
          isStreaming: false,
          isCompacting: false,
          retryStatus: null,
          steeringQueue: [],
          followUpQueue: [],
          extensionRequest: null,
          messages: settleStoppedTurn(state.messages),
        }));
      }
    },

    compact: async () => {
      set({ isCompacting: true });
      try {
        await harnessRuntimes.compact(ctx.activeRuntime());
        await ctx.refreshStats();
      } finally {
        set({ isCompacting: false });
      }
    },
  };
}
