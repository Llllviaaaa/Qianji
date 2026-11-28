/**
 * Tab 3: Structured Roster `成员` (`src/builtin-plugins/swarm/SwarmMembersTab.tsx`).
 *
 * Sections:
 * 1. `协调者` (`coordinator`)
 * 2. `活跃中` (`working` / `stalled` / `blocked`)
 * 3. `待命休眠` (`waiting` / `stopped` — `0 Token`)
 * 4. `已退役 N` (collapsed by default)
 *
 * Clean flex columns & pills (zero middle-dot chains):
 * `md` Pixel Bee + corner status dot + `@handle` + role pill + status subline +
 * right-aligned tabular `#seq` pill & model badge (hiding default `inherit`).
 */
import { useMemo, useState, type ReactElement } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { SwarmMemberInfo, SwarmSnapshotResult } from "@qianji/protocol";
import { SwarmPixelBee } from "./SwarmPixelBee";
import { MEMBER_ROLE_LABELS } from "./swarmLabels";
import { resolveMemberTaskLabel, selectSwarmMember } from "./swarmStore";

export interface SwarmMembersTabProps {
  readonly snapshot: SwarmSnapshotResult;
}

function formatCompactMemberModel(member: SwarmMemberInfo): string {
  const raw = member.model.trim();
  if (raw === "" || raw === "inherit" || raw === "default") return "";
  const short = raw.split("/").pop() ?? raw;
  return member.effort ? `${short} (${member.effort})` : short;
}

function describeMemberStatusLine(
  snapshot: SwarmSnapshotResult,
  member: SwarmMemberInfo,
): { readonly text: string; readonly tone: "working" | "waitingOn" | "done" | "error" | "idle" } {
  if (member.error) {
    return { text: member.error, tone: "error" };
  }
  if (!member.killed && member.state === "working") {
    return {
      text: member.currentStep || member.currentTool || "正在推理与执行…",
      tone: "working",
    };
  }
  if (!member.killed && (member.state === "stalled" || member.state === "blocked")) {
    return {
      text: member.state === "stalled" ? "响应超时，等待唤醒" : "等待人工或协调者确认",
      tone: "waitingOn",
    };
  }
  if (!member.killed && member.waitingOn !== undefined && member.waitingOn !== "") {
    return { text: `等待 @${member.waitingOn}`, tone: "waitingOn" };
  }
  const taskLabel = resolveMemberTaskLabel(snapshot, member);
  if (typeof member.completedAt === "number" && member.completedAt > 0) {
    return { text: `已完成：${taskLabel}`, tone: "done" };
  }
  return { text: taskLabel, tone: "idle" };
}

function MemberBorderlessRow({
  snapshot,
  member,
}: {
  readonly snapshot: SwarmSnapshotResult;
  readonly member: SwarmMemberInfo;
}): ReactElement {
  const isQueen = member.role === "coordinator" || member.name === "coordinator";
  const statusLine = describeMemberStatusLine(snapshot, member);
  const modelText = formatCompactMemberModel(member);
  const hasSeq = member.lastPostSeq !== undefined && member.lastPostSeq > 0;

  const dotClass = member.killed
    ? "is-killed"
    : member.state === "working"
      ? "is-working"
      : member.state === "stalled" || member.state === "blocked"
        ? "is-attention"
        : "is-waiting";

  return (
    <button
      type="button"
      className="qj-swarm-member-row"
      data-testid={`swarm-member-row-${member.name}`}
      onClick={() => selectSwarmMember(member.name)}
    >
      <span className="qj-swarm-bee-avatar">
        <SwarmPixelBee
          name={member.name}
          isQueen={isQueen}
          state={member.state}
          killed={member.killed}
          size="md"
        />
        <span className={`qj-swarm-corner-dot ${dotClass}`} aria-hidden="true" />
      </span>

      <span className="qj-swarm-member-main">
        <span className="qj-swarm-member-topline">
          <strong className="qj-swarm-member-handle">@{member.name}</strong>
          <span className="qj-swarm-member-role">{MEMBER_ROLE_LABELS[member.role]}</span>
          {member.changedFileCount > 0 && (
            <span className="qj-swarm-dirty-pill">+{member.changedFileCount} 变更</span>
          )}
        </span>
        <span
          className={`qj-swarm-member-subline tone-${statusLine.tone}${statusLine.tone === "working" ? " shimmer-text" : ""}`}
        >
          {statusLine.text}
        </span>
      </span>

      {(modelText !== "" || hasSeq) && (
        <span className="qj-swarm-member-right">
          {modelText !== "" && <span className="qj-swarm-member-model-badge">{modelText}</span>}
          {hasSeq && <span className="qj-swarm-member-seq-tag">#{member.lastPostSeq}</span>}
        </span>
      )}
    </button>
  );
}

export function SwarmMembersTab({ snapshot }: SwarmMembersTabProps): ReactElement {
  const [retiredExpanded, setRetiredExpanded] = useState(false);

  const { coordinators, activeWorkers, parkedWorkers, retiredWorkers } = useMemo(() => {
    const coord: SwarmMemberInfo[] = [];
    const active: SwarmMemberInfo[] = [];
    const parked: SwarmMemberInfo[] = [];
    const retired: SwarmMemberInfo[] = [];

    for (const m of snapshot.members) {
      if (m.killed) {
        retired.push(m);
      } else if (m.role === "coordinator" || m.name === "coordinator") {
        coord.push(m);
      } else if (m.state === "working" || m.state === "stalled" || m.state === "blocked") {
        active.push(m);
      } else {
        parked.push(m);
      }
    }
    return {
      coordinators: coord,
      activeWorkers: active,
      parkedWorkers: parked,
      retiredWorkers: retired,
    };
  }, [snapshot.members]);

  return (
    <div className="qj-swarm-members-tab" data-testid="swarm-members-tab">
      {coordinators.length > 0 && (
        <section className="qj-swarm-member-group">
          <header className="qj-swarm-group-head">
            <span>协调者</span>
          </header>
          <div className="qj-swarm-member-list">
            {coordinators.map((m) => (
              <MemberBorderlessRow key={m.name} snapshot={snapshot} member={m} />
            ))}
          </div>
        </section>
      )}

      {activeWorkers.length > 0 && (
        <section className="qj-swarm-member-group">
          <header className="qj-swarm-group-head">
            <span>活跃中</span>
            <span className="qj-swarm-group-note">{activeWorkers.length}</span>
          </header>
          <div className="qj-swarm-member-list">
            {activeWorkers.map((m) => (
              <MemberBorderlessRow key={m.name} snapshot={snapshot} member={m} />
            ))}
          </div>
        </section>
      )}

      {parkedWorkers.length > 0 && (
        <section className="qj-swarm-member-group">
          <header className="qj-swarm-group-head">
            <span>待命休眠</span>
            <span className="qj-swarm-group-note">0 Token</span>
          </header>
          <div className="qj-swarm-member-list">
            {parkedWorkers.map((m) => (
              <MemberBorderlessRow key={m.name} snapshot={snapshot} member={m} />
            ))}
          </div>
        </section>
      )}

      {retiredWorkers.length > 0 && (
        <section className="qj-swarm-member-group is-retired-group">
          <button
            type="button"
            className="qj-swarm-group-toggle"
            aria-expanded={retiredExpanded}
            onClick={() => setRetiredExpanded((v) => !v)}
          >
            {retiredExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>已退役 {retiredWorkers.length}</span>
          </button>
          {retiredExpanded && (
            <div className="qj-swarm-member-list">
              {retiredWorkers.map((m) => (
                <MemberBorderlessRow key={m.name} snapshot={snapshot} member={m} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
