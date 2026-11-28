/**
 * 1:1 Meta Muse Search Modal (`Ctrl+K`) for Qianji Bot Mode.
 */
import { useEffect, useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { MessageCircle, Search } from "lucide-react";
import { useFrontendService, useSessionHandle } from "@qianji/client";
import { stripBotThinking } from "./BotChatThreadWidgets";
import { patchBotUi, useBotSnapshot } from "./botStore";

interface SearchHit {
  readonly id: string;
  readonly title: string;
  readonly snippet: string;
  readonly meta: string;
  readonly onSelect: () => void;
}

export function BotSearchDialog({
  ctx,
  onClose,
}: {
  readonly ctx?: Context;
  readonly onClose: () => void;
}): ReactElement {
  const snapshot = useBotSnapshot();
  const sessionService = useFrontendService("sessionService", ctx);
  const navigationService = useFrontendService("navigationService", ctx);
  const { snapshot: mainChatSnap } = useSessionHandle(
    snapshot.mainSessionId ? `harness:${snapshot.mainSessionId}` : null,
    snapshot.botCwd ? { isolated: false, autoStart: true, cwd: snapshot.botCwd } : { isolated: false, autoStart: false },
    ctx,
  );

  const [searchQuery, setSearchQuery] = useState("");
  const [remoteHits, setRemoteHits] = useState<
    readonly { id: string; name: string; snippet: string; cwd: string; file: string }[]
  >([]);

  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2 || !sessionService) {
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void sessionService
        .searchSessions(q, { limit: 6 })
        .then((matches) => {
          if (cancelled) return;
          setRemoteHits(
            matches.map((m) => ({
              id: m.session.file,
              name: m.session.name || m.session.firstMessage || "工作台会话",
              snippet: m.snippet,
              cwd: m.session.cwd,
              file: m.session.file,
            })),
          );
        })
        .catch(() => undefined);
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchQuery, sessionService]);

  const q = searchQuery.trim().toLowerCase();
  const hits: SearchHit[] = [];

  const mainMessages = mainChatSnap?.messages ?? [];
  const mainLastText = [...mainMessages]
    .reverse()
    .map((m) => stripBotThinking(m.content).trim())
    .find((t) => t !== "" && (q === "" || t.toLowerCase().includes(q)));
  if (mainLastText !== undefined) {
    hits.push({
      id: "main-chat",
      title: "主聊天",
      snippet: mainLastText.slice(0, 120),
      meta: "今天",
      onSelect: () => patchBotUi({ modal: null, activeView: "chat", activeSessionId: null }),
    });
  }

  for (const st of snapshot.sideThreads) {
    const preview = stripBotThinking(st.snippet ?? "").trim();
    if (q === "" || st.title.toLowerCase().includes(q) || preview.toLowerCase().includes(q)) {
      hits.push({
        id: `side-${st.id}`,
        title: st.title,
        snippet: preview || "独立旁聊会话",
        meta: new Date(st.updatedAt).toLocaleDateString("zh-CN"),
        onSelect: () =>
          patchBotUi({ modal: null, activeView: "chat", activeSessionId: st.sessionId, chatDrawerOpen: true }),
      });
    }
  }

  for (const sp of snapshot.spaces) {
    if (q === "" || sp.title.toLowerCase().includes(q) || sp.description.toLowerCase().includes(q)) {
      hits.push({
        id: `space-${sp.id}`,
        title: sp.title,
        snippet: sp.description,
        meta: sp.updatedLabel,
        onSelect: () => patchBotUi({ modal: null, activeView: "library", libSection: "spaces" }),
      });
    }
  }

  for (const g of snapshot.goals) {
    if (q === "" || g.title.toLowerCase().includes(q) || g.summary.toLowerCase().includes(q)) {
      hits.push({
        id: `goal-${g.id}`,
        title: g.title,
        snippet: g.summary,
        meta: g.category,
        onSelect: () => patchBotUi({ modal: null, activeView: "goals" }),
      });
    }
  }

  for (const doc of snapshot.documents) {
    if (q === "" || doc.name.toLowerCase().includes(q) || doc.content.toLowerCase().includes(q)) {
      hits.push({
        id: `doc-${doc.id}`,
        title: doc.name,
        snippet: doc.content.slice(0, 120),
        meta: doc.updatedLabel,
        onSelect: () => patchBotUi({ modal: "doc-preview", activeDoc: doc }),
      });
    }
  }

  if (q.length >= 2) {
    for (const rh of remoteHits) {
      hits.push({
        id: `ws-${rh.id}`,
        title: rh.name,
        snippet: rh.snippet,
        meta: "Agent 工作台",
        onSelect: () => {
          onClose();
          navigationService?.setShellMode("agent");
          void sessionService?.switchSession(rh.cwd, rh.file);
        },
      });
    }
  }

  return (
    <div className="qj-bot-modal-backdrop" onClick={onClose}>
      <div className="qj-bot-dialog qj-muse-search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="qj-muse-search-input-bar">
          <Search size={17} strokeWidth={1.85} />
          <input
            autoFocus
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索"
            aria-label="搜索分身内容"
          />
        </div>

        <div className="qj-muse-search-body">
          <div className="qj-muse-search-section-label">{q === "" ? "最近访问" : "结果"}</div>
          {hits.length === 0 ? (
            <div className="qj-muse-search-empty">
              {q === "" ? "暂无最近访问记录" : "未找到匹配内容"}
            </div>
          ) : (
            hits.map((it) => (
              <button key={it.id} type="button" className="qj-muse-search-hit" onClick={it.onSelect}>
                <span className="qj-muse-search-hit-icon">
                  <MessageCircle size={15} strokeWidth={1.8} />
                </span>
                <span className="qj-muse-search-hit-copy">
                  <span className="qj-muse-search-hit-title">{it.title}</span>
                  <span className="qj-muse-search-hit-sub">
                    {it.snippet} · {it.meta}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
