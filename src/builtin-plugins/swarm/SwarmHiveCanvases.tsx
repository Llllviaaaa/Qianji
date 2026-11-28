/**
 * Axial Honeycomb Hex SVG & Monochrome `@mention` Chord Canvases
 * (`src/builtin-plugins/swarm/SwarmHiveCanvases.tsx`).
 */
import type { ReactElement } from "react";
import type { SwarmBoardMessage, SwarmMemberInfo, SwarmMemberState } from "@qianji/protocol";
import { SwarmPixelBeeSvgNode } from "./SwarmPixelBee";
import type { ResolvedOutcomeThread } from "./swarmSelectors";
import { selectSwarmMember } from "./swarmStore";

export interface Point2D {
  readonly x: number;
  readonly y: number;
}

export interface DirectedEdge2D {
  readonly from: Point2D;
  readonly to: Point2D;
  readonly key: string;
}

export interface MentionCountEdge {
  readonly from: string;
  readonly to: string;
  readonly count: number;
}

export const CENTER_PT: Point2D = { x: 200, y: 168 };
const HEX_RADIUS = 50;
const RING_DISTANCE = 104;
export const RING_ANGLES_DEG: readonly number[] = [-90, -30, 30, 90, 150, 210];

function hexPolygonPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const rad = ((60 * i - 30) * Math.PI) / 180;
    pts.push(`${(cx + r * Math.cos(rad)).toFixed(1)},${(cy + r * Math.sin(rad)).toFixed(1)}`);
  }
  return pts.join(" ");
}

export function ringCenter(slotIndex: number): Point2D {
  const deg = RING_ANGLES_DEG[slotIndex % 6] ?? -90;
  const rad = (deg * Math.PI) / 180;
  return {
    x: CENTER_PT.x + RING_DISTANCE * Math.cos(rad),
    y: CENTER_PT.y + RING_DISTANCE * Math.sin(rad),
  };
}

function truncateCellTitle(title: string): string {
  const clean = title.trim();
  return clean.length > 6 ? `${clean.slice(0, 5)}…` : clean;
}

function beeOffsetInHex(index: number, count: number): Point2D {
  if (count <= 1) return { x: -11, y: -3 };
  if (count === 2) return { x: index === 0 ? -22 : 1, y: -3 };
  const positions: readonly Point2D[] = [
    { x: -22, y: -8 },
    { x: 1, y: -8 },
    { x: -11, y: 5 },
  ];
  return positions[index % 3] ?? { x: -11, y: -3 };
}

export function SwarmHoneycombHexCanvas({
  queen,
  threads,
  selectedThreadId,
  onSelectThread,
  replayDoneMembers,
  isLive,
  activeMessage,
  waitingEdges,
  pulseBeams,
}: {
  readonly queen: SwarmMemberInfo | undefined;
  readonly threads: readonly ResolvedOutcomeThread[];
  readonly selectedThreadId: string | null;
  readonly onSelectThread: (threadId: string) => void;
  readonly replayDoneMembers: ReadonlySet<string> | null;
  readonly isLive: boolean;
  readonly activeMessage: SwarmBoardMessage | null;
  readonly waitingEdges: readonly DirectedEdge2D[];
  readonly pulseBeams: readonly DirectedEdge2D[];
}): ReactElement {
  return (
    <div className="qj-swarm-hex-stage" data-testid="swarm-honeycomb-svg-wrap">
      <svg viewBox="0 0 400 336" className="qj-swarm-hex-svg" role="img" aria-label="蜂巢主线拓扑图">
        <defs>
          <marker id="qj-hive-arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 1 L 7 4 L 0 7 z" fill="var(--qj-brand-primary)" />
          </marker>
        </defs>

        {RING_ANGLES_DEG.map((_, slotIdx) => {
          const pt = ringCenter(slotIdx);
          const thread = threads[slotIdx];
          const poly = hexPolygonPoints(pt.x, pt.y, HEX_RADIUS);

          if (thread === undefined) {
            return (
              <polygon
                key={`empty-${slotIdx}`}
                points={poly}
                fill="transparent"
                stroke="var(--qj-border-subtle)"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
            );
          }

          const doneInSlot =
            replayDoneMembers !== null
              ? thread.items.filter((it) => replayDoneMembers.has(it.memberName)).length
              : thread.doneCount;
          const pct = thread.totalCount > 0 ? Math.round((doneInSlot / thread.totalCount) * 100) : 0;
          const isCompleted = thread.totalCount > 0 && doneInSlot === thread.totalCount;
          const isSelected = selectedThreadId === thread.id;

          return (
            <g
              key={thread.id}
              className={`qj-swarm-hex-cell${isSelected ? " is-selected" : ""}`}
              data-hex-thread={thread.id}
              data-selected={isSelected ? "true" : undefined}
              onClick={() => onSelectThread(thread.id)}
            >
              <title>{thread.title}</title>
              <polygon
                points={poly}
                fill={
                  isSelected
                    ? "var(--qj-bg-elevated)"
                    : isCompleted
                      ? "var(--qj-bg-app)"
                      : "var(--qj-bg-subtle)"
                }
                stroke={isSelected ? "var(--qj-brand-primary)" : "var(--qj-border-strong)"}
                strokeWidth={isSelected ? "1.8" : "1.2"}
              />
              {pct > 0 && (
                <polygon
                  points={poly}
                  pathLength={100}
                  fill="none"
                  stroke="var(--qj-status-success)"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeDasharray={`${pct} 100`}
                />
              )}
              <text x={pt.x} y={pt.y - 14} textAnchor="middle" className="qj-swarm-hex-title">
                {truncateCellTitle(thread.title)}
              </text>
              {thread.items.slice(0, 3).map((item, bIdx) => {
                const offset = beeOffsetInHex(bIdx, Math.min(3, thread.items.length));
                const beeState: SwarmMemberState =
                  !isLive && activeMessage?.sender === item.memberName
                    ? "working"
                    : (item.member?.state ?? "waiting");
                return (
                  <SwarmPixelBeeSvgNode
                    key={item.memberName}
                    name={item.memberName}
                    state={beeState}
                    killed={item.member?.killed ?? false}
                    x={pt.x + offset.x}
                    y={pt.y + offset.y}
                    width={22}
                    height={18}
                  />
                );
              })}
              <text x={pt.x} y={pt.y + 28} textAnchor="middle" className="qj-swarm-hex-meta">
                {doneInSlot}/{thread.totalCount}
              </text>
            </g>
          );
        })}

        <g
          className="qj-swarm-hex-cell is-queen-cell"
          data-hex-queen="true"
          onClick={() => selectSwarmMember(queen?.name ?? "coordinator")}
        >
          <title>{`协调蜂后 @${queen?.name ?? "coordinator"}`}</title>
          <polygon
            points={hexPolygonPoints(CENTER_PT.x, CENTER_PT.y, HEX_RADIUS)}
            fill="var(--qj-bg-elevated)"
            stroke="var(--qj-border-strong)"
            strokeWidth="1.5"
          />
          <text x={CENTER_PT.x} y={CENTER_PT.y - 14} textAnchor="middle" className="qj-swarm-hex-title">
            协调蜂后
          </text>
          <SwarmPixelBeeSvgNode
            name={queen?.name ?? "coordinator"}
            isQueen
            state={queen?.state ?? "working"}
            x={CENTER_PT.x - 13}
            y={CENTER_PT.y - 5}
            width={26}
            height={21}
          />
          <text x={CENTER_PT.x} y={CENTER_PT.y + 28} textAnchor="middle" className="qj-swarm-hex-meta">
            @{queen?.name ?? "coordinator"}
          </text>
        </g>

        {waitingEdges.map((edge) => (
          <line
            key={edge.key}
            x1={edge.from.x}
            y1={edge.from.y}
            x2={edge.to.x}
            y2={edge.to.y}
            stroke="var(--qj-status-warning)"
            strokeWidth="1.4"
            strokeDasharray="4 3"
            opacity="0.85"
          />
        ))}

        {pulseBeams.map((beam) => (
          <g key={beam.key} className="qj-swarm-pulse-beam">
            <line
              x1={beam.from.x}
              y1={beam.from.y}
              x2={beam.to.x}
              y2={beam.to.y}
              stroke="var(--qj-brand-primary)"
              strokeWidth="1.75"
              markerEnd="url(#qj-hive-arrow)"
            />
            <circle
              cx={(beam.from.x + beam.to.x) / 2}
              cy={(beam.from.y + beam.to.y) / 2}
              r="3"
              fill="var(--qj-brand-primary)"
              className="qj-swarm-pulse-dot"
            />
          </g>
        ))}
      </svg>
    </div>
  );
}

export function SwarmMentionsChordCanvas({
  members,
  mentionEdges,
  activeMessage,
}: {
  readonly members: readonly SwarmMemberInfo[];
  readonly mentionEdges: readonly MentionCountEdge[];
  readonly activeMessage: SwarmBoardMessage | null;
}): ReactElement {
  const nodes = members.filter((m) => !m.killed);
  const count = Math.max(1, nodes.length);
  const coords = new Map<string, Point2D>();
  nodes.forEach((m, idx) => {
    const rad = ((2 * Math.PI * idx) / count) - Math.PI / 2;
    coords.set(m.name, { x: 190 + 96 * Math.cos(rad), y: 140 + 92 * Math.sin(rad) });
  });
  const maxCount = Math.max(1, mentionEdges[0]?.count ?? 1);

  return (
    <div className="qj-swarm-mentions-stage" data-testid="swarm-mentions-graph">
      <svg viewBox="0 0 380 280" className="qj-swarm-hex-svg" role="img" aria-label="成员通信关系图">
        {mentionEdges.map((edge) => {
          const a = coords.get(edge.from);
          const b = coords.get(edge.to);
          if (!a || !b) return null;
          const weight = 1 + (edge.count / maxCount) * 2.2;
          const isCurrent =
            activeMessage?.sender === edge.from &&
            (activeMessage.mentionAll || activeMessage.mentions.includes(edge.to));
          const ctrlX = (a.x + b.x) / 2 + (190 - (a.x + b.x) / 2) * 0.28;
          const ctrlY = (a.y + b.y) / 2 + (140 - (a.y + b.y) / 2) * 0.28;
          return (
            <path
              key={`${edge.from}->${edge.to}`}
              d={`M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${ctrlX.toFixed(1)} ${ctrlY.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`}
              fill="none"
              stroke={isCurrent ? "var(--qj-brand-primary)" : "var(--qj-text-muted)"}
              strokeWidth={weight.toFixed(2)}
              strokeOpacity={isCurrent ? 0.92 : 0.42}
            />
          );
        })}
        {nodes.map((m) => {
          const pt = coords.get(m.name) ?? { x: 190, y: 140 };
          const isQ = m.role === "coordinator" || m.name === "coordinator";
          return (
            <g key={m.name} className="qj-swarm-chord-node" onClick={() => selectSwarmMember(m.name)}>
              <circle cx={pt.x} cy={pt.y} r="18" fill="var(--qj-bg-subtle)" stroke="var(--qj-border-strong)" strokeWidth="1.2" />
              <SwarmPixelBeeSvgNode name={m.name} isQueen={isQ} state={m.state} x={pt.x - 11} y={pt.y - 9} width={22} height={18} />
              <text x={pt.x} y={pt.y + 29} textAnchor="middle" className="qj-swarm-hex-meta">
                @{m.name}
              </text>
            </g>
          );
        })}
      </svg>

      {mentionEdges.length > 0 && (
        <div className="qj-swarm-chord-legend">
          {mentionEdges.slice(0, 4).map((e) => (
            <span key={`${e.from}->${e.to}`} className="qj-swarm-chord-pair">
              <span>@{e.from}</span>
              <span className="qj-swarm-chord-sep">致</span>
              <span>@{e.to}</span>
              <strong>{e.count}</strong>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
