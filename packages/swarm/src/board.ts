/**
 * Backtick-safe `@mention` parser, `#channel` registry, and zero-race
 * `swarm_wait(since)` doorbell engine (`@qianji/swarm`).
 */
import type {
  SwarmBoardMessage,
  SwarmBoardReadResult,
  SwarmChannelInfo,
  SwarmMemberInfo,
} from "@qianji/protocol";

export const SWARM_MAIN_CHANNEL = "main";

const FENCED_CODE_RE = /(`{3,}|~{3,})[\s\S]*?(?:\1|$)/g;
const INLINE_CODE_RE = /(`+)([^`]*?)\1/g;
const CHANNEL_MENTION_RE = /(?:^|[^a-zA-Z0-9_.-])@#([a-zA-Z0-9][a-zA-Z0-9_-]{0,31})(?![a-zA-Z0-9_/-])/g;
const USER_MENTION_RE = /(?:^|[^a-zA-Z0-9_.-])@([a-zA-Z0-9][a-zA-Z0-9_-]{0,23})(?![a-zA-Z0-9_/-])/g;
const DONE_TAG_RE = /\[done\]/i;
const STALL_TAG_RE = /\[stall\]/i;
const VALID_MEMBER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const VALID_CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const GROUP_SUFFIX_RE = /^([a-z0-9][a-z0-9_-]*?)-\d+$/;

export interface ParsedBoardMentions {
  mentions: string[];
  channelMentions: string[];
  mentionAll: boolean;
  isDone: boolean;
  isStall: boolean;
}

/**
 * Strip fenced Markdown code blocks and inline backtick spans before scanning
 * for `@mentions` so prose examples like `` `@coordinator` `` never false-wake members.
 */
export function stripCodeForMentions(text: string): string {
  return text.replace(FENCED_CODE_RE, " ").replace(INLINE_CODE_RE, " ");
}

export function parseBoardMentions(text: string): ParsedBoardMentions {
  const stripped = stripCodeForMentions(text);
  const channelSet = new Set<string>();
  const mentionSet = new Set<string>();
  let mentionAll = false;

  for (const match of stripped.matchAll(CHANNEL_MENTION_RE)) {
    const ch = match[1]?.toLowerCase();
    if (ch !== undefined && ch !== "") channelSet.add(ch);
  }

  for (const match of stripped.matchAll(USER_MENTION_RE)) {
    const token = match[1]?.toLowerCase();
    if (token === undefined || token === "") continue;
    if (token === "all") {
      mentionAll = true;
    } else {
      mentionSet.add(token);
    }
  }

  return {
    mentions: [...mentionSet],
    channelMentions: [...channelSet],
    mentionAll,
    isDone: DONE_TAG_RE.test(stripped),
    isStall: STALL_TAG_RE.test(stripped),
  };
}

export function normalizeChannelName(raw?: string): string {
  const cleaned = (raw ?? "").trim().replace(/^@?#/, "").toLowerCase();
  if (cleaned === "") return SWARM_MAIN_CHANNEL;
  if (!VALID_CHANNEL_NAME_RE.test(cleaned)) {
    throw new Error(`Invalid swarm channel name "${raw ?? ""}". Use 1-32 lowercase [a-z0-9_-] characters.`);
  }
  return cleaned;
}

export function validateWorkerName(raw: string): string {
  const cleaned = raw.trim().toLowerCase();
  if (!VALID_MEMBER_NAME_RE.test(cleaned)) {
    throw new Error(`Invalid worker name "${raw}". Use 1-24 lowercase [a-z0-9_-] starting with a letter or digit.`);
  }
  if (cleaned === "all" || cleaned === "coordinator" || cleaned.startsWith("coordinator-")) {
    throw new Error(`Worker name "${cleaned}" is reserved.`);
  }
  return cleaned;
}

export function deriveGroupPrefix(name: string): string | undefined {
  const match = GROUP_SUFFIX_RE.exec(name);
  return match?.[1];
}

export function doesMessageWakeMember(
  message: SwarmBoardMessage,
  member: Pick<SwarmMemberInfo, "name" | "groupPrefix" | "channels">,
  mentionsOnly: boolean,
): boolean {
  if (message.sender === member.name) return false;
  const directHit =
    message.mentionAll
    || message.mentions.includes(member.name)
    || (member.groupPrefix !== undefined && message.mentions.includes(member.groupPrefix))
    || message.channelMentions.some((ch) => member.channels.includes(ch));
  if (mentionsOnly) return directHit;
  return directHit || message.channel === SWARM_MAIN_CHANNEL || member.channels.includes(message.channel);
}

interface BoardWaiter {
  member: Pick<SwarmMemberInfo, "name" | "groupPrefix" | "channels">;
  since: number;
  mentionsOnly: boolean;
  wake: (aborted: boolean) => void;
}

export class SwarmBoardEngine {
  readonly swarmId: string;
  private readonly messages: SwarmBoardMessage[] = [];
  private readonly channels = new Map<string, SwarmChannelInfo>();
  private readonly waiters = new Set<BoardWaiter>();
  private seq = 0;

  constructor(
    swarmId: string,
    createdAt = Date.now(),
    initial?: { messages?: SwarmBoardMessage[]; channels?: SwarmChannelInfo[]; headSeq?: number },
  ) {
    this.swarmId = swarmId;
    if (initial?.channels !== undefined && initial.channels.length > 0) {
      for (const ch of initial.channels) {
        this.channels.set(ch.name, { ...ch, subscriberNames: [...ch.subscriberNames] });
      }
    }
    if (!this.channels.has(SWARM_MAIN_CHANNEL)) {
      this.channels.set(SWARM_MAIN_CHANNEL, {
        name: SWARM_MAIN_CHANNEL,
        topic: "Shared swarm coordination board",
        createdBy: "coordinator",
        archived: false,
        subscriberNames: ["coordinator"],
        createdAt,
      });
    }
    if (initial?.messages !== undefined) {
      for (const msg of initial.messages) {
        this.messages.push({ ...msg, mentions: [...msg.mentions], channelMentions: [...msg.channelMentions] });
        if (msg.seq > this.seq) this.seq = msg.seq;
      }
    }
    if (initial?.headSeq !== undefined && initial.headSeq > this.seq) {
      this.seq = initial.headSeq;
    }
  }

  get headSeq(): number {
    return this.seq;
  }

  listChannels(): SwarmChannelInfo[] {
    return [...this.channels.values()].map((ch) => ({
      ...ch,
      subscriberNames: [...ch.subscriberNames],
    }));
  }

  ensureChannel(name: string, createdBy: string, topic = "", now = Date.now()): SwarmChannelInfo {
    const normalized = normalizeChannelName(name);
    const existing = this.channels.get(normalized);
    if (existing !== undefined) {
      if (topic !== "" && existing.topic === "") existing.topic = topic;
      existing.archived = false;
      return existing;
    }
    const created: SwarmChannelInfo = {
      name: normalized,
      topic: topic || `#${normalized} coordination channel`,
      createdBy,
      archived: false,
      subscriberNames: [createdBy],
      createdAt: now,
    };
    this.channels.set(normalized, created);
    return created;
  }

  subscribeMember(channelName: string, memberName: string, createdBy = memberName, now = Date.now()): SwarmChannelInfo {
    const ch = this.ensureChannel(channelName, createdBy, "", now);
    if (!ch.subscriberNames.includes(memberName)) {
      ch.subscriberNames.push(memberName);
    }
    return ch;
  }

  unsubscribeMember(channelName: string, memberName: string): SwarmChannelInfo | undefined {
    const normalized = normalizeChannelName(channelName);
    if (normalized === SWARM_MAIN_CHANNEL) return this.channels.get(SWARM_MAIN_CHANNEL);
    const ch = this.channels.get(normalized);
    if (ch !== undefined) {
      ch.subscriberNames = ch.subscriberNames.filter((item) => item !== memberName);
    }
    return ch;
  }

  archiveChannel(channelName: string): SwarmChannelInfo | undefined {
    const normalized = normalizeChannelName(channelName);
    if (normalized === SWARM_MAIN_CHANNEL) {
      throw new Error("The #main channel cannot be archived.");
    }
    const ch = this.channels.get(normalized);
    if (ch !== undefined) ch.archived = true;
    return ch;
  }

  append(input: {
    sender: string;
    text: string;
    channel?: string;
    replyToSeq?: number;
    now?: number;
  }): SwarmBoardMessage {
    const now = input.now ?? Date.now();
    const channel = normalizeChannelName(input.channel);
    this.ensureChannel(channel, input.sender, "", now);
    const parsed = parseBoardMentions(input.text);
    for (const mentionedChannel of parsed.channelMentions) {
      this.ensureChannel(mentionedChannel, input.sender, "", now);
    }
    this.seq += 1;
    const message: SwarmBoardMessage = {
      seq: this.seq,
      swarmId: this.swarmId,
      channel,
      sender: input.sender,
      text: input.text,
      mentions: parsed.mentions,
      channelMentions: parsed.channelMentions,
      mentionAll: parsed.mentionAll,
      isDone: parsed.isDone,
      isStall: parsed.isStall,
      ...(input.replyToSeq === undefined ? {} : { replyToSeq: input.replyToSeq }),
      createdAt: now,
    };
    this.messages.push(message);

    for (const waiter of [...this.waiters]) {
      if (doesMessageWakeMember(message, waiter.member, waiter.mentionsOnly)) {
        waiter.wake(false);
      }
    }
    return message;
  }

  read(options: {
    channel?: string;
    since?: number;
    seqs?: number[];
    limit?: number;
  } = {}): SwarmBoardReadResult {
    if (options.seqs !== undefined && options.seqs.length > 0) {
      const wanted = new Set(options.seqs);
      const picked = this.messages.filter((m) => wanted.has(m.seq));
      return { messages: picked.map((m) => ({ ...m })), headSeq: this.seq };
    }
    const channelFilter = options.channel !== undefined && options.channel.trim() !== ""
      ? normalizeChannelName(options.channel)
      : undefined;
    const filtered = channelFilter === undefined
      ? this.messages
      : this.messages.filter((m) => m.channel === channelFilter);

    if (options.since !== undefined) {
      const sinceSeq = options.since;
      const cap = Math.max(1, Math.min(options.limit ?? 100, 500));
      const slice = filtered.filter((m) => m.seq > sinceSeq).slice(0, cap);
      return { messages: slice.map((m) => ({ ...m })), headSeq: this.seq };
    }

    const cap = Math.max(1, Math.min(options.limit ?? 20, 500));
    const recent = filtered.slice(-cap);
    return { messages: recent.map((m) => ({ ...m })), headSeq: this.seq };
  }

  allMessages(): SwarmBoardMessage[] {
    return this.messages.map((m) => ({ ...m }));
  }

  messagesSince(since: number): SwarmBoardMessage[] {
    return this.messages.filter((m) => m.seq > since).map((m) => ({ ...m }));
  }

  hasUnreadWakeFor(
    member: Pick<SwarmMemberInfo, "name" | "groupPrefix" | "channels" | "lastReadSeq">,
    since = member.lastReadSeq,
  ): boolean {
    return this.messages.some((m) => m.seq > since && doesMessageWakeMember(m, member, true));
  }

  async waitFor(options: {
    member: Pick<SwarmMemberInfo, "name" | "groupPrefix" | "channels">;
    since: number;
    mentionsOnly?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
    onPark?: (since: number) => void;
  }): Promise<{ messages: SwarmBoardMessage[]; headSeq: number; timedOut: boolean; aborted: boolean }> {
    const mentionsOnly = options.mentionsOnly !== false;
    const immediateTrigger = this.messages.some(
      (m) => m.seq > options.since && doesMessageWakeMember(m, options.member, mentionsOnly),
    );
    if (immediateTrigger) {
      return {
        messages: this.messagesSince(options.since),
        headSeq: this.seq,
        timedOut: false,
        aborted: false,
      };
    }
    if (options.signal?.aborted === true) {
      return { messages: [], headSeq: this.seq, timedOut: false, aborted: true };
    }

    options.onPark?.(options.since);

    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (timedOut: boolean, aborted: boolean) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        this.waiters.delete(waiter);
        options.signal?.removeEventListener("abort", onAbort);
        resolve({
          messages: timedOut || aborted ? [] : this.messagesSince(options.since),
          headSeq: this.seq,
          timedOut,
          aborted,
        });
      };

      const onAbort = () => finish(false, true);
      const waiter: BoardWaiter = {
        member: options.member,
        since: options.since,
        mentionsOnly,
        wake: (aborted) => finish(false, aborted),
      };

      this.waiters.add(waiter);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
        timer = setTimeout(() => finish(true, false), options.timeoutMs);
      }
    });
  }

  cancelWaitersForMember(memberName: string): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.member.name === memberName) {
        waiter.wake(true);
      }
    }
  }

  cancelAllWaiters(): void {
    for (const waiter of [...this.waiters]) {
      waiter.wake(true);
    }
  }
}
