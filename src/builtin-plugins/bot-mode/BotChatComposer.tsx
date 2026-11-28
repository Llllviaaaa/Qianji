/**
 * Meta Muse + ChatGPT + Grok Floating Pill Composer (`BotChatComposer.tsx`).
 *
 * `+` button opens a rich popover menu (`上传文件或图片`, connected/quick `@App`
 * connector toggles, and `+ 连接更多应用…`) with selected `@App` chips inline.
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { ArrowUp, Check, LayoutGrid, Mic, Paperclip, Plus, Sparkles, Square, X } from "lucide-react";
import type { AttachmentPayload } from "@qianji/client";
import { ConnectorBrandIcon } from "./BotConnectorLogos";
import {
  BotActiveDirectiveChip,
  BotSlashPopover,
  extractCommittedDraftDirective,
  filterBotSlashCommands,
  type BotSlashCommandItem,
} from "./BotSlashPopover";

export interface ComposerAppItem {
  readonly id: string;
  readonly name: string;
  readonly connected: boolean;
}

export interface BotChatComposerProps {
  readonly draft: string;
  readonly quotedText: string | null;
  readonly isStreaming: boolean;
  readonly placeholder?: string;
  readonly commands?: readonly BotSlashCommandItem[];
  readonly availableApps?: readonly ComposerAppItem[];
  readonly selectedApps?: readonly string[];
  readonly onToggleApp?: (appId: string) => void;
  readonly onOpenConnectors?: () => void;
  readonly onDraftChange: (next: string) => void;
  readonly onClearQuote: () => void;
  readonly onSubmit: (attachments: AttachmentPayload[]) => Promise<void>;
  readonly onAbort: () => void;
  readonly onVoiceHint: () => void;
}

export function BotChatComposer({
  draft,
  quotedText,
  isStreaming,
  placeholder = "输入消息，或输入 / 调用技能与指令",
  commands = [],
  availableApps = [],
  selectedApps = [],
  onToggleApp,
  onOpenConnectors,
  onDraftChange,
  onClearQuote,
  onSubmit,
  onAbort,
  onVoiceHint,
}: BotChatComposerProps): ReactElement {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const plusAnchorRef = useRef<HTMLDivElement | null>(null);
  const [attachments, setAttachments] = useState<AttachmentPayload[]>([]);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [dismissedSlashDraft, setDismissedSlashDraft] = useState<string | null>(null);
  const slashListboxId = useId();

  const slashQuery =
    draft.startsWith("/") && !draft.includes(" ") && !draft.includes("\n")
      ? draft.slice(1)
      : null;
  const slashMatches = useMemo(
    () => filterBotSlashCommands(commands, slashQuery),
    [commands, slashQuery],
  );
  const slashOpen =
    slashQuery !== null && slashMatches.length > 0 && dismissedSlashDraft !== draft;
  const clampedSlashIdx = slashMatches.length > 0 ? Math.min(slashIndex, slashMatches.length - 1) : 0;
  const activeDirective = useMemo(
    () => (slashOpen ? null : extractCommittedDraftDirective(draft, commands)),
    [commands, draft, slashOpen],
  );

  const selectSlashCommand = (cmd: BotSlashCommandItem) => {
    const next = `/${cmd.name} `;
    setDismissedSlashDraft(null);
    setSlashIndex(0);
    onDraftChange(next);
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(next.length, next.length);
      });
    }
  };

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(24, Math.min(el.scrollHeight, 140))}px`;
  }, [draft]);

  useEffect(() => {
    if (!plusMenuOpen || typeof document === "undefined" || typeof window === "undefined") {
      return undefined;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (plusAnchorRef.current && !plusAnchorRef.current.contains(event.target as Node)) {
        setPlusMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPlusMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown as unknown as EventListener);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown as unknown as EventListener);
    };
  }, [plusMenuOpen]);

  const handleFilesSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    const loaded: AttachmentPayload[] = [];
    for (const file of Array.from(files)) {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 1) {
        binary += String.fromCharCode(bytes[i] ?? 0);
      }
      const isImg = file.type.startsWith("image/");
      loaded.push({
        path: file.name,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        kind: isImg ? "image" : "text",
        ...(isImg ? { data: btoa(binary) } : { text: await file.text().catch(() => "") }),
      });
    }
    setAttachments((prev) => [...prev, ...loaded]);
    event.target.value = "";
  };

  const submitCurrent = async (event?: FormEvent) => {
    event?.preventDefault();
    if (draft.trim() === "" && attachments.length === 0) return;
    const queued = attachments;
    setAttachments([]);
    setPlusMenuOpen(false);
    await onSubmit(queued);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (slashOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedSlashDraft(draft);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setSlashIndex((idx) => (Math.min(idx, slashMatches.length - 1) + step + slashMatches.length) % slashMatches.length);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        const picked = slashMatches[clampedSlashIdx];
        if (picked !== undefined) {
          event.preventDefault();
          selectSlashCommand(picked);
          return;
        }
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitCurrent();
    }
  };

  const hasDraft = draft.trim() !== "" || attachments.length > 0;
  const connectedItems = availableApps.filter((a) => a.connected);
  const menuApps = (connectedItems.length > 0 ? connectedItems : availableApps).slice(0, 6);

  return (
    <div className="qj-bot-composer-wrap">
      <form className="qj-muse-pill-composer" onSubmit={(e) => void submitCurrent(e)}>
        {slashOpen && (
          <BotSlashPopover
            matches={slashMatches}
            activeIndex={clampedSlashIdx}
            query={slashQuery ?? ""}
            listboxId={slashListboxId}
            onHoverIndex={setSlashIndex}
            onSelect={selectSlashCommand}
          />
        )}

        {quotedText !== null && (
          <div className="qj-sanctuary-quote-bar">
            <span className="qj-sanctuary-quote-text">回复：{quotedText}</span>
            <button
              type="button"
              className="qj-sanctuary-micro-btn"
              aria-label="取消引用"
              onClick={onClearQuote}
            >
              <X size={12} />
            </button>
          </div>
        )}

        {(activeDirective !== null || attachments.length > 0 || selectedApps.length > 0) && (
          <div className="qj-sanctuary-attachment-row">
            {activeDirective !== null && (
              <BotActiveDirectiveChip
                directive={activeDirective}
                onClear={() => {
                  onDraftChange(activeDirective.remainingDraft);
                  textareaRef.current?.focus();
                }}
              />
            )}
            {selectedApps.map((appId) => {
              const info = availableApps.find((a) => a.id === appId);
              return (
                <span key={appId} className="qj-composer-app-chip" data-testid={`composer-app-chip-${appId}`}>
                  <ConnectorBrandIcon id={appId} size={15} />
                  <span>@{info?.name ?? appId}</span>
                  <button
                    type="button"
                    aria-label={`取消关联 ${info?.name ?? appId}`}
                    onClick={() => onToggleApp?.(appId)}
                  >
                    ×
                  </button>
                </span>
              );
            })}
            {attachments.map((att, idx) => (
              <span key={`${att.fileName}-${idx}`} className="qj-sanctuary-attachment-chip">
                <Paperclip size={11} />
                <span>{att.fileName}</span>
                <button
                  type="button"
                  aria-label={`移除 ${att.fileName}`}
                  onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== idx))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="qj-muse-composer-row">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => void handleFilesSelected(e)}
          />

          <div ref={plusAnchorRef} className="qj-composer-plus-anchor">
            <button
              type="button"
              data-testid="composer-plus-btn"
              className="qj-muse-composer-icon-btn"
              title="添加文件与连接器"
              aria-label="添加文件与连接器"
              aria-expanded={plusMenuOpen}
              onClick={() => setPlusMenuOpen((v) => !v)}
            >
              <Plus size={19} strokeWidth={1.85} />
            </button>

            {plusMenuOpen && (
              <div className="qj-composer-plus-popover" role="menu" aria-label="添加内容与连接器">
                <button
                  type="button"
                  role="menuitem"
                  className="qj-composer-plus-item"
                  onClick={() => {
                    setPlusMenuOpen(false);
                    fileInputRef.current?.click();
                  }}
                >
                  <Paperclip size={15} />
                  <span>添加图片与本地文件</span>
                </button>

                {commands.length > 0 && (
                  <button
                    type="button"
                    role="menuitem"
                    className="qj-composer-plus-item"
                    onClick={() => {
                      setPlusMenuOpen(false);
                      setDismissedSlashDraft(null);
                      setSlashIndex(0);
                      onDraftChange("/");
                      window.requestAnimationFrame(() => textareaRef.current?.focus());
                    }}
                  >
                    <Sparkles size={15} />
                    <span className="qj-composer-plus-name">调用技能与快捷指令</span>
                    <span className="qj-conn-mini-tag">/</span>
                  </button>
                )}

                {menuApps.length > 0 && (
                  <>
                    <div className="qj-bot-menu-sep" />
                    <div className="qj-composer-plus-section">
                      {connectedItems.length > 0 ? "使用已连接应用" : "快捷接入应用"}
                    </div>
                    {menuApps.map((app) => {
                      const active = selectedApps.includes(app.id);
                      return (
                        <button
                          key={app.id}
                          type="button"
                          role="menuitem"
                          className={`qj-composer-plus-item${active ? " active" : ""}`}
                          onClick={() => {
                            if (app.connected) {
                              onToggleApp?.(app.id);
                            } else {
                              onOpenConnectors?.();
                            }
                            setPlusMenuOpen(false);
                          }}
                        >
                          <ConnectorBrandIcon id={app.id} size={20} />
                          <span className="qj-composer-plus-name">{app.name}</span>
                          {app.connected ? (
                            active ? <Check size={14} color="var(--qj-brand-primary)" /> : <span className="qj-conn-mini-tag">可用</span>
                          ) : (
                            <span className="qj-conn-mini-tag">连接</span>
                          )}
                        </button>
                      );
                    })}
                  </>
                )}

                {onOpenConnectors && (
                  <>
                    <div className="qj-bot-menu-sep" />
                    <button
                      type="button"
                      role="menuitem"
                      className="qj-composer-plus-item"
                      onClick={() => {
                        setPlusMenuOpen(false);
                        onOpenConnectors();
                      }}
                    >
                      <LayoutGrid size={15} />
                      <span>浏览并添加更多连接器…</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          <textarea
            ref={textareaRef}
            id="muse-msg-input"
            rows={1}
            role="combobox"
            aria-expanded={slashOpen}
            aria-controls={slashOpen ? slashListboxId : undefined}
            aria-activedescendant={slashOpen ? `${slashListboxId}-${clampedSlashIdx}` : undefined}
            aria-label="消息输入框"
            className="qj-sanctuary-composer-input"
            placeholder={placeholder}
            value={draft}
            onChange={(e) => {
              setDismissedSlashDraft(null);
              setSlashIndex(0);
              onDraftChange(e.target.value);
            }}
            onKeyDown={handleKeyDown}
          />

          <button
            type="button"
            title="语音输入"
            aria-label="语音输入"
            className="qj-muse-composer-icon-btn"
            onClick={onVoiceHint}
          >
            <Mic size={17} strokeWidth={1.85} />
          </button>

          {isStreaming ? (
            <button
              type="button"
              title="停止生成"
              aria-label="停止生成"
              className="qj-muse-send-circle stop"
              onClick={onAbort}
            >
              <Square size={11} fill="currentColor" />
            </button>
          ) : hasDraft ? (
            <button
              type="submit"
              title="发送"
              aria-label="发送消息"
              className="qj-muse-send-circle active"
            >
              <ArrowUp size={16} strokeWidth={2.2} />
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
