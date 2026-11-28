/**
 * Individual Timeline Row for `SwarmMessageBoard` (`src/builtin-plugins/swarm/SwarmBoardMessageRow.tsx`).
 *
 * Extracted to keep every module well below 350 physical lines:
 * - Left 1px connected timeline spine + sender Pixel Bee node
 * - Header: `@sender`, recipient pill, `[done]` emerald `已完成` tag, `[stall]` amber tag + `唤醒`, tabular `#seq` & clock
 * - Clickable `#seq` reference jump pills + `<Markdown>` body + smart auto-collapse (`> 6` lines or `> 260` chars)
 */
import type { ReactElement } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Markdown } from "@qianji/client-primitives";
import type { SwarmBoardMessage, SwarmMemberInfo } from "@qianji/protocol";
import { SwarmPixelBee } from "./SwarmPixelBee";
import {
  extractBoardSeqRefs,
  isMilestoneDoneMessage,
  isMilestoneStallMessage,
  prepareBoardMarkdownBody,
} from "./swarmLabels";
import { selectSwarmMember } from "./swarmStore";

export interface SwarmBoardMessageRowProps {
  readonly msg: SwarmBoardMessage;
  readonly cwd: string;
  readonly isHighlighted: boolean;
  readonly isExpanded: boolean;
  readonly isLast: boolean;
  readonly senderMember: SwarmMemberInfo | undefined;
  readonly onToggleExpand: (seq: number) => void;
  readonly onSeqJump: (seq: number) => void;
  readonly onReplySelect: (msg: SwarmBoardMessage) => void;
  readonly onWakeMember: (targetName: string) => void;
}

function formatBoardClock(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  try {
    return new Date(ts).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return "";
  }
}

export function isLongBoardMessage(text: string): boolean {
  if (text.length > 260) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") {
      lines += 1;
      if (lines > 6) return true;
    }
  }
  return false;
}

export function SwarmBoardMessageRow({
  msg,
  cwd,
  isHighlighted,
  isExpanded,
  isLast,
  senderMember,
  onToggleExpand,
  onSeqJump,
  onReplySelect,
  onWakeMember,
}: SwarmBoardMessageRowProps): ReactElement {
  const markdownBody = prepareBoardMarkdownBody(msg.text, msg.mentions, msg.mentionAll);
  const seqRefs = extractBoardSeqRefs(markdownBody, msg.seq);
  if (msg.replyToSeq !== undefined && msg.replyToSeq > 0 && !seqRefs.includes(msg.replyToSeq)) {
    seqRefs.unshift(msg.replyToSeq);
  }
  const recipientLabel = msg.mentionAll
    ? "@all"
    : msg.mentions.length > 0
      ? msg.mentions.map((m) => `@${m}`).join(" ")
      : "";
  const clampable = isLongBoardMessage(markdownBody);
  const clock = formatBoardClock(msg.createdAt);
  const milestoneDone = isMilestoneDoneMessage(msg);
  const milestoneStall = isMilestoneStallMessage(msg);
  const stallTarget =
    msg.mentions[0] ?? (msg.sender !== "monitor" && msg.sender !== "user" ? msg.sender : "");

  return (
    <article
      id={`swarm-msg-seq-${msg.seq}`}
      className={`qj-swarm-msg-row${isHighlighted ? " is-highlighted" : ""}${milestoneDone ? " is-done-row" : ""}`}
      data-seq={msg.seq}
      data-highlighted={isHighlighted ? "true" : undefined}
    >
      <div className="qj-swarm-msg-rail" aria-hidden="true">
        <span className={`qj-swarm-msg-node${milestoneDone ? " is-done" : milestoneStall ? " is-stall" : ""}`}>
          <SwarmPixelBee
            name={msg.sender}
            isQueen={msg.sender === "coordinator" || senderMember?.role === "coordinator"}
            state={senderMember?.state ?? "waiting"}
            killed={senderMember?.killed ?? false}
            size="sm"
          />
        </span>
        {!isLast && <span className="qj-swarm-msg-spine" />}
      </div>

      <div className="qj-swarm-msg-col">
        <div className="qj-swarm-msg-head">
          {senderMember !== undefined ? (
            <button type="button" className="qj-swarm-sender-btn" onClick={() => selectSwarmMember(msg.sender)}>
              @{msg.sender}
            </button>
          ) : (
            <span className="qj-swarm-sender-btn is-static">@{msg.sender}</span>
          )}

          {recipientLabel !== "" && (
            <span className="qj-swarm-recipient-pill">{recipientLabel}</span>
          )}

          {milestoneDone && (
            <span className="qj-swarm-milestone-tag is-done" data-testid={`swarm-msg-done-${msg.seq}`}>
              已完成
            </span>
          )}

          {milestoneStall && (
            <>
              <span className="qj-swarm-milestone-tag is-stall">超时告警</span>
              {stallTarget !== "" && (
                <button
                  type="button"
                  className="qj-swarm-inline-action"
                  data-testid={`swarm-msg-wake-${msg.seq}`}
                  onClick={() => onWakeMember(stallTarget)}
                >
                  唤醒
                </button>
              )}
            </>
          )}

          <button
            type="button"
            className="qj-swarm-msg-meta"
            title={`定位或回复 #${msg.seq}`}
            onClick={() => onReplySelect(msg)}
          >
            <span className="qj-swarm-seq-num">#{msg.seq}</span>
            {clock !== "" && <time>{clock}</time>}
          </button>
        </div>

        {seqRefs.length > 0 && (
          <div className="qj-swarm-msg-refs">
            {seqRefs.map((refSeq) => (
              <button
                key={refSeq}
                type="button"
                className="qj-swarm-seq-pill"
                data-testid={`swarm-seq-jump-${refSeq}`}
                onClick={() => onSeqJump(refSeq)}
              >
                #{refSeq}
              </button>
            ))}
          </div>
        )}

        <div className={`qj-swarm-msg-body-wrap${clampable && !isExpanded ? " is-collapsed" : ""}`}>
          <Markdown content={markdownBody} cwd={cwd} className="qj-swarm-msg-markdown" />
        </div>

        {clampable && (
          <button
            type="button"
            className="qj-swarm-msg-expand-btn"
            data-testid={`swarm-msg-expand-${msg.seq}`}
            aria-expanded={isExpanded}
            onClick={() => onToggleExpand(msg.seq)}
          >
            {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            <span>{isExpanded ? "收起" : "展开完整内容"}</span>
          </button>
        )}
      </div>
    </article>
  );
}
