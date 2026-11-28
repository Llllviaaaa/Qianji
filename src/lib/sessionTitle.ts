import type { SessionInfo } from "../types";

const ATTACHED_FILES_TAIL_RE = /(?:^|\r?\n\r?\n)附加的本地文件：\r?\n((?:- .+(?:\r?\n|$))+)\s*$/;
const LEADING_QUOTE_RE = /^(?:>[ \t]?.*(?:\r?\n|$))+\r?\n/;
const LEADING_CONN_RE = /^\[已关联连接器上下文:\s*[^\]]+\]\r?\n?/;
const LEADING_SLASH_RE = /^\/([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?:\s+([\s\S]*))?$/;

function sanitizeFirstMessageForTitle(input: string): string {
  let working = input.trim();
  if (!working) return "";

  const attachMatch = ATTACHED_FILES_TAIL_RE.exec(working);
  let fallbackFileName = "";
  if (attachMatch?.[1] !== undefined) {
    const firstFileLine = attachMatch[1]
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith("- "));
    if (firstFileLine) {
      const sep = firstFileLine.indexOf(": ");
      if (sep > 2) fallbackFileName = firstFileLine.slice(2, sep).trim();
    }
    working = working.slice(0, attachMatch.index).trim();
  }

  working = working.replace(LEADING_QUOTE_RE, "").trim();
  working = working.replace(LEADING_CONN_RE, "").trim();

  const slashMatch = LEADING_SLASH_RE.exec(working);
  if (slashMatch?.[1] !== undefined) {
    const cmdName = slashMatch[1];
    const cmdArgs = (slashMatch[2] ?? "").trim();
    if (cmdArgs !== "") {
      working = cmdArgs;
    } else if (cmdName.toLowerCase().startsWith("skill:") && cmdName.length > 6) {
      working = cmdName.slice(6);
    } else {
      working = `/${cmdName}`;
    }
  }

  const collapsed = working.replace(/\s+/g, " ").trim();
  return collapsed || fallbackFileName;
}

function looksLikeBareFilesystemPath(raw: string): boolean {
  if (/\s/.test(raw)) return false;
  if (/^[a-zA-Z]:[\\/]/.test(raw)) return true;
  if (raw.includes("\\")) return true;
  if (raw.startsWith("/") && raw.indexOf("/", 1) > 1) return true;
  return false;
}

/** Thread titles only — never show cwd, URLs, serialized plumbing, or bare paths as labels. */
export function sessionTitle(session: SessionInfo): string {
  const explicitName = (session.name ?? "").trim().replace(/\s+/g, " ");
  const raw = explicitName || sanitizeFirstMessageForTitle(session.firstMessage || "");
  if (!raw) return "未命名对话";
  if (/^https?:\/\//i.test(raw)) return "未命名对话";
  if (looksLikeBareFilesystemPath(raw)) {
    const leaf = raw.split(/[\\/]/).filter(Boolean).pop();
    if (leaf && leaf.length < 40 && !/^\d+$/.test(leaf)) return leaf;
    return "未命名对话";
  }
  if (/^\d{4,}$/.test(raw)) return "未命名对话";
  return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
}

export function activeSessionTitle({
  sessions,
  sessionFile,
  sessionId,
  sessionName,
  firstMessage,
}: {
  sessions: SessionInfo[];
  sessionFile?: string | null;
  sessionId?: string | null;
  sessionName?: string | null;
  firstMessage?: string;
}): string {
  const normalizeFile = (value: string) => value.replace(/\\/g, "/").toLowerCase();
  const active = sessions.find((session) => (
    Boolean(sessionFile) && normalizeFile(session.file) === normalizeFile(sessionFile as string)
  ) || (
    Boolean(sessionId) && session.sessionId === sessionId
  ));

  if (active || sessionName?.trim() || firstMessage?.trim()) {
    return sessionTitle({
      ...(active || {
        file: sessionFile || "",
        sessionId: sessionId || "",
        cwd: "",
        messageCount: 0,
      }),
      name: sessionName?.trim() || active?.name,
      firstMessage: active?.firstMessage || firstMessage,
    });
  }
  return sessionId ? `任务 ${sessionId.slice(0, 8)}` : "新任务";
}

export function sessionRecency(session: SessionInfo): number {
  if (typeof session.updatedAt === "number" && Number.isFinite(session.updatedAt)) return session.updatedAt;
  const created = session.createdAt ? Date.parse(session.createdAt) : NaN;
  return Number.isFinite(created) ? created : 0;
}
