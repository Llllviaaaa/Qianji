/**
 * Tab 4: `蜂巢` (`SwarmHiveGraphTab.tsx`) — Interactive Honeycomb Hex Map,
 * Selected Workstream Detail Card, and Timeline Replay (`|◀`, `▶/⏸`, `▶|`, scrubber, `● 实时`).
 */
import { useEffect, useMemo, type ReactElement } from "react";
import { Check, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { IconButton } from "@qianji/client-primitives";
import type { SwarmBoardMessage, SwarmSnapshotResult } from "@qianji/protocol";
import {
  CENTER_PT,
  ringCenter,
  SwarmHoneycombHexCanvas,
  SwarmMentionsChordCanvas,
  type DirectedEdge2D,
  type MentionCountEdge,
  type Point2D,
} from "./SwarmHiveCanvases";
import { SwarmPixelBee } from "./SwarmPixelBee";
import { isMilestoneDoneMessage, prepareBoardMarkdownBody } from "./swarmLabels";
import {
  deriveOutcomeOverview,
  jumpToBoardSeq,
  patchSwarmUi,
  selectSwarmMember,
  swarmChannelKey,
  useSwarmData,
  useSwarmUi,
} from "./swarmStore";

export interface SwarmHiveGraphTabProps {
  readonly snapshot: SwarmSnapshotResult;
}

const ITEM_STATUS_LABELS = {
  done: "已完成",
  working: "推进中",
  waitingOn: "等待协同",
  stalled: "待唤醒",
  queued: "待命",
} as const;

export function SwarmHiveGraphTab({ snapshot }: SwarmHiveGraphTabProps): ReactElement {
  const data = useSwarmData();
  const ui = useSwarmUi();

  const allMessages = useMemo(() => {
    const bySeq = new Map<number, SwarmBoardMessage>();
    for (const m of snapshot.recentMessages) bySeq.set(m.seq, m);
    for (const ch of snapshot.run.channels) {
      const cached = data.boardBySwarmChannel[swarmChannelKey(snapshot.run.id, ch.name)] ?? [];
      for (const m of cached) bySeq.set(m.seq, m);
    }
    const mainCached = data.boardBySwarmChannel[swarmChannelKey(snapshot.run.id, "main")] ?? [];
    for (const m of mainCached) bySeq.set(m.seq, m);
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }, [data.boardBySwarmChannel, snapshot.recentMessages, snapshot.run.channels, snapshot.run.id]);

  const maxSeq = useMemo(() => {
    const lastMsgSeq = allMessages.length > 0 ? (allMessages[allMessages.length - 1]?.seq ?? 0) : 0;
    return Math.max(1, snapshot.run.headSeq, lastMsgSeq);
  }, [allMessages, snapshot.run.headSeq]);

  const isLive = ui.hiveReplaySeq === null;
  const effectiveSeq = isLive ? maxSeq : Math.min(maxSeq, Math.max(1, ui.hiveReplaySeq ?? maxSeq));

  useEffect(() => {
    if (!ui.hivePlaying) return undefined;
    const timer = setInterval(() => {
      const curr = ui.hiveReplaySeq ?? 1;
      if (curr >= maxSeq) {
        patchSwarmUi({ hivePlaying: false, hiveReplaySeq: null });
      } else {
        patchSwarmUi({ hiveReplaySeq: curr + 1 });
      }
    }, 850);
    return () => clearInterval(timer);
  }, [maxSeq, ui.hivePlaying, ui.hiveReplaySeq]);

  const overview = useMemo(() => deriveOutcomeOverview(snapshot), [snapshot]);
  const threads = overview.threads.slice(0, 6);

  const selectedThread = useMemo(
    () => threads.find((th) => th.id === ui.selectedHexThreadId) ?? threads[0] ?? null,
    [threads, ui.selectedHexThreadId],
  );

  const replayDoneMembers = useMemo(() => {
    if (isLive) return null;
    const done = new Set<string>();
    for (const msg of allMessages) {
      if (msg.seq > effectiveSeq) break;
      const msgDone = isMilestoneDoneMessage(msg);
      if (msgDone) done.add(msg.sender);
      for (const target of msg.mentions) {
        if (!msgDone) done.delete(target);
      }
    }
    return done;
  }, [allMessages, effectiveSeq, isLive]);

  const activeMessage = useMemo(() => {
    for (let i = allMessages.length - 1; i >= 0; i -= 1) {
      const m = allMessages[i];
      if (m !== undefined && m.seq <= effectiveSeq) return m;
    }
    return null;
  }, [allMessages, effectiveSeq]);

  const memberHexPosition = useMemo(() => {
    const map = new Map<string, Point2D>();
    map.set("coordinator", CENTER_PT);
    threads.forEach((th, idx) => {
      const pt = ringCenter(idx);
      for (const item of th.items) {
        if (!map.has(item.memberName)) map.set(item.memberName, pt);
      }
    });
    for (const m of snapshot.members) {
      if (!map.has(m.name)) map.set(m.name, CENTER_PT);
    }
    return map;
  }, [snapshot.members, threads]);

  const waitingEdges = useMemo<DirectedEdge2D[]>(() => {
    const edges: DirectedEdge2D[] = [];
    for (const m of snapshot.members) {
      if (m.killed || !m.waitingOn) continue;
      const from = memberHexPosition.get(m.name);
      const to = memberHexPosition.get(m.waitingOn);
      if (from && to && (from.x !== to.x || from.y !== to.y)) {
        edges.push({ from, to, key: `${m.name}->${m.waitingOn}` });
      }
    }
    return edges;
  }, [memberHexPosition, snapshot.members]);

  const pulseBeams = useMemo<DirectedEdge2D[]>(() => {
    if (activeMessage === null) return [];
    const from = memberHexPosition.get(activeMessage.sender) ?? CENTER_PT;
    const targets = activeMessage.mentionAll
      ? snapshot.members.filter((m) => m.name !== activeMessage.sender && !m.killed).map((m) => m.name)
      : activeMessage.mentions;
    const beams: DirectedEdge2D[] = [];
    const seenCoords = new Set<string>();
    for (const t of targets) {
      const to = memberHexPosition.get(t);
      if (!to || (to.x === from.x && to.y === from.y)) continue;
      const coordKey = `${to.x.toFixed(0)}:${to.y.toFixed(0)}`;
      if (seenCoords.has(coordKey)) continue;
      seenCoords.add(coordKey);
      beams.push({ from, to, key: `${activeMessage.seq}:${t}` });
    }
    return beams;
  }, [activeMessage, memberHexPosition, snapshot.members]);

  const mentionEdges = useMemo<MentionCountEdge[]>(() => {
    const counts = new Map<string, { from: string; to: string; count: number }>();
    const known = new Set(snapshot.members.map((m) => m.name));
    for (const msg of allMessages) {
      if (msg.seq > effectiveSeq) break;
      if (!known.has(msg.sender)) continue;
      const recipients = msg.mentionAll
        ? snapshot.members.filter((m) => m.name !== msg.sender).map((m) => m.name)
        : msg.mentions.filter((t) => known.has(t) && t !== msg.sender);
      for (const r of recipients) {
        const key = `${msg.sender}->${r}`;
        const prev = counts.get(key);
        if (prev) prev.count += 1;
        else counts.set(key, { from: msg.sender, to: r, count: 1 });
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  }, [allMessages, effectiveSeq, snapshot.members]);

  const queen = snapshot.members.find((m) => m.role === "coordinator" || m.name === "coordinator");

  return (
    <div className="qj-swarm-hive-tab" data-testid="swarm-hive-tab">
      <div className="qj-swarm-hive-toolbar">
        <div className="qj-swarm-replay-controls">
          <IconButton
            size="sm"
            aria-label="回退一步"
            data-testid="swarm-hive-step-back"
            disabled={effectiveSeq <= 1}
            onClick={() => patchSwarmUi({ hivePlaying: false, hiveReplaySeq: Math.max(1, effectiveSeq - 1) })}
          >
            <SkipBack size={12} />
          </IconButton>

          <IconButton
            size="sm"
            aria-label={ui.hivePlaying ? "暂停回放" : "播放回放"}
            onClick={() => {
              if (ui.hivePlaying) {
                patchSwarmUi({ hivePlaying: false });
              } else {
                const startSeq = effectiveSeq >= maxSeq ? 1 : effectiveSeq;
                patchSwarmUi({ hiveReplaySeq: startSeq, hivePlaying: true });
              }
            }}
          >
            {ui.hivePlaying ? <Pause size={12} /> : <Play size={12} />}
          </IconButton>

          <IconButton
            size="sm"
            aria-label="前进一步"
            data-testid="swarm-hive-step-forward"
            disabled={isLive || effectiveSeq >= maxSeq}
            onClick={() => {
              const next = effectiveSeq + 1;
              patchSwarmUi({ hivePlaying: false, hiveReplaySeq: next >= maxSeq ? null : next });
            }}
          >
            <SkipForward size={12} />
          </IconButton>

          <input
            type="range"
            min={1}
            max={maxSeq}
            value={effectiveSeq}
            aria-label="消息时间轴进度"
            data-testid="swarm-hive-scrubber"
            className="qj-swarm-scrubber"
            onChange={(e) => {
              const next = Number.parseInt(e.target.value, 10);
              patchSwarmUi({ hivePlaying: false, hiveReplaySeq: Number.isFinite(next) ? next : null });
            }}
          />

          <button
            type="button"
            className={`qj-swarm-live-pill${isLive ? " is-live" : ""}`}
            data-testid="swarm-hive-live-btn"
            onClick={() => patchSwarmUi({ hivePlaying: false, hiveReplaySeq: null })}
          >
            <span className="qj-swarm-live-dot" aria-hidden="true" />
            <span>{isLive ? "实时" : `#${effectiveSeq}`}</span>
          </button>
        </div>

        <div className="qj-swarm-hive-seg" role="tablist" aria-label="拓扑模式">
          <button
            type="button"
            role="tab"
            aria-selected={ui.hiveMode === "hex"}
            data-testid="swarm-hive-mode-hex"
            className={`qj-swarm-seg-btn${ui.hiveMode === "hex" ? " active" : ""}`}
            onClick={() => patchSwarmUi({ hiveMode: "hex" })}
          >
            蜂巢
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={ui.hiveMode === "mentions"}
            data-testid="swarm-hive-mode-mentions"
            className={`qj-swarm-seg-btn${ui.hiveMode === "mentions" ? " active" : ""}`}
            onClick={() => patchSwarmUi({ hiveMode: "mentions" })}
          >
            通信
          </button>
        </div>
      </div>

      {ui.hiveMode === "hex" ? (
        <>
          <SwarmHoneycombHexCanvas
            queen={queen}
            threads={threads}
            selectedThreadId={selectedThread?.id ?? null}
            onSelectThread={(threadId) => patchSwarmUi({ selectedHexThreadId: threadId })}
            replayDoneMembers={replayDoneMembers}
            isLive={isLive}
            activeMessage={activeMessage}
            waitingEdges={waitingEdges}
            pulseBeams={pulseBeams}
          />

          {selectedThread !== null && (
            <section
              className="qj-swarm-hex-detail-card"
              data-testid="swarm-hex-detail-card"
              data-thread-id={selectedThread.id}
            >
              <header className="qj-swarm-hex-detail-head">
                <span className={`qj-swarm-thread-dot state-${selectedThread.state}`} aria-hidden="true" />
                <strong className="qj-swarm-hex-detail-title">{selectedThread.title}</strong>
                <span className="qj-swarm-thread-fraction">
                  {selectedThread.doneCount}/{selectedThread.totalCount}
                </span>
              </header>
              {selectedThread.goal !== "" && selectedThread.goal !== selectedThread.title && (
                <p className="qj-swarm-thread-goal">{selectedThread.goal}</p>
              )}
              <div className="qj-swarm-hex-detail-members">
                {selectedThread.items.map((item) => {
                  const dirtyCount = item.member?.changedFileCount ?? 0;
                  return (
                    <div key={item.memberName} className="qj-swarm-hex-member-row">
                      <button
                        type="button"
                        className="qj-swarm-hex-member-main"
                        data-testid={`swarm-hex-member-${item.memberName}`}
                        onClick={() => selectSwarmMember(item.memberName, { inspectorTab: "session" })}
                      >
                        <SwarmPixelBee
                          name={item.memberName}
                          state={item.member?.state ?? "waiting"}
                          killed={item.member?.killed ?? false}
                          size="sm"
                        />
                        <span className="qj-swarm-row-handle">@{item.memberName}</span>
                        <span className="qj-swarm-thread-task">{item.label}</span>
                        {item.status === "done" ? (
                          <Check size={12} className="qj-swarm-check-icon" />
                        ) : (
                          <span className={`qj-swarm-hex-status-tag is-${item.status}`}>
                            {item.waitingOn !== undefined ? `等待 @${item.waitingOn}` : ITEM_STATUS_LABELS[item.status]}
                          </span>
                        )}
                      </button>

                      {dirtyCount > 0 && (
                        <button
                          type="button"
                          className="qj-swarm-dirty-pill"
                          data-testid={`swarm-hex-diff-${item.memberName}`}
                          onClick={() => selectSwarmMember(item.memberName, { inspectorTab: "diff" })}
                        >
                          +{dirtyCount} 变更
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </>
      ) : (
        <SwarmMentionsChordCanvas
          members={snapshot.members}
          mentionEdges={mentionEdges}
          activeMessage={activeMessage}
        />
      )}

      {activeMessage !== null && (
        <button
          type="button"
          className="qj-swarm-hive-caption"
          data-testid="swarm-hive-seq-caption"
          onClick={() => jumpToBoardSeq(activeMessage.seq, activeMessage.channel)}
        >
          <span className="qj-swarm-seq-pill">#{activeMessage.seq}</span>
          <strong className="qj-swarm-row-handle">@{activeMessage.sender}</strong>
          <span className="qj-swarm-hive-snippet">
            {prepareBoardMarkdownBody(
              activeMessage.text,
              activeMessage.mentions,
              activeMessage.mentionAll,
            )
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 68)}
          </span>
        </button>
      )}
    </div>
  );
}
