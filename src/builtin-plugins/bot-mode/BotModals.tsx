/** 1:1 Meta Muse Modal Overlays (`src/builtin-plugins/bot-mode/BotModals.tsx`). */
import { useEffect, useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { X } from "lucide-react";
import { useFrontendService } from "@qianji/client";
import type { BoundRenderFactoryFn } from "@qianji/client-slots";
import { BotActivityDetailModal } from "./BotActivityDetailModal";
import { BotLiveViewModal } from "./BotLiveViewModal";
import { BotScheduledModal } from "./BotScheduledModal";
import { BotSearchDialog } from "./BotSearchDialog";
import { BotSettingsShell } from "./BotSettingsShell";
import {
  closeActiveBotModal,
  useBotController,
  useBotSnapshot,
  useBotUiState,
} from "./botStore";
import { useLive2DDirectorState } from "./live2d/live2dDirectorStore";
import { Live2DShowcaseModal } from "./live2d/Live2DShowcaseModal";

function CloseCircleBtn({ label, onClick }: { readonly label: string; readonly onClick: () => void }): ReactElement {
  return (
    <button type="button" aria-label={label} className="qj-muse-modal-close" onClick={onClick}>
      <X size={16} strokeWidth={1.85} />
    </button>
  );
}

function MarkdownContractEditor({
  title,
  initialValue,
  onSave,
  onClose,
}: {
  readonly title: string;
  readonly initialValue: string;
  readonly onSave: (next: string) => void;
  readonly onClose: () => void;
}): ReactElement {
  const [draft, setDraft] = useState(initialValue);

  return (
    <div className="qj-bot-dialog qj-muse-editor-modal" onClick={(e) => e.stopPropagation()}>
      <div className="qj-muse-modal-head">
        <div className="qj-muse-modal-title">{title}</div>
        <CloseCircleBtn label="关闭编辑器" onClick={onClose} />
      </div>

      <textarea
        rows={10}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="qj-muse-contract-textarea"
      />

      <div className="qj-muse-modal-foot">
        <button type="button" className="qj-soft-btn qj-sheet-pill-xs" onClick={onClose}>
          取消
        </button>
        <button type="button" className="qj-muse-blue-pill-btn sm" onClick={() => onSave(draft)}>
          保存
        </button>
      </div>
    </div>
  );
}

export function BotModals({
  ctx,
  renderFactory,
}: {
  readonly ctx?: Context;
  readonly renderFactory?: BoundRenderFactoryFn;
}): ReactElement | null {
  const ui = useBotUiState();
  const director = useLive2DDirectorState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const navigationService = useFrontendService("navigationService", ctx);
  const [issueText, setIssueText] = useState("");

  useEffect(() => {
    if (ui.modal === null || director.showcaseOpen || typeof window === "undefined") {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (typeof document !== "undefined" && document.querySelector("[data-escape-layer]") !== null) {
          return;
        }
        closeActiveBotModal();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [director.showcaseOpen, ui.modal]);

  if (director.showcaseOpen) {
    return <Live2DShowcaseModal ctx={ctx} />;
  }

  if (ui.modal === null) return null;

  const closeModal = () => closeActiveBotModal();

  if (ui.modal === "search") {
    return <BotSearchDialog key={`search-${ui.modalNonce}`} ctx={ctx} onClose={closeModal} />;
  }

  if (ui.modal === "scheduled") {
    return <BotScheduledModal key={`sched-${ui.modalNonce}`} ctx={ctx} />;
  }

  if (ui.modal === "activity-detail") {
    return <BotActivityDetailModal key={`act-${ui.modalNonce}`} ctx={ctx} />;
  }

  if (ui.modal === "soul" || ui.modal === "memory") {
    const isSoul = ui.modal === "soul";
    return (
      <div className="qj-bot-modal-backdrop" onClick={closeModal}>
        <MarkdownContractEditor
          key={`${ui.modal}-${ui.modalNonce}`}
          title={isSoul ? "SOUL.md" : "记忆 (MEMORY.md)"}
          initialValue={isSoul ? snapshot.soulContent : ui.memoryContent}
          onClose={closeModal}
          onSave={(next) => {
            if (isSoul) void ctrl.saveSoul(next);
            else void ctrl.saveMemory(next);
            closeModal();
          }}
        />
      </div>
    );
  }

  if (ui.modal === "shortcuts") {
    const rows: ReadonlyArray<readonly [string, string]> = [
      ["展开 / 收起左侧面板", "Ctrl + B"],
      ["展开 / 收起旁聊抽屉", "Ctrl + J"],
      ["全局搜索", "Ctrl + K"],
      ["打开设置", "Ctrl + ,"],
      ["丝滑切换 Agent / Bot", "Ctrl + Shift + M"],
      ["紧急安全模式（暂停外部插件）", "Ctrl + Shift + Alt + R"],
    ];
    return (
      <div className="qj-bot-modal-backdrop" onClick={closeModal}>
        <div className="qj-bot-dialog qj-muse-compact-modal" onClick={(e) => e.stopPropagation()}>
          <div className="qj-muse-modal-head">
            <span className="qj-muse-modal-title">键盘快捷键</span>
            <CloseCircleBtn label="关闭快捷键" onClick={closeModal} />
          </div>
          <div className="qj-muse-shortcut-list">
            {rows.map(([label, chord]) => (
              <div key={label} className="qj-muse-shortcut-row">
                <span>{label}</span>
                <kbd>{chord}</kbd>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (ui.modal === "live-view") {
    return <BotLiveViewModal ctx={ctx} onClose={closeModal} />;
  }

  if (ui.modal === "doc-preview" && ui.activeDoc !== null) {
    const doc = ui.activeDoc;
    return (
      <div className="qj-bot-modal-backdrop" onClick={closeModal}>
        <div className="qj-bot-dialog qj-muse-editor-modal" onClick={(e) => e.stopPropagation()}>
          <div className="qj-muse-modal-head">
            <div>
              <div className="qj-muse-modal-title">{doc.name}</div>
              <div className="qj-muse-modal-sub">
                {doc.sizeLabel} · {doc.updatedLabel}
              </div>
            </div>
            <CloseCircleBtn label="关闭文档预览" onClick={closeModal} />
          </div>
          <pre className="qj-muse-doc-pre">{doc.content}</pre>
          <div className="qj-muse-modal-foot">
            {doc.path && (
              <button
                type="button"
                className="qj-muse-blue-pill-btn sm"
                onClick={() => {
                  closeModal();
                  ctrl.triggerHandoff({
                    id: `doc-${doc.id}`,
                    title: doc.name,
                    kindLabel: "沉淀文档",
                    summary: `从 Bot 资源库打开文档：${doc.name}`,
                    targetCwd: "",
                    highlightFile: doc.path,
                  });
                }}
              >
                在 Agent 工作台中打开
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (ui.modal === "space-detail" && ui.activeSpace !== null) {
    const sp = ui.activeSpace;
    return (
      <div className="qj-bot-modal-backdrop" onClick={closeModal}>
        <div className="qj-bot-dialog qj-muse-editor-modal" onClick={(e) => e.stopPropagation()}>
          <div className="qj-muse-modal-head">
            <div>
              <div className="qj-muse-modal-title">{sp.title}</div>
              <div className="qj-muse-modal-sub">更新于 {sp.updatedLabel}</div>
            </div>
            <CloseCircleBtn label="关闭空间详情" onClick={closeModal} />
          </div>
          <div className="qj-muse-space-detail-box">{sp.description}</div>
          <div className="qj-muse-modal-foot">
            <button
              type="button"
              className="qj-soft-btn qj-sheet-pill-xs"
              onClick={() => ctrl.jumpToChatWithPrompt(`继续推进空间「${sp.title}」的下一步计划：`)}
            >
              在主聊天中推进
            </button>
            <button
              type="button"
              className="qj-muse-blue-pill-btn sm"
              onClick={() => {
                closeModal();
                ctrl.triggerHandoff(
                  sp.handoff ?? {
                    id: sp.id,
                    title: sp.title,
                    kindLabel: "常驻空间",
                    summary: sp.description,
                    targetCwd: "",
                  },
                );
              }}
            >
              在 Agent 工作台中打开 ↗
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (ui.modal === "report-issue") {
    return (
      <div className="qj-bot-modal-backdrop" onClick={closeModal}>
        <div className="qj-bot-dialog qj-muse-compact-modal" onClick={(e) => e.stopPropagation()}>
          <div className="qj-muse-modal-head">
            <span className="qj-muse-modal-title">报告问题</span>
            <CloseCircleBtn label="关闭反馈" onClick={closeModal} />
          </div>
          <textarea
            rows={5}
            value={issueText}
            onChange={(e) => setIssueText(e.target.value)}
            placeholder="请描述你遇到的问题或建议…"
            className="qj-muse-contract-textarea"
          />
          <div className="qj-muse-modal-foot">
            <button type="button" className="qj-soft-btn qj-sheet-pill-xs" onClick={closeModal}>
              取消
            </button>
            <button
              type="button"
              className="qj-muse-blue-pill-btn sm"
              disabled={issueText.trim() === ""}
              onClick={() => {
                setIssueText("");
                closeModal();
                navigationService?.showToast("感谢反馈，问题记录已保存至本地诊断日志", "info");
              }}
            >
              提交
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <BotSettingsShell ctx={ctx} renderFactory={renderFactory} onClose={closeModal} />;
}
