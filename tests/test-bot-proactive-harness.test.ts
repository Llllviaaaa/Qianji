/**
 * Integration tests for the independent `BotCompanionHarness`, 4 real connectors
 * (TCP IMAP/SMTP, HTTP .ics Calendar, Process Sensor, Meeting Notes), post-turn
 * reflection, tiered focus-aware delivery, and outbound approval execution.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Service, type Context } from "@deepseek-ai/cordis";
import { AgentLoop } from "@qianji/agent-loop";
import { Credentials, LlmService, type LlmRequest, type StreamChunk } from "@qianji/llm";
import * as promptContext from "@qianji/prompt-context";
import type { RpcHandler, RpcService } from "@qianji/rpc";
import { Sessions } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { textOutput, Tools } from "@qianji/tools";
import { Ui } from "@qianji/ui";
import * as botPlugin from "../packages/host/src/bot/index";
import { createHost } from "../packages/host/src/host";
import * as sessionsRpc from "../packages/host/src/sessions-rpc";
import type { ProcessEntry } from "../packages/host/src/bot/connectors/process-sensor";

class SpyRpc extends Service implements RpcService {
  static provide = "rpc";
  private readonly handlers = new Map<string, RpcHandler>();
  readonly broadcasts: Array<{ method: string; params: unknown }> = [];

  constructor(ctx: Context) {
    super(ctx, "rpc");
  }

  method(name: string, handler: RpcHandler): () => void {
    this.handlers.set(name, handler);
    return () => {
      if (this.handlers.get(name) === handler) this.handlers.delete(name);
    };
  }

  methods(): string[] {
    return ["initialize", ...this.handlers.keys()];
  }

  broadcast(method: string, params?: unknown): void {
    this.broadcasts.push({ method, params });
  }

  async invoke<T>(name: string, params: unknown = {}): Promise<T> {
    const fn = this.handlers.get(name);
    if (!fn) throw new Error(`RPC method not registered: ${name}`);
    return (await fn(params, {
      signal: new AbortController().signal,
      notify: () => undefined,
    })) as T;
  }
}

async function startMockImapServer(getEmails: () => Array<{ uid: string; from: string; subject: string; body: string }>) {
  const srv = createNetServer((sock: Socket) => {
    sock.on("error", () => undefined);
    sock.write("* OK [CAPABILITY IMAP4rev1] Mock IMAP ready\r\n");
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      while (buf.includes("\r\n")) {
        const idx = buf.indexOf("\r\n");
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        if (!line) continue;
        const spaceIdx = line.indexOf(" ");
        const tag = spaceIdx > 0 ? line.slice(0, spaceIdx) : "A0";
        const rest = spaceIdx > 0 ? line.slice(spaceIdx + 1) : line;
        const list = getEmails();
        if (/^CAPABILITY\b/i.test(rest)) {
          sock.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`);
        } else if (/^LOGIN\b/i.test(rest)) {
          sock.write(`${tag} OK LOGIN completed\r\n`);
        } else if (/^(?:SELECT|EXAMINE)\b/i.test(rest)) {
          sock.write(
            `* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n* ${list.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1] UIDs valid\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`,
          );
        } else if (/^UID SEARCH/i.test(rest)) {
          sock.write(`* SEARCH ${list.map((e) => e.uid).join(" ")}\r\n${tag} OK SEARCH completed\r\n`);
        } else if (/^UID FETCH\s+([^\s]+)/i.test(rest)) {
          const seqSpec = /^UID FETCH\s+([^\s]+)/i.exec(rest)?.[1] ?? "";
          const wanted = new Set<string>();
          for (const part of seqSpec.split(",")) {
            if (part.includes(":")) {
              const [loRaw, hiRaw] = part.split(":");
              const lo = Number(loRaw);
              const hi = hiRaw === "*" ? Infinity : Number(hiRaw);
              for (const item of list) {
                const n = Number(item.uid);
                if (n >= lo && n <= hi) wanted.add(item.uid);
              }
            } else if (part) {
              wanted.add(part);
            }
          }
          const matched = list.filter((e) => wanted.has(e.uid));
          for (let i = 0; i < matched.length; i += 1) {
            const found = matched[i];
            if (!found) continue;
            const b64Subj = `=?UTF-8?B?${Buffer.from(found.subject, "utf8").toString("base64")}?=`;
            const rawMime = [
              `From: ${found.from}`,
              `Reply-To: ${found.from}`,
              `Subject: ${b64Subj}`,
              `Date: ${new Date().toUTCString()}`,
              "MIME-Version: 1.0",
              "Content-Type: text/plain; charset=UTF-8",
              "",
              found.body,
              "",
            ].join("\r\n");
            const byteLen = Buffer.byteLength(rawMime, "utf8");
            const bodyAttr = /BODY\.PEEK\[\]<0\.\d+>/i.test(rest) ? "BODY[]<0>" : "BODY[]";
            sock.write(`* ${i + 1} FETCH (UID ${found.uid} ${bodyAttr} {${byteLen}}\r\n${rawMime})\r\n`);
          }
          sock.write(`${tag} OK FETCH completed\r\n`);
        } else if (/^CLOSE\b/i.test(rest)) {
          sock.write(`${tag} OK CLOSE completed\r\n`);
        } else if (/^LOGOUT\b/i.test(rest)) {
          sock.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          sock.end();
        } else {
          sock.write(`${tag} OK Completed\r\n`);
        }
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = srv.address();
  return { port: typeof addr === "object" && addr ? addr.port : 0, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

async function startMockSmtpServer() {
  const received: Array<{ from: string; to: string; data: string }> = [];
  const srv = createNetServer((sock: Socket) => {
    sock.on("error", () => undefined);
    sock.write("220 mock-smtp ready\r\n");
    let mode: "cmd" | "user" | "pass" | "data" = "cmd";
    let from = "";
    let to = "";
    let dataBuf = "";
    let raw = "";
    sock.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      while (raw.includes("\r\n")) {
        const idx = raw.indexOf("\r\n");
        const line = raw.slice(0, idx);
        raw = raw.slice(idx + 2);
        if (mode === "user") { mode = "pass"; sock.write("334 UGFzc3dvcmQ6\r\n"); continue; }
        if (mode === "pass") { mode = "cmd"; sock.write("235 Authentication successful\r\n"); continue; }
        if (mode === "data") {
          if (line === ".") {
            received.push({ from, to, data: dataBuf });
            mode = "cmd";
            dataBuf = "";
            sock.write("250 OK queued\r\n");
          } else {
            dataBuf += `${line.replace(/^\.\./, ".")}\n`;
          }
          continue;
        }
        if (/^EHLO|^HELO/i.test(line)) sock.write("250 Hello\r\n");
        else if (/^AUTH LOGIN/i.test(line)) { mode = "user"; sock.write("334 VXNlcm5hbWU6\r\n"); }
        else if (/^MAIL FROM:/i.test(line)) { from = line.slice(10).trim(); sock.write("250 OK\r\n"); }
        else if (/^RCPT TO:/i.test(line)) { to = line.slice(8).trim(); sock.write("250 OK\r\n"); }
        else if (/^DATA/i.test(line)) { mode = "data"; dataBuf = ""; sock.write("354 End data with .\r\n"); }
        else if (/^QUIT/i.test(line)) { sock.write("221 Bye\r\n"); sock.end(); }
        else sock.write("250 OK\r\n");
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = srv.address();
  return { port: typeof addr === "object" && addr ? addr.port : 0, received, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

function toIcsLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`;
}

describe("Independent Proactive Bot Harness & 4 Real Connectors", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it("isolates BotCompanionHarness from AgentLoop, runs post-turn reflection, polls all 4 connectors, and sends SMTP after approval", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "qj-proactive-bot-"));
    const notesDir = mkdtempSync(join(tmpdir(), "qj-bot-notes-"));
    cleanups.push(() => {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(notesDir, { recursive: true, force: true });
    });

    const mailList = [
      { uid: "41", from: "alice@example.com", subject: "下周项目对齐方案确认", body: "请确认周五前能否发我初稿？" },
    ];
    const imap = await startMockImapServer(() => mailList);
    const smtp = await startMockSmtpServer();

    const now = Date.now();
    const mStart = new Date(now + 10 * 60_000);
    const mEnd = new Date(now + 70 * 60_000);
    const cStart = new Date(now + 30 * 60_000);
    const cEnd = new Date(now + 90 * 60_000);
    const icsPayload = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:ev-1",
      "SUMMARY:项目周会",
      `DTSTART:${toIcsLocal(mStart)}`,
      `DTEND:${toIcsLocal(mEnd)}`,
      "LOCATION:3F会议室",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:ev-2",
      "SUMMARY:客户产品评审",
      `DTSTART:${toIcsLocal(cStart)}`,
      `DTEND:${toIcsLocal(cEnd)}`,
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const postedGhComments: string[] = [];
    const icsServer = createHttpServer((req, res) => {
      const url = req.url ?? "";
      if (url.startsWith("/gh/repos/acme/app/issues/7/comments") && req.method === "POST") {
        let body = "";
        req.on("data", (c) => { body += String(c); });
        req.on("end", () => {
          postedGhComments.push(body);
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: 99 }));
        });
        return;
      }
      if (url.startsWith("/gh/repos/acme/app/issues")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify([
            {
              id: 700,
              number: 7,
              title: "Fix WSL2 storage relocation edge case",
              html_url: "https://github.com/acme/app/issues/7",
              updated_at: new Date().toISOString(),
              user: { login: "alice" },
            },
          ]),
        );
        return;
      }
      if (url.startsWith("/notion/v1/search")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            results: [
              {
                id: "page-123",
                url: "https://www.notion.so/page123",
                last_edited_time: new Date().toISOString(),
                properties: { Name: { type: "title", title: [{ plain_text: "Q4 Architecture Roadmap" }] } },
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "text/calendar; charset=utf-8" });
      res.end(icsPayload);
    });
    await new Promise<void>((r) => icsServer.listen(0, "127.0.0.1", r));
    const icsPort = (icsServer.address() as { port: number }).port;

    cleanups.push(() => Promise.all([imap.close(), smtp.close(), new Promise<void>((r) => icsServer.close(() => r()))]).then(() => undefined));

    let currentProcesses: ProcessEntry[] = [{ pid: 101, name: "cargo.exe", title: "cargo build" }];
    const capturedRequests: LlmRequest[] = [];

    const host = createHost({
      version: "0.3.0-test",
      dataDir,
      plugins: [
        [Credentials],
        [LlmService],
        [Sessions],
        [Ui],
        [Tools],
        [SystemPrompt],
        [SpyRpc],
        [promptContext, { dataDir }],
        [AgentLoop],
        [sessionsRpc],
        [botPlugin, { dataDir, distroName: "qianji-bot-unit-noop", processProbe: async () => currentProcesses }],
      ],
    });
    await host.start();
    cleanups.push(() => host.stop());

    host.ctx.llm.registerAdapter(
      { id: "mock", name: "Mock", api: "mock", baseUrl: "http://mock" },
      {
        async *stream(request: LlmRequest): AsyncIterable<StreamChunk> {
          capturedRequests.push(request);
          const lastMsg = request.messages[request.messages.length - 1];
          const isToolTurn =
            lastMsg?.role === "user" &&
            lastMsg.content.some((c) => c.type === "text" && c.text.includes("issue #7"));
          if (request.sessionId?.endsWith(":reflect")) {
            yield {
              type: "text-delta",
              index: 0,
              text: '{"preferences":["周三下午保留整块深度工作时段"],"goals":[{"title":"周五前完成发布对齐初稿","category":"工程交付"}],"space":null}',
            };
          } else if (isToolTurn) {
            yield {
              type: "tool-call-start",
              index: 0,
              id: "tc-gh-1",
              name: "bot_stage_outbound_approval",
            };
            yield {
              type: "tool-call-delta",
              index: 0,
              argumentsDelta: JSON.stringify({
                kind: "github-comment",
                title: "在 #7 下回复进度",
                summary: "确认修复方案",
                recipient: "acme/app#7",
                draftBody: "Will include storage relocation fix in v0.4.",
              }),
            };
            yield { type: "usage", usage: { inputTokens: 10, outputTokens: 12 } };
            yield { type: "finish", reason: "tool-use" };
            return;
          } else {
            yield { type: "text-delta", index: 0, text: "我明白你的顾虑，已为你梳理好安排并开始在后台盯紧关键节点。" };
          }
          yield { type: "usage", usage: { inputTokens: 10, outputTokens: 12 } };
          yield { type: "finish", reason: "stop" };
        },
      },
    );

    host.ctx.tools.register({
      name: "bash",
      description: "shell",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      execute: async () => textOutput("ok"),
    });

    const rpc = host.ctx.rpc as unknown as SpyRpc;
    const snap0 = await rpc.invoke<{ mainSessionId: string }>("bot.getSnapshot", {});

    // 1. Dual-Harness Separation + Post-Turn Reflection
    const botSess = await host.ctx.sessions.get(snap0.mainSessionId);
    botSess?.setModel({ provider: "mock", model: "companion-v1" });
    await rpc.invoke("session.prompt", { sessionId: snap0.mainSessionId, content: "下周五前要把发布对齐初稿赶出来，周三下午别排会" });
    await host.ctx.botHarness?.idle(snap0.mainSessionId);

    const agentSess = host.ctx.sessions.create({ cwd: dataDir });
    agentSess.setModel({ provider: "mock", model: "coder-v1" });
    await rpc.invoke("session.prompt", { sessionId: agentSess.id, content: "Inspect README" });
    await host.ctx.agents.idle(agentSess.id);

    const botReq = capturedRequests.find((r) => r.sessionId === snap0.mainSessionId);
    const agentReq = capturedRequests.find((r) => r.sessionId === agentSess.id);
    expect(botReq?.system).toContain("<companion_identity>");
    expect(botReq?.system).not.toContain("You are a coding agent");
    expect(botReq?.tools?.some((t) => t.name === "bot_sense_apps")).toBe(true);
    expect(botReq?.tools?.some((t) => t.name === "bot_stage_outbound_approval")).toBe(true);
    expect(agentReq?.system).toContain("You are a coding agent");
    expect(agentReq?.tools?.some((t) => t.name === "bot_sense_apps")).toBe(false);

    // Wait briefly for async post-turn reflection to persist
    await new Promise((r) => setTimeout(r, 150));
    const snapAfterReflect = await rpc.invoke<{ learnedPreferences: string[]; goals: Array<{ title: string }> }>("bot.getSnapshot", {});
    expect(snapAfterReflect.learnedPreferences.some((p) => p.includes("周三下午"))).toBe(true);
    expect(snapAfterReflect.goals.some((g) => g.title.includes("发布对齐初稿"))).toBe(true);

    // 2. Configure 4 Real Connectors & Run Patrol
    writeFileSync(join(notesDir, "产品对齐会纪要.md"), "# 对齐纪要\n待办：周五前同步给运营团队最新时间表\n", "utf8");
    await rpc.invoke("bot.configure", {
      modelConfig: { primary: { provider: "mock", model: "companion-v1" }, patrol: { provider: "mock", model: "companion-v1" } },
      pacing: { heartbeatEnabled: true, quietHoursEnabled: false },
      email: {
        enabled: true,
        preset: "custom",
        emailAddress: "me@example.com",
        password: "app-password",
        imapHost: "127.0.0.1",
        imapPort: imap.port,
        imapTls: false,
        smtpHost: "127.0.0.1",
        smtpPort: smtp.port,
        smtpTls: false,
      },
      calendar: { enabled: true, icsUrl: `http://127.0.0.1:${icsPort}/cal.ics`, leadMinutes: 20 },
      processSensor: { enabled: true, watchedProcesses: ["cargo.exe"], lateNightCareEnabled: false },
      meetingsIm: { meetingNotesEnabled: true, meetingNotesDir: notesDir },
      github: {
        enabled: true,
        permission: "ask-write",
        watchedRepos: ["acme/app"],
        apiBase: `http://127.0.0.1:${icsPort}/gh`,
        token: "ghp_mock_token",
      },
      notion: {
        enabled: true,
        permission: "read-only",
        parentPageId: "parent-1",
        apiBase: `http://127.0.0.1:${icsPort}/notion/v1`,
        token: "example_notion_mock",
      },
    });

    // Warm sample sees cargo.exe running; second poll drops cargo.exe to simulate finish
    await rpc.invoke("bot.connector.test", { kind: "processes" });
    currentProcesses = [];

    const patrolRes = await rpc.invoke<{
      triggered: boolean;
      queuedApprovals: number;
      snapshot: {
        inboxItems: Array<{ source?: string; subject: string; preview?: string; replyTo?: string }>;
        pendingApprovals: Array<{ id: string; kind?: string; recipient?: string }>;
        goals: Array<{ title: string }>;
        awareness: { conflictCount: number; todayEvents: unknown[] };
      };
    }>("bot.patrol.runNow", { force: false });

    expect(patrolRes.triggered).toBe(true);
    const syncedMail = patrolRes.snapshot.inboxItems.find((m) => m.subject.includes("下周项目对齐方案确认"));
    expect(syncedMail).toBeDefined();
    expect(syncedMail?.preview).not.toContain("OK FETCH");
    expect(patrolRes.snapshot.inboxItems.some((m) => m.source === "github" && m.subject.includes("#7"))).toBe(true);
    expect(patrolRes.snapshot.inboxItems.some((m) => m.source === "notion" && m.subject.includes("Q4 Architecture Roadmap"))).toBe(true);
    expect(patrolRes.snapshot.awareness.conflictCount).toBe(1);
    expect(patrolRes.snapshot.awareness.todayEvents.length).toBe(2);
    expect(patrolRes.snapshot.goals.some((g) => g.title.includes("周五前同步给运营团队"))).toBe(true);
    const emailApr = patrolRes.snapshot.pendingApprovals.find((a) => a.kind === "send-email");
    expect(emailApr?.recipient).toBe("alice@example.com");
    expect(rpc.broadcasts.some((b) => b.method === "bot/desktopNotification")).toBe(true);

    // 3. Approve Email Draft -> Verify Real SMTP Delivery!
    if (emailApr) {
      await rpc.invoke("bot.approvals.resolve", { id: emailApr.id, decision: "approved" });
    }
    expect(smtp.received.length).toBe(1);
    expect(smtp.received[0]?.to).toContain("alice@example.com");

    // 3.5 Verify GitHub comment approval executes real POST, and read-only permission blocks outbound write
    await rpc.invoke("session.prompt", { sessionId: snap0.mainSessionId, content: "请帮我在 issue #7 评论一下进度" });
    await host.ctx.botHarness?.idle(snap0.mainSessionId);
    const snapWithGh = await rpc.invoke<{ pendingApprovals: Array<{ id: string; kind?: string }> }>("bot.getSnapshot", {});
    const ghApr = snapWithGh.pendingApprovals.find((a) => a.kind === "github-comment");
    expect(ghApr).toBeDefined();
    if (ghApr) {
      await rpc.invoke("bot.approvals.resolve", { id: ghApr.id, decision: "approved" });
    }
    expect(postedGhComments.length).toBe(1);
    expect(postedGhComments[0]).toContain("storage relocation fix");

    const notionTest = await rpc.invoke<{ ok: boolean; message: string }>("bot.connector.test", { kind: "notion" });
    expect(notionTest.ok).toBe(true);
    const notesTest = await rpc.invoke<{ ok: boolean; message: string }>("bot.connector.test", { kind: "meeting_notes" });
    expect(notesTest.ok).toBe(true);

    // Switch email to read-only -> new mail is still synced, but NO reply draft is staged
    await rpc.invoke("bot.configure", { email: { permission: "read-only" } });
    mailList.push({ uid: "43", from: "bob@example.com", subject: "只读模式测试来信", body: "仅查看不应自动拟回复" });
    const roPatrol = await rpc.invoke<{ queuedApprovals: number }>("bot.patrol.runNow", { force: false });
    expect(roPatrol.queuedApprovals).toBe(0);

    // 4. Focus/In-Meeting Pacing Suppression: routine email arrives while Zoom is running -> no desktop popup
    rpc.broadcasts.length = 0;
    currentProcesses = [{ pid: 202, name: "Zoom.exe", title: "Zoom Meeting" }];
    mailList.push({ uid: "42", from: "news@example.com", subject: "每周行业资讯速览", body: "本周动态汇总..." });
    const suppressedRes = await rpc.invoke<{ triggered: boolean; suppressedByFocus: boolean }>("bot.patrol.runNow", { force: false });
    expect(suppressedRes.triggered).toBe(true);
    expect(suppressedRes.suppressedByFocus).toBe(true);
    expect(rpc.broadcasts.some((b) => b.method === "bot/desktopNotification")).toBe(false);
  });
});