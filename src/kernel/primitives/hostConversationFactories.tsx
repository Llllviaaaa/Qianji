/**
 * Host-owned production conversation UI factories (`src/kernel/primitives/hostConversationFactories.tsx`, ADR 0023).
 *
 * Registers Qianji's full-featured production transcript components
 * (`HostAssistantMessageFactory`, `UserMessageRow`, `ToolCall`, `ProcessGroup`)
 * into `@qianji/client-slots`'s `SlotFactoryMap`.
 */
import { createElement, useState, type ReactElement, type ReactNode } from "react";
import type {
  ClientSlotsService,
  SlotComponentProps,
  SlotFactorySpec,
  SlotRegistry,
} from "@qianji/client-slots";
import { IconChevronDown } from "../../components/DshIcons";
import { buildProcessSummary, summarizeProcessGroup } from "../../components/message/messageHelpers";
import { ProcessGroup, ReasoningRow } from "../../components/message/MessageProcessBlocks";
import { UserMessageRow } from "../../components/message/UserMessageRow";
import { ToolCall } from "../../components/ToolCall";
import { useAppStore } from "../../store";
import type { UiMessage, UiToolCall } from "../../types";
import {
  HostAssistantMessageFactory,
  type HostAssistantMessageFactoryProps,
} from "./hostAssistantMessageFactory";

export type { HostAssistantMessageFactoryProps };

const HOST_FACTORIES_PLUGIN_ID = "core-host-factories";

export interface HostUserMessageFactoryProps {
  readonly message: UiMessage;
  readonly cwd?: string;
  readonly sessionFile?: string | null;
  readonly sessionId?: string;
  readonly isLastUserTurn?: boolean;
  readonly onRewind?: (message: UiMessage) => void;
  readonly onEditAndResend?: (entryId: string, text: string) => void;
  readonly extraSlotActions?: ReactNode;
}

export interface HostToolCallFactoryProps {
  readonly call: UiToolCall;
}

export interface HostProcessGroupFactoryProps {
  readonly message: UiMessage;
  readonly thinking: string;
  readonly working: boolean;
  readonly toolNodes?: ReactNode;
}

declare module "@qianji/client-slots" {
  interface SlotFactoryMap {
    "host.conversation.assistantMessage": SlotFactorySpec<HostAssistantMessageFactoryProps, "root">;
    "host.conversation.userMessage": SlotFactorySpec<HostUserMessageFactoryProps, "root">;
    "host.conversation.toolCall": SlotFactorySpec<HostToolCallFactoryProps, "root">;
    "host.conversation.processGroup": SlotFactorySpec<HostProcessGroupFactoryProps, "root">;
  }
}

function HostUserMessageFactory({
  message,
  cwd,
  sessionFile,
  sessionId,
  isLastUserTurn = true,
  onRewind,
  onEditAndResend,
  extraSlotActions,
}: SlotComponentProps<HostUserMessageFactoryProps, "root">): ReactElement {
  const [editing, setEditing] = useState(false);
  const requireCtrlEnter = useAppStore((s) => s.settings?.requireCtrlEnter ?? false);
  const storeCwd = useAppStore((s) => s.cwd);
  const storeSessionFile = useAppStore((s) => s.sessionFile);
  const canEdit =
    onEditAndResend !== undefined && typeof message.entryId === "string" && message.entryId !== "";

  return (
    <UserMessageRow
      message={message}
      editing={editing}
      requireCtrlEnter={requireCtrlEnter}
      slotCwd={cwd ?? storeCwd}
      slotSessionFile={sessionFile !== undefined ? sessionFile : storeSessionFile}
      sessionId={sessionId}
      actionsReveal={isLastUserTurn ? undefined : "hover"}
      extraSlotActions={extraSlotActions}
      onEdit={canEdit ? () => setEditing(true) : undefined}
      onCancelEdit={() => setEditing(false)}
      onSubmitEdit={
        canEdit
          ? async (msg, text) => {
              if (msg.entryId === undefined) return false;
              onEditAndResend(msg.entryId, text);
              setEditing(false);
              return true;
            }
          : undefined
      }
      onRewind={
        onRewind !== undefined
          ? async (msg) => {
              onRewind(msg);
              return true;
            }
          : undefined
      }
    />
  );
}

function HostToolCallFactory({
  call,
}: SlotComponentProps<HostToolCallFactoryProps, "root">): ReactElement {
  return createElement(ToolCall, { call });
}

function HostProcessGroupFactory({
  message,
  thinking,
  working,
  toolNodes,
}: SlotComponentProps<HostProcessGroupFactoryProps, "root">): ReactElement | null {
  const [processOpen, setProcessOpen] = useState<boolean | null>(null);
  const hasThinking = thinking.trim() !== "";
  const toolCalls = (message.toolCalls ?? []).filter(
    (call) => call.name !== "render_ui" && call.name !== "update_ui",
  );
  if (!hasThinking && toolCalls.length === 0) return null;

  const isExpanded = processOpen ?? working;
  const summary = buildProcessSummary(hasThinking ? 1 : 0, 0, toolCalls.length);
  const groupTitle = summarizeProcessGroup(hasThinking ? 1 : 0, toolCalls);

  return (
    <div className="dshc-process-wrap">
      {!working && (
        <button
          type="button"
          className="dshc-turn-process"
          data-open={isExpanded || undefined}
          aria-expanded={isExpanded}
          onClick={() => setProcessOpen(!isExpanded)}
        >
          <span className="dshc-turn-process-label">{summary || "查看处理过程"}</span>
          <IconChevronDown className="dshc-turn-process-chevron" />
        </button>
      )}
      {isExpanded && (
        <ProcessGroup
          grouped
          live={working}
          autoOpen={working}
          summary={groupTitle}
          activity={hasThinking ? "thinking" : "shell"}
        >
          {hasThinking && (
            <ReasoningRow text={thinking} running={working && toolCalls.length === 0} settledPreview={!working} />
          )}
          {toolNodes}
        </ProcessGroup>
      )}
    </div>
  );
}

export function registerHostConversationFactories(
  target: Pick<SlotRegistry, "registerFactory"> | Pick<ClientSlotsService, "registerFactory">,
): Array<() => void> {
  return [
    target.registerFactory("host.conversation.assistantMessage", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:conversation-assistant-message`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostAssistantMessageFactory,
    }),
    target.registerFactory("host.conversation.userMessage", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:conversation-user-message`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostUserMessageFactory,
    }),
    target.registerFactory("host.conversation.toolCall", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:conversation-tool-call`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostToolCallFactory,
    }),
    target.registerFactory("host.conversation.processGroup", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:conversation-process-group`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostProcessGroupFactory,
    }),
  ];
}
