/**
 * Real Meeting Transcript directory scanner & External IM channels
 * (Telegram Bot API + Feishu Webhook) for Qianji Bot Mode.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

export interface MeetingNoteEntry {
  id: string;
  fileName: string;
  filePath: string;
  mtimeMs: number;
  excerpt: string;
}

export interface TelegramMessageEntry {
  updateId: number;
  chatId: string;
  sender: string;
  text: string;
  receivedAt: number;
}

const TRANSCRIPT_EXTS = new Set([".md", ".txt", ".srt", ".vtt"]);

function cleanTranscriptText(raw: string, ext: string): string {
  if (ext === ".srt" || ext === ".vtt") {
    return raw
      .replace(/^WEBVTT.*$/im, "")
      .replace(/^\d+\s*$/gm, "")
      .replace(/^\d{2}:\d{2}[:.]\d{2}[.,]\d{3}\s*-->\s*.*$/gm, "")
      .replace(/\n{2,}/g, "\n")
      .trim();
  }
  return raw.trim();
}

export function scanMeetingNotes(
  dir: string,
  sinceMtimeMs: number,
  maxDepth = 1,
): { notes: MeetingNoteEntry[]; maxMtimeMs: number } {
  const cleanDir = dir.trim();
  if (cleanDir === "" || !existsSync(cleanDir)) {
    return { notes: [], maxMtimeMs: sinceMtimeMs };
  }
  const found: MeetingNoteEntry[] = [];
  let maxMtime = sinceMtimeMs;

  const walk = (current: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(current, ent.name);
      if (ent.isDirectory()) {
        if (depth < maxDepth && !ent.name.startsWith(".")) walk(full, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = extname(ent.name).toLowerCase();
      if (!TRANSCRIPT_EXTS.has(ext)) continue;
      try {
        const st = statSync(full);
        if (st.mtimeMs <= sinceMtimeMs || st.size === 0 || st.size > 2 * 1024 * 1024) continue;
        if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
        const cleaned = cleanTranscriptText(readFileSync(full, "utf8"), ext);
        if (cleaned === "") continue;
        found.push({
          id: `${ent.name}:${Math.floor(st.mtimeMs)}`,
          fileName: ent.name,
          filePath: full,
          mtimeMs: st.mtimeMs,
          excerpt: cleaned.slice(0, 2800),
        });
      } catch {
        // Ignore unreadable transient transcript file.
      }
    }
  };

  walk(cleanDir, 0);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { notes: found.slice(0, 8), maxMtimeMs: maxMtime };
}

export async function pollTelegramUpdates(
  apiBase: string | undefined,
  token: string,
  offset = 0,
): Promise<{ messages: TelegramMessageEntry[]; nextOffset: number }> {
  const cleanToken = token.trim();
  if (cleanToken === "") throw new Error("请填写 Telegram Bot Token");
  const base = (apiBase?.trim() || "https://api.telegram.org").replace(/\/+$/, "");
  const url = `${base}/bot${cleanToken}/getUpdates?timeout=0&limit=10${offset > 0 ? `&offset=${offset}` : ""}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Telegram API 响应异常：HTTP ${res.status}`);
  const data = (await res.json()) as {
    ok?: boolean;
    result?: Array<{
      update_id?: number;
      message?: {
        date?: number;
        text?: string;
        chat?: { id?: number | string };
        from?: { first_name?: string; username?: string };
      };
    }>;
  };
  if (!data.ok || !Array.isArray(data.result)) {
    throw new Error("Telegram getUpdates 返回无效结果");
  }
  const messages: TelegramMessageEntry[] = [];
  let nextOffset = offset;
  for (const upd of data.result) {
    const uid = Number(upd.update_id ?? 0);
    if (uid >= nextOffset) nextOffset = uid + 1;
    const msg = upd.message;
    if (!msg?.text) continue;
    const sender = msg.from?.first_name || msg.from?.username || "Telegram 用户";
    messages.push({
      updateId: uid,
      chatId: String(msg.chat?.id ?? ""),
      sender,
      text: msg.text,
      receivedAt: msg.date ? msg.date * 1000 : Date.now(),
    });
  }
  return { messages, nextOffset };
}

export async function sendTelegramMessage(
  apiBase: string | undefined,
  token: string,
  chatId: string,
  text: string,
): Promise<void> {
  const base = (apiBase?.trim() || "https://api.telegram.org").replace(/\/+$/, "");
  const res = await fetch(`${base}/bot${token.trim()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId.trim(), text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Telegram 消息发送失败：HTTP ${res.status}`);
  }
}

export async function sendFeishuWebhook(webhookUrl: string, text: string): Promise<void> {
  const url = webhookUrl.trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("请填写有效的飞书 Webhook HTTPS 地址");
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msg_type: "text", content: { text } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`飞书 Webhook 推送失败：HTTP ${res.status}`);
  }
}