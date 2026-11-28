/**
 * Real ICS Calendar / Meeting connector (`packages/host/src/bot/connectors/calendar-connector.ts`).
 *
 * Parses RFC 5545 `.ics` feeds (remote `https://` / `webcal://` subscriptions or local files),
 * detects same-day schedule conflicts, identifies upcoming meetings within `leadMinutes`,
 * and calculates open focus blocks.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BotCalendarConnectorConfig, BotCalendarEventSummary } from "@qianji/protocol";

export interface CalendarSyncResult {
  todayEvents: BotCalendarEventSummary[];
  conflicts: Array<{ first: string; second: string; overlapLabel: string }>;
  upcomingSoon: BotCalendarEventSummary[];
  freeBlocks: Array<{ startLabel: string; endLabel: string; minutes: number }>;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatHm(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function parseIcsTimestamp(raw: string): { ts: number; allDay: boolean } | null {
  const value = raw.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dateOnly) {
    const dt = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 0, 0, 0, 0);
    return { ts: dt.getTime(), allDay: true };
  }
  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/i.exec(value);
  if (!dateTime) return null;
  const [, yr, mo, dy, hr, mn, sc, z] = dateTime;
  if (z === "Z" || z === "z") {
    return {
      ts: Date.UTC(Number(yr), Number(mo) - 1, Number(dy), Number(hr), Number(mn), Number(sc)),
      allDay: false,
    };
  }
  return {
    ts: new Date(Number(yr), Number(mo) - 1, Number(dy), Number(hr), Number(mn), Number(sc)).getTime(),
    allDay: false,
  };
}

function unescapeIcsText(val: string): string {
  return val.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\").trim();
}

export function parseIcsText(rawIcs: string, nowMs = Date.now()): CalendarSyncResult {
  const unfolded = rawIcs.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);

  const rawEvents: Array<{ uid: string; title: string; startAt: number; endAt: number; location?: string }> = [];
  let inEvent = false;
  let cur: { uid?: string; title?: string; startAt?: number; allDay?: boolean; endAt?: number; location?: string } = {};

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      inEvent = true;
      cur = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (inEvent && cur.startAt !== undefined && cur.title) {
        const endAt = cur.endAt ?? (cur.allDay ? cur.startAt + 86_400_000 : cur.startAt + 3_600_000);
        rawEvents.push({
          uid: cur.uid || `${cur.title}-${cur.startAt}`,
          title: cur.title,
          startAt: cur.startAt,
          endAt: Math.max(endAt, cur.startAt + 60_000),
          ...(cur.location ? { location: cur.location } : {}),
        });
      }
      inEvent = false;
      cur = {};
      continue;
    }
    if (!inEvent) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;
    const prop = line.slice(0, colonIdx).split(";")[0]?.toUpperCase() ?? "";
    const val = line.slice(colonIdx + 1);
    if (prop === "UID") cur.uid = unescapeIcsText(val);
    else if (prop === "SUMMARY") cur.title = unescapeIcsText(val);
    else if (prop === "LOCATION") cur.location = unescapeIcsText(val);
    else if (prop === "DTSTART") {
      const parsed = parseIcsTimestamp(val);
      if (parsed) {
        cur.startAt = parsed.ts;
        cur.allDay = parsed.allDay;
      }
    } else if (prop === "DTEND") {
      const parsed = parseIcsTimestamp(val);
      if (parsed) cur.endAt = parsed.ts;
    }
  }

  const d = new Date(nowMs);
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
  const dayEnd = dayStart + 86_400_000;

  const sortedToday = rawEvents
    .filter((ev) => ev.endAt > dayStart && ev.startAt < dayEnd)
    .sort((a, b) => a.startAt - b.startAt);

  const conflicts: Array<{ first: string; second: string; overlapLabel: string }> = [];
  const todayEvents: BotCalendarEventSummary[] = sortedToday.map((ev) => ({
    id: ev.uid,
    title: ev.title,
    startAt: ev.startAt,
    endAt: ev.endAt,
    timeRangeLabel: `${formatHm(ev.startAt)}–${formatHm(ev.endAt)}`,
    ...(ev.location ? { location: ev.location } : {}),
  }));

  for (let i = 0; i < todayEvents.length; i += 1) {
    for (let j = i + 1; j < todayEvents.length; j += 1) {
      const a = todayEvents[i];
      const b = todayEvents[j];
      if (!a || !b) continue;
      if (b.startAt < a.endAt) {
        b.conflictWith = a.title;
        if (!a.conflictWith) a.conflictWith = b.title;
        conflicts.push({
          first: a.title,
          second: b.title,
          overlapLabel: `${formatHm(Math.max(a.startAt, b.startAt))}–${formatHm(Math.min(a.endAt, b.endAt))}`,
        });
      }
    }
  }

  // Compute available >= 60m focus blocks between 09:00 and 19:00
  const workStart = Math.max(nowMs, dayStart + 9 * 3_600_000);
  const workEnd = dayStart + 19 * 3_600_000;
  const freeBlocks: Array<{ startLabel: string; endLabel: string; minutes: number }> = [];
  if (workStart < workEnd) {
    let cursor = workStart;
    for (const ev of todayEvents) {
      if (ev.endAt <= cursor || ev.startAt >= workEnd) continue;
      if (ev.startAt - cursor >= 60 * 60_000) {
        freeBlocks.push({
          startLabel: formatHm(cursor),
          endLabel: formatHm(ev.startAt),
          minutes: Math.floor((ev.startAt - cursor) / 60_000),
        });
      }
      cursor = Math.max(cursor, ev.endAt);
    }
    if (workEnd - cursor >= 60 * 60_000) {
      freeBlocks.push({
        startLabel: formatHm(cursor),
        endLabel: formatHm(workEnd),
        minutes: Math.floor((workEnd - cursor) / 60_000),
      });
    }
  }

  return { todayEvents, conflicts, upcomingSoon: [], freeBlocks };
}

function readLocalIcsSources(pathOrDir: string): string[] {
  const clean = pathOrDir.trim();
  if (!clean || !existsSync(clean)) return [];
  const st = statSync(clean);
  if (st.isFile()) return [readFileSync(clean, "utf8")];
  if (!st.isDirectory()) return [];
  return readdirSync(clean)
    .filter((name) => /\.ics$/i.test(name))
    .slice(0, 12)
    .map((name) => readFileSync(join(clean, name), "utf8"));
}

export async function syncCalendarEvents(
  config: BotCalendarConnectorConfig,
  nowMs = Date.now(),
): Promise<CalendarSyncResult> {
  const payloads: string[] = [...readLocalIcsSources(config.localIcsPath)];
  const rawUrl = config.icsUrl.trim().replace(/^webcal:\/\//i, "https://");
  if (rawUrl !== "") {
    const res = await fetch(rawUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      throw new Error(`日历订阅拉取失败：HTTP ${res.status}`);
    }
    payloads.push(await res.text());
  }
  if (payloads.length === 0) {
    throw new Error("请填写日历 .ics 订阅链接或本地 .ics 文件路径");
  }

  const parsed = parseIcsText(payloads.join("\n"), nowMs);
  const leadMs = Math.max(1, config.leadMinutes || 15) * 60_000;
  parsed.upcomingSoon = parsed.todayEvents.filter(
    (ev) => ev.startAt >= nowMs - 60_000 && ev.startAt <= nowMs + leadMs,
  );
  return parsed;
}