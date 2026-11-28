/**
 * Tab 2: Connected Timeline & Rich Markdown `消息板` (`src/builtin-plugins/swarm/SwarmMessageBoard.tsx`).
 *
 * - Slim `30px` search input + collapsible member filter + conditional `#channel` pills
 * - Connected timeline stream (`SwarmBoardMessageRow`) with Markdown, `#seq` jump, and smart collapse
 * - Smart auto-follow scroll + floating `跳至最新 (#N)` jump pill when scrolled up
 * - Contextual `@member` autocomplete chips above input when focused or typing `@`
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { ArrowDown, Filter, Hash, Search, Send, X } from "lucide-react";
import { IconButton } from "@qianji/client-primitives";
import type { SwarmBoardMessage, SwarmSnapshotResult } from "@qianji/protocol";
import { SwarmBoardMessageRow } from "./SwarmBoardMessageRow";
import {
  jumpToBoardSeq,
  patchSwarmUi,
  swarmChannelKey,
  useSwarmData,
  useSwarmUi,
} from "./swarmStore";
import { useSwarmController } from "./useSwarmController";

export interface SwarmMessageBoardProps {
  readonly snapshot: SwarmSnapshotResult;
  readonly ctx?: Context;
  /** Optional initial draft for controlled SSR / unit test scenarios. */
  readonly initialDraft?: string;
}

export function SwarmMessageBoard({ snapshot, ctx, initialDraft = "" }: SwarmMessageBoardProps): ReactElement {
  const data = useSwarmData();
  const ui = useSwarmUi();
  const controller = useSwarmController(ctx);

  const [draft, setDraft] = useState(initialDraft);
  const [replyToSeq, setReplyToSeq] = useState<number | undefined>(undefined);
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);
  const [expandedSeqs, setExpandedSeqs] = useState<ReadonlySet<number>>(() => new Set());
  const [atBottom, setAtBottom] = useState(true);
  const [inputFocused, setInputFocused] = useState(false);

  const streamRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const channels = useMemo(() => {
    const names = new Set<string>(["main"]);
    for (const ch of snapshot.run.channels) {
      if (!ch.archived && ch.name.trim() !== "") names.add(ch.name.trim());
    }
    for (const msg of snapshot.recentMessages) {
      if (msg.channel.trim() !== "") names.add(msg.channel.trim());
    }
    return [...names];
  }, [snapshot.recentMessages, snapshot.run.channels]);

  const activeChannel = channels.includes(ui.activeChannel) ? ui.activeChannel : "main";

  const allMessages = useMemo(() => {
    const bySeq = new Map<number, SwarmBoardMessage>();
    for (const m of snapshot.recentMessages) bySeq.set(m.seq, m);
    for (const ch of channels) {
      const cached = data.boardBySwarmChannel[swarmChannelKey(snapshot.run.id, ch)] ?? [];
      for (const m of cached) bySeq.set(m.seq, m);
    }
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }, [channels, data.boardBySwarmChannel, snapshot.recentMessages, snapshot.run.id]);

  const membersByName = useMemo(
    () => new Map(snapshot.members.map((m) => [m.name, m] as const)),
    [snapshot.members],
  );

  const visibleMessages = useMemo(() => {
    const q = ui.boardSearchQuery.trim().toLowerCase();
    const memberFilter = ui.boardMemberFilter;
    return allMessages.filter((m) => {
      if ((m.channel || "main") !== activeChannel) return false;
      if (memberFilter !== null) {
        const involves = m.sender === memberFilter || m.mentions.includes(memberFilter) || m.mentionAll;
        if (!involves) return false;
      }
      if (q !== "") {
        const seqMatch = `#${m.seq}` === q || String(m.seq) === q;
        const textMatch = m.text.toLowerCase().includes(q) || m.sender.toLowerCase().includes(q);
        if (!seqMatch && !textMatch) return false;
      }
      return true;
    });
  }, [activeChannel, allMessages, ui.boardMemberFilter, ui.boardSearchQuery]);

  const latestSeq = visibleMessages.length > 0 ? (visibleMessages[visibleMessages.length - 1]?.seq ?? 0) : 0;

  useEffect(() => {
    const el = streamRef.current;
    if (el === null || !atBottom || ui.highlightedSeq !== null) return;
    el.scrollTop = el.scrollHeight;
  }, [atBottom, latestSeq, ui.highlightedSeq, visibleMessages.length]);

  const trailingMentionQuery = useMemo(() => {
    const match = /(?:^|\s)@([a-zA-Z0-9_-]*)$/.exec(draft);
    return match !== null ? (match[1] ?? "") : null;
  }, [draft]);

  const mentionSuggestions = useMemo(() => {
    if (!inputFocused && trailingMentionQuery === null) return [];
    const liveHandles = snapshot.members.filter((m) => !m.killed).map((m) => m.name);
    const pool = [...liveHandles, "all"];
    if (trailingMentionQuery !== null) {
      const q = trailingMentionQuery.toLowerCase();
      return pool.filter((name) => name.toLowerCase().includes(q)).slice(0, 6);
    }
    return pool.filter((name) => !draft.includes(`@${name}`)).slice(0, 6);
  }, [draft, inputFocused, snapshot.members, trailingMentionQuery]);

  const insertMentionChip = (handle: string) => {
    setDraft((prev) => {
      if (/(?:^|\s)@[a-zA-Z0-9_-]*$/.test(prev)) {
        return prev.replace(/@([a-zA-Z0-9_-]*)$/, `@${handle} `);
      }
      return prev.trim() === "" ? `@${handle} ` : `${prev.trimEnd()} @${handle} `;
    });
    inputRef.current?.focus();
  };

  const handleSeqClick = (targetSeq: number) => {
    const found = allMessages.find((m) => m.seq === targetSeq);
    const targetChannel = found?.channel || activeChannel;
    jumpToBoardSeq(targetSeq, targetChannel);
    if (typeof document !== "undefined") {
      const el = document.getElementById(`swarm-msg-seq-${targetSeq}`);
      if (el !== null && typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  };

  const toggleExpandSeq = (seq: number) => {
    setExpandedSeqs((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  };

  const scrollToLatest = () => {
    const el = streamRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
    setAtBottom(true);
    patchSwarmUi({ highlightedSeq: null });
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = draft.trim();
    if (trimmed === "") return;
    const res = await controller.postBoardMessage(snapshot.run.id, trimmed, {
      channel: activeChannel,
      replyToSeq,
    });
    if (res !== null) {
      setDraft("");
      setReplyToSeq(undefined);
      setAtBottom(true);
    }
  };

  const showFilterRow = filterDrawerOpen || ui.boardMemberFilter !== null;

  return (
    <section className="qj-swarm-board" data-testid="swarm-message-board">
      <div className="qj-swarm-board-topbar">
        <div className="qj-swarm-search-wrap">
          <Search size={12.5} className="qj-swarm-search-icon" aria-hidden="true" />
          <input
            type="text"
            value={ui.boardSearchQuery}
            onChange={(e) => patchSwarmUi({ boardSearchQuery: e.target.value })}
            placeholder="搜索消息或 #序号…"
            aria-label="搜索消息板"
            className="qj-swarm-board-search"
          />
          {ui.boardSearchQuery !== "" && (
            <button
              type="button"
              className="qj-swarm-search-clear"
              aria-label="清除搜索"
              onClick={() => patchSwarmUi({ boardSearchQuery: "" })}
            >
              <X size={11} />
            </button>
          )}
        </div>

        <IconButton
          size="sm"
          aria-label="按成员筛选消息"
          active={showFilterRow}
          onClick={() => setFilterDrawerOpen((v) => !v)}
        >
          <Filter size={13} />
        </IconButton>
      </div>

      {showFilterRow && (
        <div className="qj-swarm-board-filters" role="group" aria-label="成员筛选">
          <button
            type="button"
            className={`qj-swarm-filter-chip${ui.boardMemberFilter === null ? " active" : ""}`}
            onClick={() => patchSwarmUi({ boardMemberFilter: null })}
          >
            全部
          </button>
          {snapshot.members.map((m) => (
            <button
              key={m.name}
              type="button"
              className={`qj-swarm-filter-chip${ui.boardMemberFilter === m.name ? " active" : ""}`}
              onClick={() => patchSwarmUi({ boardMemberFilter: ui.boardMemberFilter === m.name ? null : m.name })}
            >
              @{m.name}
            </button>
          ))}
        </div>
      )}

      {channels.length > 1 && (
        <div className="qj-swarm-board-channels" role="tablist" aria-label="消息频道">
          {channels.map((ch) => {
            const isCurrent = ch === activeChannel;
            const count = allMessages.filter((m) => (m.channel || "main") === ch).length;
            return (
              <button
                key={ch}
                type="button"
                role="tab"
                aria-selected={isCurrent}
                className={`qj-swarm-channel-pill${isCurrent ? " active" : ""}`}
                onClick={() => void controller.loadBoardChannel(snapshot.run.id, ch)}
              >
                <Hash size={11} />
                <span>{ch}</span>
                <span className="qj-swarm-channel-count">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="qj-swarm-board-stage">
        <div
          ref={streamRef}
          className="qj-swarm-board-stream"
          role="log"
          aria-label="消息板记录"
          onScroll={() => {
            const el = streamRef.current;
            if (el === null) return;
            setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight <= 48);
          }}
        >
          {visibleMessages.length === 0 ? (
            <div className="qj-swarm-empty-state">
              <span>{ui.boardSearchQuery !== "" || ui.boardMemberFilter !== null ? "无匹配的消息记录" : "暂无消息记录"}</span>
              {(ui.boardSearchQuery !== "" || ui.boardMemberFilter !== null) && (
                <button
                  type="button"
                  className="qj-swarm-inline-action"
                  onClick={() => patchSwarmUi({ boardSearchQuery: "", boardMemberFilter: null })}
                >
                  清除筛选条件
                </button>
              )}
            </div>
          ) : (
            visibleMessages.map((msg, idx) => (
              <SwarmBoardMessageRow
                key={msg.seq}
                msg={msg}
                cwd={snapshot.run.cwd}
                isHighlighted={ui.highlightedSeq === msg.seq}
                isExpanded={expandedSeqs.has(msg.seq) || ui.highlightedSeq === msg.seq}
                isLast={idx === visibleMessages.length - 1}
                senderMember={membersByName.get(msg.sender)}
                onToggleExpand={toggleExpandSeq}
                onSeqJump={handleSeqClick}
                onReplySelect={(selected) => {
                  handleSeqClick(selected.seq);
                  setReplyToSeq(selected.seq);
                  if (selected.sender !== "user" && !draft.includes(`@${selected.sender}`)) {
                    setDraft((prev) => `${prev.trim() === "" ? "" : `${prev.trimEnd()} `}@${selected.sender} `);
                  }
                }}
                onWakeMember={(targetName) => {
                  void controller.controlMember(snapshot.run.id, targetName, "nudge", {
                    message: "请在消息板同步当前进展并继续推进",
                  });
                }}
              />
            ))
          )}
        </div>

        {!atBottom && latestSeq > 0 && (
          <button
            type="button"
            className="qj-swarm-jump-latest-pill"
            data-testid="swarm-board-jump-latest"
            onClick={scrollToLatest}
          >
            <ArrowDown size={12} />
            <span>跳至最新 (#{latestSeq})</span>
          </button>
        )}
      </div>

      <form className="qj-swarm-board-composer" onSubmit={(e) => void handleSubmit(e)}>
        {replyToSeq !== undefined && (
          <div className="qj-swarm-reply-bar">
            <span>回复 #{replyToSeq}</span>
            <button type="button" aria-label="取消回复" onClick={() => setReplyToSeq(undefined)}>
              <X size={11} />
            </button>
          </div>
        )}

        {mentionSuggestions.length > 0 && (
          <div className="qj-swarm-mention-bar" data-testid="swarm-board-mention-bar" role="listbox" aria-label="提及成员">
            {mentionSuggestions.map((handle) => (
              <button
                key={handle}
                type="button"
                className="qj-swarm-mention-chip"
                data-testid={`swarm-mention-chip-${handle}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insertMentionChip(handle)}
              >
                @{handle}
              </button>
            ))}
          </div>
        )}

        <div className="qj-swarm-composer-line">
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="向成员发送协调指令…"
            aria-label="向成员发送协调指令"
            className="qj-swarm-composer-input"
          />
          <IconButton
            size="sm"
            variant={draft.trim() !== "" ? "primary" : "ghost"}
            type="submit"
            aria-label="发送消息"
            disabled={draft.trim() === "" || ui.busyAction === "board:post"}
          >
            <Send size={12.5} />
          </IconButton>
        </div>
      </form>
    </section>
  );
}
