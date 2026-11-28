/**
 * Real IMAP (receive) & SMTP (send) client over Node `tls` / `net` sockets
 * (`packages/host/src/bot/connectors/email-connector.ts`).
 */
import net from "node:net";
import tls from "node:tls";
import type { BotEmailConnectorConfig, BotEmailPreset } from "@qianji/protocol";

export interface FetchedEmail {
  uid: string;
  sender: string;
  replyTo: string;
  subject: string;
  dateHeader: string;
  preview: string;
  fullBody: string;
  receivedAt: number;
}

export interface EmailPresetDefaults {
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpTls: boolean;
}

const PRESET_DEFAULTS: Record<BotEmailPreset, EmailPresetDefaults> = {
  qq: { imapHost: "imap.qq.com", imapPort: 993, imapTls: true, smtpHost: "smtp.qq.com", smtpPort: 465, smtpTls: true },
  "163": { imapHost: "imap.163.com", imapPort: 993, imapTls: true, smtpHost: "smtp.163.com", smtpPort: 465, smtpTls: true },
  gmail: { imapHost: "imap.gmail.com", imapPort: 993, imapTls: true, smtpHost: "smtp.gmail.com", smtpPort: 465, smtpTls: true },
  outlook: { imapHost: "outlook.office365.com", imapPort: 993, imapTls: true, smtpHost: "smtp.office365.com", smtpPort: 587, smtpTls: false },
  custom: { imapHost: "", imapPort: 993, imapTls: true, smtpHost: "", smtpPort: 465, smtpTls: true },
};

export function resolveEmailPreset(preset: BotEmailPreset): EmailPresetDefaults {
  return { ...PRESET_DEFAULTS[preset] };
}

function connectSocket(host: string, port: number, useTls: boolean, timeoutMs = 10_000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const sock = useTls
      ? tls.connect({ host, port, rejectUnauthorized: true })
      : net.createConnection({ host, port });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error(`连接邮件服务器 ${host}:${port} 超时`));
    }, timeoutMs);
    sock.once(useTls ? "secureConnect" : "connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`连接邮件服务器 ${host}:${port} 失败：${err.message}`));
    });
  });
}

function decodeQuotedPrintable(raw: string): Buffer {
  const cleaned = raw.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i += 1) {
    if (cleaned[i] === "=" && i + 2 < cleaned.length && /^[0-9A-Fa-f]{2}$/.test(cleaned.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(cleaned.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(cleaned.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

export function decodeRfc2047(raw: string): string {
  const collapsed = raw.replace(/\r?\n[ \t]+/g, " ");
  return collapsed.replace(/=\?([^?]+)\?([BQbq])\?([^?]+)\?=/g, (_full, _charset: string, enc: string, payload: string) => {
    try {
      const buf = enc.toUpperCase() === "B"
        ? Buffer.from(payload, "base64")
        : decodeQuotedPrintable(payload.replace(/_/g, " "));
      return buf.toString("utf8");
    } catch {
      return payload;
    }
  }).trim();
}

function cleanPlainBody(rawBody: string): string {
  return rawBody
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractHeaderField(headers: string, name: string): string {
  const unfolded = headers.replace(/\r?\n[ \t]+/g, " ");
  const m = new RegExp(`^${name}:\\s*(.*)$`, "im").exec(unfolded);
  return m?.[1] ? decodeRfc2047(m[1].trim()) : "";
}

class LineSocketReader {
  private buf = Buffer.alloc(0);
  private readonly listeners = new Set<() => void>();
  private err: Error | null = null;
  private closed = false;

  constructor(sock: net.Socket) {
    sock.on("data", (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.notify();
    });
    sock.on("error", (err) => {
      this.err = err;
      this.notify();
    });
    sock.on("close", () => {
      this.closed = true;
      this.notify();
    });
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  private waitMore(deadline: number): Promise<void> {
    if (this.err) return Promise.reject(this.err);
    if (this.closed) return Promise.reject(new Error("邮件服务器意外断开连接"));
    const remain = deadline - Date.now();
    if (remain <= 0) return Promise.reject(new Error("邮件协议响应超时"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(onEvent);
        reject(new Error("邮件协议响应超时"));
      }, remain);
      const onEvent = () => {
        clearTimeout(timer);
        this.listeners.delete(onEvent);
        resolve();
      };
      this.listeners.add(onEvent);
    });
  }

  async readImapTag(tag: string | null, timeoutMs = 12_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    const tagPrefix = tag === null ? null : `${tag} `;
    for (;;) {
      const text = this.buf.toString("latin1");
      if (tagPrefix === null) {
        const idx = text.indexOf("\r\n");
        if (idx >= 0) {
          const out = this.buf.subarray(0, idx + 2).toString("utf8");
          this.buf = this.buf.subarray(idx + 2);
          return out;
        }
      } else {
        const lines = text.split("\r\n");
        const completeCount = this.buf.toString("latin1").endsWith("\r\n") ? lines.length : lines.length - 1;
        for (let i = 0; i < completeCount; i += 1) {
          const line = lines[i] ?? "";
          if (line.startsWith(tagPrefix)) {
            const consumed = lines.slice(0, i + 1).join("\r\n").length + 2;
            const rawSlice = this.buf.subarray(0, consumed).toString("utf8");
            this.buf = this.buf.subarray(consumed);
            return rawSlice;
          }
        }
      }
      await this.waitMore(deadline);
    }
  }

  async readSmtpReply(timeoutMs = 12_000): Promise<{ code: number; text: string }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const str = this.buf.toString("utf8");
      const lines = str.split(/\r?\n/);
      const complete = /\r?\n$/.test(str) ? lines.slice(0, -1) : lines.slice(0, -1);
      for (let i = 0; i < complete.length; i += 1) {
        const m = /^(\d{3})([ -])/.exec(complete[i] ?? "");
        if (m && m[2] === " ") {
          const consumedText = `${complete.slice(0, i + 1).join("\r\n")}\r\n`;
          const rawPos = Math.min(this.buf.length, Buffer.byteLength(consumedText, "utf8"));
          this.buf = this.buf.subarray(rawPos);
          return { code: Number(m[1]), text: complete.slice(0, i + 1).join("\n") };
        }
      }
      await this.waitMore(deadline);
    }
  }
}

function escapeImapString(val: string): string {
  return `"${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseImapFetchSegments(rawResponse: string): Array<{ headers: string; body: string }> {
  const rawBuf = Buffer.from(rawResponse, "utf8");
  const asciiView = rawBuf.toString("latin1");
  const out: Array<{ headers: string; body: string }> = [];
  const headerMatches = [...asciiView.matchAll(/BODY\[HEADER[^\]]*\]\s*\{(\d+)\}\r?\n/gi)];
  for (let i = 0; i < headerMatches.length; i += 1) {
    const hm = headerMatches[i];
    if (!hm || hm.index === undefined) continue;
    const hdrByteLen = Number(hm[1]);
    const hdrByteStart = hm.index + hm[0].length;
    const hdrByteEnd = Math.min(rawBuf.length, hdrByteStart + hdrByteLen);
    const headers = rawBuf.subarray(hdrByteStart, hdrByteEnd).toString("utf8");
    const nextByteLimit = headerMatches[i + 1]?.index ?? rawBuf.length;
    const tailAscii = asciiView.slice(hdrByteEnd, nextByteLimit);
    const bodyMatch = /BODY\[TEXT\](?:<\d+>)?\s*\{(\d+)\}\r?\n/i.exec(tailAscii);
    let body = "";
    if (bodyMatch && bodyMatch.index !== undefined) {
      const bByteStart = hdrByteEnd + bodyMatch.index + bodyMatch[0].length;
      const bByteEnd = Math.min(nextByteLimit, bByteStart + Number(bodyMatch[1]));
      body = rawBuf.subarray(bByteStart, bByteEnd).toString("utf8");
    }
    out.push({ headers, body });
  }
  return out;
}

export async function fetchRecentEmails(
  config: BotEmailConnectorConfig,
  password: string,
  limit = 10,
): Promise<FetchedEmail[]> {
  if (!config.imapHost.trim() || !config.emailAddress.trim()) {
    throw new Error("请先填写邮箱地址和 IMAP 服务器主机");
  }
  if (!password) {
    throw new Error("请填写邮箱密码或授权码");
  }

  const sock = await connectSocket(config.imapHost.trim(), config.imapPort || 993, config.imapTls);
  const reader = new LineSocketReader(sock);
  try {
    const greeting = await reader.readImapTag(null);
    if (!greeting.startsWith("* ")) throw new Error(`IMAP 握手异常：${greeting}`);

    sock.write(`A1 LOGIN ${escapeImapString(config.emailAddress.trim())} ${escapeImapString(password)}\r\n`);
    const loginRes = await reader.readImapTag("A1");
    if (!/A1 OK/i.test(loginRes)) {
      throw new Error(`IMAP 登录失败，请确认授权码或账号密码：${loginRes.trim()}`);
    }

    sock.write("A2 SELECT INBOX\r\n");
    const selRes = await reader.readImapTag("A2");
    if (!/A2 OK/i.test(selRes)) throw new Error(`无法打开收件箱：${selRes.trim()}`);

    sock.write("A3 UID SEARCH ALL\r\n");
    const searchRes = await reader.readImapTag("A3");
    const searchLine = searchRes.split(/\r?\n/).find((l) => l.startsWith("* SEARCH"));
    const uids = (searchLine ?? "").replace("* SEARCH", "").trim().split(/\s+/).filter((v) => /^\d+$/.test(v));
    if (uids.length === 0) {
      sock.write("A9 LOGOUT\r\n");
      return [];
    }

    const recentUids = uids.slice(-Math.max(1, limit)).reverse();
    const emails: FetchedEmail[] = [];
    for (let idx = 0; idx < recentUids.length; idx += 1) {
      const uid = recentUids[idx];
      if (!uid) continue;
      const tag = `F${idx + 1}`;
      sock.write(`${tag} UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (FROM REPLY-TO SUBJECT DATE)] BODY.PEEK[TEXT]<0.4096>)\r\n`);
      const rawFetch = await reader.readImapTag(tag);
      const segments = parseImapFetchSegments(rawFetch);
      const seg = segments[0];
      if (!seg) continue;
      const from = extractHeaderField(seg.headers, "From") || "未知发件人";
      const replyToHdr = extractHeaderField(seg.headers, "Reply-To") || from;
      const emailAddrMatch = /<([^>]+)>/.exec(replyToHdr) ?? /([^\s<>]+@[^\s<>]+)/.exec(replyToHdr);
      const replyTo = emailAddrMatch?.[1] ?? replyToHdr;
      const subject = extractHeaderField(seg.headers, "Subject") || "(无主题)";
      const dateHeader = extractHeaderField(seg.headers, "Date");
      const parsedDate = dateHeader ? Date.parse(dateHeader) : NaN;
      const receivedAt = Number.isFinite(parsedDate) ? parsedDate : Date.now();
      const cleaned = cleanPlainBody(seg.body);
      emails.push({
        uid,
        sender: from,
        replyTo,
        subject,
        dateHeader,
        preview: cleaned.slice(0, 180) || "(正文为空)",
        fullBody: cleaned.slice(0, 3500),
        receivedAt,
      });
    }

    sock.write("A9 LOGOUT\r\n");
    return emails;
  } finally {
    sock.destroy();
  }
}

export async function sendSmtpEmail(
  config: BotEmailConnectorConfig,
  password: string,
  input: { to: string; subject: string; body: string },
): Promise<void> {
  if (!config.smtpHost.trim() || !config.emailAddress.trim()) {
    throw new Error("请先配置 SMTP 服务器与发件邮箱地址");
  }
  const sock = await connectSocket(config.smtpHost.trim(), config.smtpPort || 465, config.smtpTls);
  const reader = new LineSocketReader(sock);
  try {
    const r0 = await reader.readSmtpReply();
    if (r0.code !== 220) throw new Error(`SMTP 握手失败：${r0.text}`);

    sock.write("EHLO qianji-bot\r\n");
    const rEhlo = await reader.readSmtpReply();
    if (rEhlo.code !== 250) throw new Error(`SMTP EHLO 失败：${rEhlo.text}`);

    if (password) {
      sock.write("AUTH LOGIN\r\n");
      const rAuth = await reader.readSmtpReply();
      if (rAuth.code === 334) {
        sock.write(`${Buffer.from(config.emailAddress.trim(), "utf8").toString("base64")}\r\n`);
        const rUser = await reader.readSmtpReply();
        if (rUser.code !== 334) throw new Error(`SMTP 账号验证失败：${rUser.text}`);
        sock.write(`${Buffer.from(password, "utf8").toString("base64")}\r\n`);
        const rPass = await reader.readSmtpReply();
        if (rPass.code !== 235) throw new Error(`SMTP 密码/授权码认证失败：${rPass.text}`);
      }
    }

    sock.write(`MAIL FROM:<${config.emailAddress.trim()}>\r\n`);
    const rFrom = await reader.readSmtpReply();
    if (rFrom.code !== 250) throw new Error(`SMTP 发件人被拒：${rFrom.text}`);

    const cleanTo = input.to.trim().replace(/[<>]/g, "");
    sock.write(`RCPT TO:<${cleanTo}>\r\n`);
    const rTo = await reader.readSmtpReply();
    if (rTo.code !== 250 && rTo.code !== 251) throw new Error(`SMTP 收件人被拒：${rTo.text}`);

    sock.write("DATA\r\n");
    const rData = await reader.readSmtpReply();
    if (rData.code !== 354) throw new Error(`SMTP DATA 被拒：${rData.text}`);

    const b64Subject = `=?UTF-8?B?${Buffer.from(input.subject, "utf8").toString("base64")}?=`;
    const stuffedBody = input.body.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    const mimePayload = [
      `From: <${config.emailAddress.trim()}>`,
      `To: <${cleanTo}>`,
      `Subject: ${b64Subject}`,
      `Date: ${new Date().toUTCString()}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      stuffedBody,
      ".",
    ].join("\r\n");
    sock.write(`${mimePayload}\r\n`);
    const rDone = await reader.readSmtpReply();
    if (rDone.code !== 250) throw new Error(`SMTP 发送失败：${rDone.text}`);

    sock.write("QUIT\r\n");
  } finally {
    sock.destroy();
  }
}