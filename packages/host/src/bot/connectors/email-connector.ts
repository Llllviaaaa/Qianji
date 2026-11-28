/**
 * Standards-based IMAP (receive via `imapflow` + `mailparser`) & SMTP (send via
 * `nodemailer`) connector engine (`packages/host/src/bot/connectors/email-connector.ts`).
 *
 * Supports both password / App Password authentication and OAuth 2.0 `XOAUTH2`
 * tokens, full multipart MIME & charset decoding, and STARTTLS / implicit TLS.
 */
import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import nodemailer from "nodemailer";
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

export interface EmailAuthOptions {
  /** Optional OAuth 2.0 Bearer access token for `XOAUTH2` authentication. */
  accessToken?: string;
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

function stripHtmlToPlain(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatAddressDisplay(addrObj: AddressObject | AddressObject[] | undefined): string {
  const list = Array.isArray(addrObj) ? addrObj : addrObj ? [addrObj] : [];
  const first = list[0]?.value?.[0];
  if (!first) return "";
  if (first.name && first.address) return `${first.name} <${first.address}>`;
  return first.address || first.name || "";
}

function extractRawEmailAddress(addrObj: AddressObject | AddressObject[] | undefined): string {
  const list = Array.isArray(addrObj) ? addrObj : addrObj ? [addrObj] : [];
  return list[0]?.value?.[0]?.address?.trim() ?? "";
}

function isLoopbackHost(host: string): boolean {
  const lower = host.trim().toLowerCase();
  return lower === "127.0.0.1" || lower === "localhost" || lower === "::1";
}

export async function fetchRecentEmails(
  config: BotEmailConnectorConfig,
  password: string,
  limit = 10,
  options?: EmailAuthOptions,
): Promise<FetchedEmail[]> {
  const host = config.imapHost.trim();
  const user = config.emailAddress.trim();
  if (!host || !user) {
    throw new Error("请先填写邮箱地址和 IMAP 服务器主机");
  }
  const accessToken = options?.accessToken?.trim();
  if (!password && !accessToken) {
    throw new Error("请填写邮箱密码/授权码或完成 OAuth 授权");
  }

  const client = new ImapFlow({
    host,
    port: config.imapPort || (config.imapTls ? 993 : 143),
    secure: config.imapTls,
    ...(!config.imapTls && isLoopbackHost(host) ? { doSTARTTLS: false } : {}),
    auth: accessToken ? { user, accessToken } : { user, pass: password },
    logger: false,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });

  client.on("error", () => {
    // Handled via awaited command rejections below.
  });

  try {
    await client.connect();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`IMAP 登录或连接失败 (${host})：${detail}`, { cause: err });
  }

  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const mailbox = client.mailbox;
      if (!mailbox || mailbox.exists === 0) {
        return [];
      }

      const searchResult = await client.search({ all: true }, { uid: true });
      const allUids = Array.isArray(searchResult) ? searchResult : [];
      if (allUids.length === 0) {
        return [];
      }

      const recentUids = allUids.slice(-Math.max(1, limit));
      const fetched: FetchedEmail[] = [];

      for await (const msg of client.fetch(
        recentUids,
        { uid: true, envelope: true, internalDate: true, source: { maxLength: 65_536 } },
        { uid: true },
      )) {
        const uid = String(msg.uid);
        let sender = "";
        let replyTo = "";
        let subject = "";
        let dateObj: Date | undefined;
        let plainBody = "";

        if (msg.source && msg.source.length > 0) {
          const parsed = await simpleParser(msg.source);
          sender = formatAddressDisplay(parsed.from);
          replyTo = extractRawEmailAddress(parsed.replyTo) || extractRawEmailAddress(parsed.from);
          subject = parsed.subject?.trim() ?? "";
          dateObj = parsed.date;
          plainBody = parsed.text?.trim()
            ? normalizeWhitespace(parsed.text)
            : typeof parsed.html === "string"
              ? stripHtmlToPlain(parsed.html)
              : "";
        }

        if (!sender && msg.envelope?.from?.[0]) {
          const f = msg.envelope.from[0];
          sender = f.name && f.address ? `${f.name} <${f.address}>` : f.address || f.name || "";
        }
        if (!replyTo) {
          replyTo = msg.envelope?.replyTo?.[0]?.address || msg.envelope?.from?.[0]?.address || sender;
        }
        if (!subject) {
          subject = msg.envelope?.subject?.trim() || "(无主题)";
        }
        const resolvedDate =
          dateObj ??
          (msg.internalDate instanceof Date
            ? msg.internalDate
            : msg.envelope?.date instanceof Date
              ? msg.envelope.date
              : undefined);
        const receivedAt = resolvedDate && Number.isFinite(resolvedDate.getTime()) ? resolvedDate.getTime() : Date.now();

        fetched.push({
          uid,
          sender: sender || "未知发件人",
          replyTo: replyTo || "",
          subject,
          dateHeader: resolvedDate ? resolvedDate.toUTCString() : "",
          preview: plainBody.slice(0, 180) || "(正文为空)",
          fullBody: plainBody.slice(0, 3500),
          receivedAt,
        });
      }

      return fetched.reverse();
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {
      client.close();
    });
  }
}

export async function sendSmtpEmail(
  config: BotEmailConnectorConfig,
  password: string,
  input: { to: string; subject: string; body: string },
  options?: EmailAuthOptions,
): Promise<void> {
  const host = config.smtpHost.trim();
  const user = config.emailAddress.trim();
  if (!host || !user) {
    throw new Error("请先配置 SMTP 服务器与发件邮箱地址");
  }
  const cleanTo = input.to.trim().replace(/^[<\s]+|[>\s]+$/g, "");
  if (!cleanTo) {
    throw new Error("请指定有效的收件人邮箱地址");
  }

  const accessToken = options?.accessToken?.trim();
  const port = config.smtpPort || (config.smtpTls ? 465 : 587);
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: config.smtpTls,
    ...(!config.smtpTls && isLoopbackHost(host) ? { ignoreTLS: true } : {}),
    ...(accessToken
      ? { auth: { type: "OAuth2" as const, user, accessToken } }
      : password
        ? { auth: { user, pass: password } }
        : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });

  try {
    await transporter.sendMail({
      from: user,
      to: cleanTo,
      subject: input.subject,
      text: input.body,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`SMTP 发送失败 (${host}:${port})：${detail}`, { cause: err });
  } finally {
    transporter.close();
  }
}
