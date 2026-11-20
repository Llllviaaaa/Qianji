/**
 * Built-in `side-chat` workbench pane (`SideChatTab`) & topbar toggle button (ADR 0023).
 *
 * Wraps the side-chat surface inside `<SessionArea sessionId={sideSessionId}>`
 * so `SlotScope: "session"` slots (`conversation.transcript`, `conversation.composerDock`)
 * share the exact same slot tree as the main conversation while keeping state
 * completely isolated via `useSessionHandle(sideSessionId, { isolated: true })`.
 */
import { useState, type FormEvent, type ReactElement } from "react";
import { MessageSquare, Send, Square } from "lucide-react";
import {
  useFrontendService,
  useSessionHandle,
  useSessionState,
  useWorkbenchState,
  useWorkspaceState,
  type SessionHandle,
  type SessionHandleSnapshot,
} from "@qianji/client";
import { Markdown } from "@qianji/client-primitives";
import {
  SessionArea,
  SlotHost,
  useSlotScope,
  type SlotComponentProps,
  type WorkbenchPaneSlotProps,
  type WorkbenchSlotBaseProps,
} from "@qianji/client-slots";

/** Topbar toggle button registered onto `workbench.topbarControls` by `side-chat`. */
export function SideChatTopbarButton({
  ctx,
}: SlotComponentProps<WorkbenchSlotBaseProps, "session-maybe">): ReactElement {
  const workbench = useWorkbenchState(ctx);
  const workbenchService = useFrontendService("workbenchService", ctx);
  const isOpen = (workbench?.openPanes ?? []).includes("side-chat");

  return (
    <button
      type="button"
      data-wb-tab="side-chat"
      data-plugin-topbar="side-chat"
      className={`pid-wb-top-toggle${isOpen ? " active" : ""}`}
      title={isOpen ? "关闭侧边对话" : "打开侧边对话 (Ctrl+Alt+S)"}
      aria-label="侧边对话"
      aria-pressed={isOpen}
      onClick={() => workbenchService?.togglePane("side-chat")}
    >
      <MessageSquare size={14} strokeWidth={1.65} />
    </button>
  );
}

function SideChatFallbackTranscript({
  snapshot,
}: {
  readonly snapshot: SessionHandleSnapshot | null;
}): ReactElement {
  const scope = useSlotScope();
  const messages = snapshot?.messages ?? [];

  if (messages.length === 0) {
    return (
      <div className="side-chat-messages" data-side-chat-scope={scope.sessionId ?? ""}>
        <div className="side-chat-state side-chat-empty-state">
          <MessageSquare size={20} strokeWidth={1.45} />
          <strong>独立分支对话</strong>
          <span>针对当前任务随时独立提问，不修改主对话上下文。</span>
        </div>
      </div>
    );
  }

  return (
    <div className="side-chat-messages" data-side-chat-scope={scope.sessionId ?? ""}>
      {messages.map((msg) => (
        <div key={msg.id} className={`side-chat-msg role-${msg.role}`}>
          <div className="side-chat-msg-role">{msg.role === "user" ? "你" : "助手"}</div>
          <div className="side-chat-msg-body">
            {msg.role === "assistant" ? <Markdown content={msg.content} /> : <p>{msg.content}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

function SideChatFallbackComposer({
  handle,
  snapshot,
}: {
  readonly handle: SessionHandle | null;
  readonly snapshot: SessionHandleSnapshot | null;
}): ReactElement {
  const [draft, setDraft] = useState("");
  const isStreaming = snapshot?.isStreaming === true;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = draft.trim();
    if (trimmed === "" || handle === null) return;
    setDraft("");
    void handle.sendMessage(trimmed);
  };

  return (
    <form className="side-chat-composer" onSubmit={handleSubmit}>
      <input
        type="text"
        className="side-chat-input"
        aria-label="侧边对话输入框"
        placeholder="在侧边分支中独立提问…"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      {isStreaming ? (
        <button
          type="button"
          className="pid-wb-btn small"
          aria-label="停止侧边对话"
          onClick={() => void handle?.abort()}
        >
          <Square size={12} />
          <span>停止</span>
        </button>
      ) : (
        <button
          type="submit"
          className="pid-wb-btn small primary"
          disabled={draft.trim() === "" || handle === null}
          aria-label="发送侧边对话"
        >
          <Send size={12} />
          <span>发送</span>
        </button>
      )}
    </form>
  );
}

/** Keyed `"side-chat"` pane rendered inside `workbench.panes`, bound to an isolated `<SessionArea>`. */
export function SideChatTab({
  cwd: propCwd,
  sessionFile: propSessionFile,
  active,
  renderFactory,
  ctx,
}: SlotComponentProps<WorkbenchPaneSlotProps, "session-maybe">): ReactElement {
  const hasHostSideChat =
    (ctx?.slots?.registry?.getFactoryCandidates("host.workbench.sideChat").length ?? 0) > 0;
  const session = useSessionState(ctx);
  const workspace = useWorkspaceState(ctx);

  const sessionFile = propSessionFile !== undefined ? propSessionFile : (session?.sessionFile ?? null);
  const parentSessionId = session?.sessionId ?? null;
  const cwd = propCwd ?? workspace?.cwd ?? session?.cwd ?? "";

  const anchorKey = sessionFile ?? parentSessionId ?? "";
  const effectiveSideId =
    anchorKey !== "" ? `side:${anchorKey}` : cwd !== "" ? `side:workspace:${cwd}` : null;

  const retained = useSessionHandle(
    hasHostSideChat ? null : effectiveSideId,
    hasHostSideChat || effectiveSideId === null
      ? undefined
      : {
          isolated: true,
          cwd,
          ...(sessionFile !== null && sessionFile !== "" ? { parentSessionFile: sessionFile } : {}),
        },
    ctx,
  );

  if (hasHostSideChat) {
    return (
      <div className="pid-wb-sidechat-host" data-feature-pane="side-chat" hidden={!active}>
        {renderFactory("host.workbench.sideChat", { cwd, sessionFile, active })}
      </div>
    );
  }

  if (effectiveSideId === null) {
    return (
      <section className="side-chat-pane" data-feature-pane="side-chat" aria-label="侧边聊天" hidden={!active}>
        <div className="side-chat-messages">
          <div className="side-chat-state side-chat-empty-state">
            <MessageSquare size={22} strokeWidth={1.45} />
            <strong>侧边对话</strong>
            <span>先在左侧开始一个对话任务，即可在此针对当前上下文独立提问。</span>
            <small>侧边对话不会修改或污染主对话记录。</small>
          </div>
        </div>
      </section>
    );
  }

  return (
    <div className="pid-wb-sidechat-host" data-feature-pane="side-chat" hidden={!active}>
      <SessionArea sessionId={effectiveSideId} disposeStoresOnUnmount>
        <section
          className="side-chat-pane"
          data-side-chat-session={effectiveSideId}
          aria-label="侧边聊天"
        >
          <div className="side-chat-surface-body">
            <SlotHost
              slotKey="conversation.transcript"
              kind="single"
              scope="session"
              props={{ cwd, sessionFile, compact: true }}
              fallback={<SideChatFallbackTranscript snapshot={retained.snapshot} />}
            />
          </div>
          <div className="side-chat-surface-composer">
            <SlotHost
              slotKey="conversation.composerDock"
              kind="single"
              scope="session-maybe"
              props={{ cwd, sessionFile, variant: "follow-up", isolated: true }}
              fallback={<SideChatFallbackComposer handle={retained.handle} snapshot={retained.snapshot} />}
            />
          </div>
        </section>
      </SessionArea>
    </div>
  );
}
