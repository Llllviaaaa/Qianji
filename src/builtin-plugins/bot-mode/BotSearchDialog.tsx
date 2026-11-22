/**
 * Global Search modal (`Ctrl+K`) for Qianji Bot Mode.
 *
 * Searches real `mainChatSnap.messages`, `sideThreads`, `spaces`, `goals`,
 * `documents`, and workspace `sessionService.searchSessions(query)` matches.
 */
import { useEffect, useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { useFrontendService, useSessionHandle } from "@qianji/client";
import { BotIcon } from "./BotAvatarArt";
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
    { isolated: false, autoStart: false },
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
    .map((m) => m.content.trim())
    .find((t) => t !== "" && (q === "" || t.toLowerCase().includes(q)));
  if (mainLastText !== undefined) {
    hits.push({
      id: "main-chat",
      title: "主聊天",
      snippet: mainLastText.slice(0, 140),
      meta: "对话",
      onSelect: () => patchBotUi({ modal: null, activeView: "chat", activeSessionId: null }),
    });
  }

  for (const st of snapshot.sideThreads) {
    const preview = st.snippet ?? "";
    if (q === "" || st.title.toLowerCase().includes(q) || preview.toLowerCase().includes(q)) {
      hits.push({
        id: `side-${st.id}`,
        title: st.title,
        snippet: preview || "独立旁聊会话",
        meta: new Date(st.updatedAt).toLocaleDateString("zh-CN"),
        onSelect: () => patchBotUi({ modal: null, activeView: "chat", activeSessionId: st.sessionId, chatDrawerOpen: true }),
      });
    }
  }

  for (const sp of snapshot.spaces) {
    if (q === "" || sp.title.toLowerCase().includes(q) || sp.description.toLowerCase().includes(q)) {
      hits.push({
        id: `space-${sp.id}`,
        title: `${sp.title} · 空间`,
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
        title: `${g.title} · 目标`,
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
        title: `${doc.name} · 文档`,
        snippet: doc.content.slice(0, 140),
        meta: doc.updatedLabel,
        onSelect: () => patchBotUi({ modal: "doc-preview", activeDoc: doc }),
      });
    }
  }

  if (q.length >= 2) {
    for (const rh of remoteHits) {
      hits.push({
        id: `ws-${rh.id}`,
        title: `${rh.name} · Agent 会话`,
        snippet: rh.snippet,
        meta: "工作台",
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
      <div className="qj-bot-dialog" style={{ width: 620, maxWidth: "92vw" }} onClick={(e) => e.stopPropagation()}>
        <div
          style={{
            height: 56,
            padding: "0 16px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            borderBottom: "1px solid var(--qj-border-default)",
          }}
        >
          <BotIcon name="search" />
          <input
            autoFocus
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={`搜索${snapshot.profile.displayName}`}
            style={{
              flex: 1,
              border: 0,
              outline: "none",
              background: "transparent",
              fontSize: 15,
              color: "var(--qj-text-primary)",
            }}
          />
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "4px 10px",
              borderRadius: 9999,
              border: 0,
              fontSize: 11.5,
              background: "var(--muse-soft-fill)",
              color: "var(--qj-text-muted)",
              cursor: "pointer",
            }}
          >
            ESC
          </button>
        </div>

        <div style={{ padding: 12, maxHeight: 400, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ padding: "4px 12px", fontSize: 12, fontWeight: 500, color: "var(--qj-text-muted)" }}>
            {q === "" ? "最近访问与沉淀" : "匹配结果"}
          </div>
          {hits.length === 0 ? (
            <div style={{ padding: "28px 16px", textAlign: "center", fontSize: 13, color: "var(--qj-text-muted)" }}>
              {q === "" ? "暂无会话、空间或文档记录，直接开始对话即可自动沉淀" : "未找到匹配的对话、空间或文档"}
            </div>
          ) : (
            hits.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={it.onSelect}
                style={{
                  width: "100%",
                  border: 0,
                  borderRadius: 16,
                  padding: 12,
                  textAlign: "left",
                  background: "transparent",
                  color: "var(--qj-text-primary)",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--muse-soft-fill)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 520 }}>
                  <span>{it.title}</span>
                  <span style={{ fontSize: 12, fontWeight: 400, color: "var(--qj-text-muted)" }}>· {it.meta}</span>
                </div>
                <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--qj-text-secondary)" }}>{it.snippet}</div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
