/**
 * MCP-Backed Inbox & Calendar Synchronization Engine (`packages/host/src/bot/connectors/mcp-sync.ts`).
 *
 * Bridges standard MCP servers (`@googleworkspace/cli` `gws mcp`, Google's official
 * `gmailmcp.googleapis.com` / `calendarmcp.googleapis.com`, Composio, or custom MCP servers)
 * directly into Qianji's `inboxItems` and `awareness.todayEvents` during Heartbeat patrols
 * and manual sync triggers.
 */
import type { Mcp, McpTool, McpToolResult } from "@qianji/mcp";
import type { BotCalendarEventSummary } from "@qianji/protocol";
import type { CalendarSyncResult } from "./calendar-connector.ts";
import type { FetchedEmail } from "./email-connector.ts";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtHm(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function parseMcpJsonPayload(result: McpToolResult): unknown {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  for (const block of result.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") {
      const trimmed = block.text.trim();
      if (!trimmed) continue;
      try {
        return JSON.parse(trimmed);
      } catch {
        const jsonMatch = /(\{[\s\S]*\}|\[[\s\S]*\])/.exec(trimmed);
        if (jsonMatch?.[1]) {
          try {
            return JSON.parse(jsonMatch[1]);
          } catch {
            // Continue scanning blocks
          }
        }
      }
    }
  }
  return undefined;
}

function schemaHasProperty(tool: McpTool, propName: string): boolean {
  const props = tool.inputSchema?.properties;
  return Boolean(props && typeof props === "object" && propName in (props as Record<string, unknown>));
}

function decodeBase64UrlUtf8(raw: string): string {
  try {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(normalized, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function extractGmailPayloadText(payload: Record<string, unknown> | undefined): string {
  if (!payload) return "";
  const mimeType = typeof payload.mimeType === "string" ? payload.mimeType : "";
  const body = payload.body as { data?: string } | undefined;
  if (mimeType === "text/plain" && typeof body?.data === "string") {
    return decodeBase64UrlUtf8(body.data).trim();
  }
  const parts = Array.isArray(payload.parts) ? (payload.parts as Array<Record<string, unknown>>) : [];
  for (const part of parts) {
    if (part.mimeType === "text/plain") {
      const text = extractGmailPayloadText(part);
      if (text) return text;
    }
  }
  for (const part of parts) {
    const nested = extractGmailPayloadText(part);
    if (nested) return nested;
  }
  if (typeof body?.data === "string") {
    return decodeBase64UrlUtf8(body.data)
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

function headerValue(headers: unknown, targetName: string): string {
  if (!Array.isArray(headers)) return "";
  const lower = targetName.toLowerCase();
  for (const h of headers) {
    if (h && typeof h === "object") {
      const rec = h as { name?: string; value?: string };
      if (rec.name?.toLowerCase() === lower && typeof rec.value === "string") {
        return rec.value.trim();
      }
    }
  }
  return "";
}

function extractAddressFromHeader(raw: string): string {
  const angle = /<([^>]+)>/.exec(raw);
  if (angle?.[1]) return angle[1].trim();
  const bare = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/.exec(raw);
  return bare?.[1] ?? raw.trim();
}

function normalizeMessageRecord(raw: Record<string, unknown>, idx: number): FetchedEmail | null {
  const uid = String(raw.id ?? raw.messageId ?? raw.uid ?? raw.threadId ?? `mcp-${idx}`);
  const payload = raw.payload && typeof raw.payload === "object" ? (raw.payload as Record<string, unknown>) : undefined;
  const headers = payload?.headers ?? raw.headers;

  const from =
    (typeof raw.from === "string" && raw.from) ||
    (typeof raw.sender === "string" && raw.sender) ||
    headerValue(headers, "From") ||
    "未知发件人";
  const replyHdr =
    (typeof raw.replyTo === "string" && raw.replyTo) ||
    headerValue(headers, "Reply-To") ||
    from;
  const subject =
    (typeof raw.subject === "string" && raw.subject) ||
    headerValue(headers, "Subject") ||
    "(无主题)";
  const dateStr =
    (typeof raw.date === "string" && raw.date) ||
    (typeof raw.receivedAt === "string" && raw.receivedAt) ||
    headerValue(headers, "Date") ||
    "";
  const internalDateMs =
    typeof raw.internalDate === "string" || typeof raw.internalDate === "number"
      ? Number(raw.internalDate)
      : NaN;
  const parsedDate = Number.isFinite(internalDateMs) && internalDateMs > 0
    ? internalDateMs
    : dateStr
      ? Date.parse(dateStr)
      : NaN;
  const receivedAt = Number.isFinite(parsedDate) ? parsedDate : Date.now();

  const bodyText =
    (typeof raw.body === "string" && raw.body.trim()) ||
    (typeof raw.text === "string" && raw.text.trim()) ||
    (typeof raw.plainText === "string" && raw.plainText.trim()) ||
    extractGmailPayloadText(payload) ||
    (typeof raw.snippet === "string" ? raw.snippet.trim() : "") ||
    (typeof raw.preview === "string" ? raw.preview.trim() : "");

  return {
    uid,
    sender: from,
    replyTo: extractAddressFromHeader(replyHdr),
    subject,
    dateHeader: dateStr,
    preview: bodyText.slice(0, 180) || "(正文为空)",
    fullBody: bodyText.slice(0, 3500),
    receivedAt,
  };
}

function extractArrayCandidates(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) {
    return data.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === "object"));
  }
  if (data && typeof data === "object") {
    const rec = data as Record<string, unknown>;
    for (const key of ["messages", "emails", "items", "data", "results", "threads"]) {
      if (Array.isArray(rec[key])) {
        return (rec[key] as unknown[]).filter((x): x is Record<string, unknown> => Boolean(x && typeof x === "object"));
      }
      if (rec[key] && typeof rec[key] === "object") {
        const inner = extractArrayCandidates(rec[key]);
        if (inner.length > 0) return inner;
      }
    }
  }
  return [];
}

function buildListMailArgs(tool: McpTool, limit: number): Record<string, unknown> {
  if (schemaHasProperty(tool, "params")) {
    return { params: { userId: "me", maxResults: limit, q: "in:inbox" } };
  }
  const args: Record<string, unknown> = {};
  if (schemaHasProperty(tool, "userId")) args.userId = "me";
  if (schemaHasProperty(tool, "maxResults")) args.maxResults = limit;
  else if (schemaHasProperty(tool, "max_results")) args.max_results = limit;
  else if (schemaHasProperty(tool, "limit")) args.limit = limit;
  if (schemaHasProperty(tool, "q")) args.q = "in:inbox";
  else if (schemaHasProperty(tool, "query")) args.query = "in:inbox";
  return args;
}

function buildGetMailArgs(tool: McpTool, messageId: string): Record<string, unknown> {
  if (schemaHasProperty(tool, "params")) {
    return { params: { userId: "me", id: messageId, format: "full" } };
  }
  const args: Record<string, unknown> = {};
  if (schemaHasProperty(tool, "userId")) args.userId = "me";
  if (schemaHasProperty(tool, "messageId")) args.messageId = messageId;
  else if (schemaHasProperty(tool, "message_id")) args.message_id = messageId;
  else args.id = messageId;
  if (schemaHasProperty(tool, "format")) args.format = "full";
  return args;
}

export async function syncGmailViaMcp(
  mcp: Mcp,
  serverId = "preset-mcp-gmail",
  limit = 8,
): Promise<FetchedEmail[]> {
  const status = mcp.statuses().find((s) => s.config.id === serverId);
  if (!status || !status.connected) {
    throw new Error(status?.error || "Gmail MCP 服务器尚未连接，请先完成授权或检查服务状态");
  }

  const tools = await mcp.listServerTools(serverId);
  const listTool =
    tools.find((t) => /^gmail_users_messages_list$/i.test(t.name)) ??
    tools.find((t) => /^(?:gmail_)?(?:list|search|fetch|query)_(?:gmail_)?(?:messages|emails)$/i.test(t.name)) ??
    tools.find((t) => /messages_list|list_messages|search_emails|fetch_emails|gmail_fetch/i.test(t.name));

  if (!listTool) {
    throw new Error(`Gmail MCP 服务已连接，但未暴露邮件列表工具（当前共 ${tools.length} 个工具）`);
  }

  const getTool =
    tools.find((t) => /^gmail_users_messages_get$/i.test(t.name)) ??
    tools.find((t) => /^(?:gmail_)?(?:get|read)_(?:gmail_)?(?:message|email)$/i.test(t.name)) ??
    tools.find((t) => /messages_get|get_message|read_email/i.test(t.name));

  const listResult = await mcp.callServerTool(serverId, listTool.name, buildListMailArgs(listTool, limit));
  if (listResult.isError) {
    const errText = listResult.content?.map((c) => (typeof c.text === "string" ? c.text : "")).join(" ").trim();
    throw new Error(`Gmail MCP 拉取列表失败：${errText || "tool error"}`);
  }

  const rawList = extractArrayCandidates(parseMcpJsonPayload(listResult)).slice(0, limit);
  if (rawList.length === 0) return [];

  const out: FetchedEmail[] = [];
  for (let i = 0; i < rawList.length; i += 1) {
    const stub = rawList[i];
    if (!stub) continue;
    const hasRichFields = Boolean(stub.subject || stub.from || stub.sender || stub.payload || stub.snippet);
    if (!hasRichFields && getTool && (typeof stub.id === "string" || typeof stub.messageId === "string")) {
      const msgId = String(stub.id ?? stub.messageId);
      const detailRes = await mcp.callServerTool(serverId, getTool.name, buildGetMailArgs(getTool, msgId)).catch(() => null);
      const detailJson = detailRes && !detailRes.isError ? parseMcpJsonPayload(detailRes) : undefined;
      if (detailJson && typeof detailJson === "object" && !Array.isArray(detailJson)) {
        const normalized = normalizeMessageRecord(detailJson as Record<string, unknown>, i);
        if (normalized) {
          out.push(normalized);
          continue;
        }
      }
    }
    const normalized = normalizeMessageRecord(stub, i);
    if (normalized) out.push(normalized);
  }
  return out;
}

export async function syncCalendarViaMcp(
  mcp: Mcp,
  serverId = "preset-mcp-calendar",
  nowMs = Date.now(),
  leadMinutes = 15,
): Promise<CalendarSyncResult> {
  const status = mcp.statuses().find((s) => s.config.id === serverId);
  if (!status || !status.connected) {
    throw new Error(status?.error || "Google 日历 MCP 服务器尚未连接");
  }

  const tools = await mcp.listServerTools(serverId);
  const listTool =
    tools.find((t) => /^calendar_events_list$/i.test(t.name)) ??
    tools.find((t) => /^(?:google_)?(?:calendar_)?list_(?:calendar_)?events$/i.test(t.name)) ??
    tools.find((t) => /events_list|list_events|find_event/i.test(t.name));

  if (!listTool) {
    throw new Error(`日历 MCP 服务已连接，但未发现日程查询工具（当前共 ${tools.length} 个工具）`);
  }

  const now = new Date(nowMs);
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  const timeMin = dayStart.toISOString();
  const timeMax = dayEnd.toISOString();

  const args: Record<string, unknown> = schemaHasProperty(listTool, "params")
    ? { params: { calendarId: "primary", timeMin, timeMax, singleEvents: true, orderBy: "startTime" } }
    : {
        ...(schemaHasProperty(listTool, "calendarId") ? { calendarId: "primary" } : {}),
        ...(schemaHasProperty(listTool, "calendar_id") ? { calendar_id: "primary" } : {}),
        ...(schemaHasProperty(listTool, "timeMin") ? { timeMin } : {}),
        ...(schemaHasProperty(listTool, "time_min") ? { time_min: timeMin } : {}),
        ...(schemaHasProperty(listTool, "timeMax") ? { timeMax } : {}),
        ...(schemaHasProperty(listTool, "time_max") ? { time_max: timeMax } : {}),
      };

  const res = await mcp.callServerTool(serverId, listTool.name, args);
  if (res.isError) {
    const errText = res.content?.map((c) => (typeof c.text === "string" ? c.text : "")).join(" ").trim();
    throw new Error(`Google 日历 MCP 同步失败：${errText || "tool error"}`);
  }

  const rawItems = extractArrayCandidates(parseMcpJsonPayload(res));
  const rawEvents = rawItems
    .map((ev, idx) => {
      const startObj = ev.start && typeof ev.start === "object" ? (ev.start as Record<string, unknown>) : undefined;
      const endObj = ev.end && typeof ev.end === "object" ? (ev.end as Record<string, unknown>) : undefined;
      const startRaw = String(startObj?.dateTime ?? startObj?.date ?? ev.startTime ?? ev.start ?? "");
      const endRaw = String(endObj?.dateTime ?? endObj?.date ?? ev.endTime ?? ev.end ?? "");
      const startAt = Date.parse(startRaw);
      const endAt = Number.isFinite(Date.parse(endRaw)) ? Date.parse(endRaw) : startAt + 3_600_000;
      return {
        id: String(ev.id ?? `mcp-cal-${idx}`),
        title: String(ev.summary ?? ev.title ?? "(无标题日程)"),
        location: typeof ev.location === "string" && ev.location ? ev.location : undefined,
        startAt,
        endAt,
      };
    })
    .filter((ev) => Number.isFinite(ev.startAt) && ev.endAt > dayStart.getTime() && ev.startAt < dayEnd.getTime())
    .sort((a, b) => a.startAt - b.startAt);

  const conflicts: Array<{ first: string; second: string; overlapLabel: string }> = [];
  const conflictMap = new Map<string, string>();
  for (let i = 0; i < rawEvents.length; i += 1) {
    for (let j = i + 1; j < rawEvents.length; j += 1) {
      const a = rawEvents[i];
      const b = rawEvents[j];
      if (!a || !b) continue;
      if (b.startAt < a.endAt && a.startAt < b.endAt) {
        const overlapStart = Math.max(a.startAt, b.startAt);
        const overlapEnd = Math.min(a.endAt, b.endAt);
        conflicts.push({
          first: a.title,
          second: b.title,
          overlapLabel: `${fmtHm(overlapStart)}–${fmtHm(overlapEnd)}`,
        });
        conflictMap.set(a.id, b.title);
        conflictMap.set(b.id, a.title);
      }
    }
  }

  const todayEvents: BotCalendarEventSummary[] = rawEvents.map((ev) => ({
    id: ev.id,
    title: ev.title,
    startAt: ev.startAt,
    endAt: ev.endAt,
    timeRangeLabel: `${fmtHm(ev.startAt)}–${fmtHm(ev.endAt)}`,
    ...(ev.location ? { location: ev.location } : {}),
    ...(conflictMap.has(ev.id) ? { conflictWith: conflictMap.get(ev.id) } : {}),
  }));

  const leadMs = Math.max(1, leadMinutes) * 60_000;
  const upcomingSoon = todayEvents.filter((ev) => ev.startAt >= nowMs && ev.startAt - nowMs <= leadMs);

  const workStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0, 0).getTime();
  const workEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0, 0, 0).getTime();
  let cursor = Math.max(workStart, nowMs);
  const freeBlocks: Array<{ startLabel: string; endLabel: string; minutes: number }> = [];
  for (const ev of todayEvents) {
    if (ev.endAt <= cursor) continue;
    if (ev.startAt > cursor) {
      const endSlot = Math.min(ev.startAt, workEnd);
      const mins = Math.floor((endSlot - cursor) / 60_000);
      if (mins >= 30) {
        freeBlocks.push({ startLabel: fmtHm(cursor), endLabel: fmtHm(endSlot), minutes: mins });
      }
    }
    cursor = Math.max(cursor, ev.endAt);
  }
  if (cursor < workEnd) {
    const mins = Math.floor((workEnd - cursor) / 60_000);
    if (mins >= 30) {
      freeBlocks.push({ startLabel: fmtHm(cursor), endLabel: fmtHm(workEnd), minutes: mins });
    }
  }

  return { todayEvents, upcomingSoon, conflicts, freeBlocks };
}
