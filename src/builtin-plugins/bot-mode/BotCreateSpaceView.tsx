/**
 * 1:1 Meta Muse Split `创建空间` Studio View (`BotCreateSpaceView`).
 *
 * Left `440px` chat-builder column (floating `≡ 聊天`, top circular plush avatar +
 * `千机`, `📞 通话`, bottom `#muse-msg-input` pill composer) + right Space Board canvas.
 */
import { useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { ArrowUpRight, Menu, Phone, Trash2 } from "lucide-react";
import { useFrontendService, type AttachmentPayload } from "@qianji/client";
import { BotChatComposer } from "./BotChatComposer";
import { openBotModal, patchBotUi, useBotController, useBotSnapshot, useBotUiState } from "./botStore";

export function BotCreateSpaceView({
  ctx,
}: {
  readonly ctx?: Context;
  readonly cwd: string;
}): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const navigationService = useFrontendService("navigationService", ctx);
  const [spaceDraft, setSpaceDraft] = useState("");
  const [managing, setManaging] = useState(false);

  const handleSubmit = async (_attachments: AttachmentPayload[]) => {
    const trimmed = spaceDraft.trim();
    if (trimmed === "") return;
    setSpaceDraft("");
    const created = await ctrl.createSpace(trimmed);
    if (created) {
      patchBotUi({ activeSpace: created });
    }
  };

  return (
    <div className="qj-animate-page-in qj-muse-split-shell">
      <div className="qj-muse-split-chat">
        <header className="qj-muse-float-topbar" data-tauri-drag-region="">
          <div className="qj-bot-topbar-left">
            <button
              type="button"
              className="qj-muse-pill-btn"
              onClick={() => patchBotUi({ activeView: "chat", chatDrawerOpen: true })}
            >
              <Menu size={15} strokeWidth={1.85} />
              <span>聊天</span>
            </button>
          </div>

          <div className="qj-bot-topbar-right">
            <button
              type="button"
              className={`qj-muse-pill-btn${ui.voiceCallActive ? " active" : ""}`}
              onClick={() => {
                const next = !ui.voiceCallActive;
                patchBotUi({ voiceCallActive: next });
                navigationService?.showToast(next ? "实时语音模式已开启" : "已结束语音模式", "info");
              }}
            >
              <Phone size={14} strokeWidth={1.85} />
              <span>{ui.voiceCallActive ? "通话中" : "通话"}</span>
            </button>
          </div>
        </header>

        <div className="qj-muse-split-chat-body">
          <div className="qj-muse-split-guide">
            告诉我你想建立什么主题的空间，比如项目追踪看板、资料收藏架或长期实验笔记本。
          </div>
        </div>

        <footer className="qj-bot-docked-footer">
          <BotChatComposer
            draft={spaceDraft}
            quotedText={null}
            isStreaming={false}
            placeholder="我想创建一个空间，关于 "
            onDraftChange={setSpaceDraft}
            onClearQuote={() => undefined}
            onSubmit={handleSubmit}
            onAbort={() => undefined}
            onVoiceHint={() => navigationService?.showToast("请直接输入空间主题，按 Enter 创建", "info")}
          />
        </footer>
      </div>

      <main className="qj-muse-split-canvas">
        <div className="qj-muse-canvas-head">
          <h1 className="qj-muse-doc-title">空间</h1>
          {snapshot.spaces.length > 0 && (
            <button
              type="button"
              className="qj-soft-btn qj-sheet-pill-xs"
              onClick={() => setManaging((v) => !v)}
            >
              {managing ? "完成" : "管理"}
            </button>
          )}
        </div>

        {snapshot.spaces.length === 0 ? (
          <div className="qj-muse-doc-empty">在左侧输入一句话即可生成你的第一个专属空间</div>
        ) : (
          <div className="qj-sanctuary-bento-grid">
            {snapshot.spaces.map((sp) => (
              <div
                key={sp.id}
                onClick={() => {
                  if (managing) return;
                  patchBotUi({ activeSpace: sp });
                  openBotModal("space-detail");
                }}
                className={`qj-soft-card qj-sanctuary-space-card${managing ? " managing" : ""}`}
              >
                <div className="qj-sanctuary-space-meta">
                  <span>常驻空间</span>
                  <div className="qj-sanctuary-space-right">
                    <span>{sp.updatedLabel}</span>
                    {managing && (
                      <button
                        type="button"
                        className="qj-sanctuary-micro-btn danger"
                        title="删除空间"
                        aria-label="删除空间"
                        onClick={(e) => {
                          e.stopPropagation();
                          void ctrl.deleteSpace(sp.id);
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="qj-sanctuary-idea-title">{sp.title}</div>
                <div className="qj-sanctuary-idea-desc">{sp.description}</div>
                <div className="qj-sanctuary-space-foot">
                  <span className="qj-sanctuary-space-metric">{sp.metricBadge}</span>
                  <span className="qj-sanctuary-space-link">
                    <span>打开</span>
                    <ArrowUpRight size={13} />
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
