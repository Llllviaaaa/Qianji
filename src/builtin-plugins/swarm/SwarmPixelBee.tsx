/**
 * Procedural Pixel-Art Bees (`src/builtin-plugins/swarm/SwarmPixelBee.tsx`).
 *
 * Signature visual identity for Qianji Swarm v2:
 * - Crisp integer-grid SVG pixel art (`shapeRendering="crispEdges"`) in 3 sizes:
 *   `sm` (`22×18`), `md` (`36×30`), `lg` (`52×42`).
 * - `isQueen` (`@coordinator`) wears a 5-pixel gold crown (`#eab308`).
 * - Deterministic subtle accent stripe per worker name so each bee is recognizable
 *   at a glance while the chitin body stays warm charcoal & honey gold.
 * - State expression:
 *   - `working`: raised translucent wings with compositor-only CSS flutter (`transform`/`opacity`)
 *   - `waiting`: folded wings resting on back + tiny muted pixel `z`
 *   - `stalled` / `blocked`: amber/coral antenna alert tip
 *   - `killed` / `stopped`: desaturated (`opacity: 0.48`)
 */
import type { ReactElement } from "react";
import type { SwarmMemberInfo, SwarmMemberState } from "@qianji/protocol";

export type SwarmPixelBeeSize = "sm" | "md" | "lg";

export interface SwarmPixelBeeProps {
  readonly name: string;
  readonly isQueen?: boolean;
  readonly state?: SwarmMemberState;
  readonly killed?: boolean;
  readonly size?: SwarmPixelBeeSize;
  readonly className?: string;
  readonly title?: string;
}

export interface SwarmPixelBeeNestedSvgProps {
  readonly name: string;
  readonly isQueen?: boolean;
  readonly state?: SwarmMemberState;
  readonly killed?: boolean;
  readonly x: number;
  readonly y: number;
  readonly width?: number;
  readonly height?: number;
}

const BEE_DIMENSIONS: Readonly<Record<SwarmPixelBeeSize, { readonly width: number; readonly height: number }>> = {
  sm: { width: 22, height: 18 },
  md: { width: 36, height: 30 },
  lg: { width: 52, height: 42 },
};

const WORKER_STRIPE_PALETTE: readonly string[] = [
  "#f59e0b", // warm honey
  "#38bdf8", // clear sky
  "#34d399", // mint leaf
  "#fb7185", // soft coral
  "#a78bfa", // lavender
  "#2dd4bf", // seafoam
];

export function getBeeAccentColor(name: string, isQueen = false): string {
  if (isQueen || name === "coordinator") return "#eab308";
  let hash = 2166136261;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const idx = Math.abs(hash) % WORKER_STRIPE_PALETTE.length;
  return WORKER_STRIPE_PALETTE[idx] ?? "#f59e0b";
}

function PixelBeeArt({
  name,
  isQueen = false,
  state = "waiting",
  killed = false,
}: {
  readonly name: string;
  readonly isQueen?: boolean;
  readonly state?: SwarmMemberState;
  readonly killed?: boolean;
}): ReactElement {
  const queen = isQueen || name === "coordinator";
  const effectiveState: SwarmMemberState = killed ? "killed" : state;
  const accent = getBeeAccentColor(name, queen);
  const chitin = "#1f2126";
  const chitinSoft = "#2d3038";
  const honey = "#f59e0b";
  const crownGold = "#eab308";
  const crownHighlight = "#fde047";
  const alertTip =
    effectiveState === "stalled"
      ? "#ff5562"
      : effectiveState === "blocked"
        ? "#f59e0b"
        : chitinSoft;

  const isWorking = effectiveState === "working";
  const isWaiting = effectiveState === "waiting";

  return (
    <g shapeRendering="crispEdges">
      {/* Queen 5-pixel gold crown (`#eab308`) */}
      {queen && (
        <g data-part="queen-crown">
          <rect x="4" y="1" width="1" height="2" fill={crownGold} />
          <rect x="6" y="0" width="1" height="3" fill={crownHighlight} />
          <rect x="8" y="1" width="1" height="2" fill={crownGold} />
          <rect x="4" y="3" width="5" height="1" fill={crownGold} />
        </g>
      )}

      {/* Antennae */}
      {!queen && (
        <g data-part="antennae">
          <rect x="5" y="3" width="1" height="2" fill={chitinSoft} />
          <rect x="4" y="2" width="1" height="1" fill={alertTip} />
          <rect x="7" y="3" width="1" height="2" fill={chitinSoft} />
          <rect x="8" y="2" width="1" height="1" fill={alertTip} />
        </g>
      )}

      {/* Wings: raised & fluttering when working; folded flat when waiting/stopped */}
      {isWorking ? (
        <g className="qj-bee-wings is-flapping" data-part="wings-working">
          <rect x="8" y="1" width="4" height="3" fill="var(--qj-bee-wing, rgba(255,255,255,0.78))" />
          <rect x="9" y="0" width="3" height="1" fill="var(--qj-bee-wing-edge, rgba(255,255,255,0.92))" />
          <rect x="12" y="2" width="3" height="3" fill="var(--qj-bee-wing-back, rgba(255,255,255,0.52))" />
        </g>
      ) : (
        <g className="qj-bee-wings is-folded" data-part="wings-folded">
          <rect x="9" y="4" width="6" height="2" fill="var(--qj-bee-wing, rgba(255,255,255,0.62))" />
          <rect x="10" y="3" width="4" height="1" fill="var(--qj-bee-wing-edge, rgba(255,255,255,0.78))" />
        </g>
      )}

      {/* Tiny pixel `z` when parked on `swarm_wait` (0-token sleep) */}
      {isWaiting && (
        <g className="qj-bee-sleep-z" data-part="sleep-z" fill="var(--qj-text-muted)" opacity="0.72">
          <rect x="15" y="1" width="3" height="1" />
          <rect x="16" y="2" width="1" height="1" />
          <rect x="15" y="3" width="3" height="1" />
        </g>
      )}

      {/* Bee Body (16×11 core silhouette inside 20×16 viewBox) */}
      {/* Head */}
      <rect x="4" y="5" width="4" height="6" fill={chitin} />
      <rect x="3" y="6" width="1" height="4" fill={chitin} />
      {/* Crisp Eye + Highlight */}
      <rect x="5" y="7" width="1" height="2" fill="#fcfcfc" />
      {/* Thorax & Abdomen */}
      <rect x="8" y="5" width="2" height="7" fill={honey} />
      <rect x="10" y="5" width="2" height="7" fill={chitin} />
      {/* Recognizable Worker Identity Stripe */}
      <rect x="12" y="5" width="2" height="7" fill={accent} />
      <rect x="14" y="6" width="2" height="5" fill={chitin} />
      <rect x="16" y="7" width="1" height="3" fill={honey} />
      {/* Stinger */}
      <rect x="17" y="8" width="2" height="1" fill={chitinSoft} />
      {/* Top & Bottom Belly Rounding */}
      <rect x="8" y="4" width="6" height="1" fill={chitin} opacity="0.35" />
      <rect x="8" y="12" width="6" height="1" fill={chitin} />
      {/* Tiny tucked legs */}
      <rect x="7" y="12" width="1" height="2" fill={chitinSoft} />
      <rect x="10" y="13" width="1" height="1" fill={chitinSoft} />
      <rect x="13" y="13" width="1" height="1" fill={chitinSoft} />
    </g>
  );
}

export function SwarmPixelBee({
  name,
  isQueen,
  state = "waiting",
  killed = false,
  size = "sm",
  className,
  title,
}: SwarmPixelBeeProps): ReactElement {
  const queen = isQueen ?? name === "coordinator";
  const effectiveState: SwarmMemberState = killed ? "killed" : state;
  const dims = BEE_DIMENSIONS[size];
  const retired = killed || effectiveState === "killed" || effectiveState === "stopped";

  return (
    <svg
      width={dims.width}
      height={dims.height}
      viewBox="0 0 20 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={title === undefined ? "true" : undefined}
      role={title !== undefined ? "img" : undefined}
      aria-label={title}
      data-bee={name}
      data-queen={queen ? "true" : undefined}
      data-state={effectiveState}
      className={[
        "qj-pixel-bee",
        `size-${size}`,
        `state-${effectiveState}`,
        retired ? "is-retired" : "",
        className ?? "",
      ]
        .filter((s) => s !== "")
        .join(" ")}
    >
      {title !== undefined && <title>{title}</title>}
      <PixelBeeArt name={name} isQueen={queen} state={effectiveState} killed={killed} />
    </svg>
  );
}

/**
 * Nested `<svg>` pixel bee for embedding directly inside the Honeycomb SVG canvas
 * (`SwarmHiveGraphTab.tsx`) with 100% SSR & WebView fidelity.
 */
export function SwarmPixelBeeSvgNode({
  name,
  isQueen,
  state = "waiting",
  killed = false,
  x,
  y,
  width = 22,
  height = 18,
}: SwarmPixelBeeNestedSvgProps): ReactElement {
  const queen = isQueen ?? name === "coordinator";
  const effectiveState: SwarmMemberState = killed ? "killed" : state;
  const retired = killed || effectiveState === "killed" || effectiveState === "stopped";

  return (
    <svg
      x={x}
      y={y}
      width={width}
      height={height}
      viewBox="0 0 20 16"
      overflow="visible"
      className={`qj-pixel-bee state-${effectiveState}${retired ? " is-retired" : ""}`}
    >
      <PixelBeeArt name={name} isQueen={queen} state={effectiveState} killed={killed} />
    </svg>
  );
}

/**
 * Compact cluster of Queen Bee + up to 3 Worker Bees for `SwarmLiveCapsule`
 * and empty/starting banners.
 */
export function SwarmBeeCluster({
  members,
  workingCount = 0,
}: {
  readonly members?: readonly SwarmMemberInfo[];
  readonly workingCount?: number;
}): ReactElement {
  const queen = members?.find((m) => m.role === "coordinator" || m.name === "coordinator");
  const workers = (members ?? [])
    .filter((m) => m.name !== "coordinator" && m.role !== "coordinator" && !m.killed)
    .sort((a, b) => (a.state === "working" ? -1 : 1) - (b.state === "working" ? -1 : 1))
    .slice(0, 3);

  return (
    <span className="qj-swarm-bee-cluster" aria-hidden="true">
      <SwarmPixelBee
        name={queen?.name ?? "coordinator"}
        isQueen
        state={queen?.state ?? (workingCount > 0 ? "working" : "waiting")}
        size="sm"
      />
      {workers.length > 0
        ? workers.map((w) => (
            <SwarmPixelBee
              key={w.name}
              name={w.name}
              state={w.state}
              killed={w.killed}
              size="sm"
            />
          ))
        : workingCount > 0 && (
            <SwarmPixelBee name="worker-1" state="working" size="sm" />
          )}
    </span>
  );
}
