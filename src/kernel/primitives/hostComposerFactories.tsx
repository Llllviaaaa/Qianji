/**
 * Host-owned production composer factories (`src/kernel/primitives/hostComposerFactories.tsx`, ADR 0023).
 *
 * Bridges Qianji's full-featured composer input (`ComposerSuggestionMenus` for `/` slash
 * commands & `@` workspace file mentions, clipboard image paste, Tauri/HTML5 drag-and-drop
 * onto `[data-composer-card]`, auto-growing `<textarea>`, and `rewindController` text bridge)
 * into `core-composer` via `renderFactory("host.composer.input", ...)` while preserving 100%
 * plugin overridability on `composer.input`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type {
  ClientSlotsService,
  SlotComponentProps,
  SlotFactorySpec,
  SlotRegistry,
} from "@qianji/client-slots";
import { ComposerDirectiveBar } from "../../components/composer/ComposerDirectiveBar";
import { ComposerSuggestionMenus } from "../../components/composer/ComposerSuggestionMenus";
import { useComposerSuggestionsAndDrop } from "../../components/composer/useComposerSuggestionsAndDrop";
import { insertNewlineAtSelection, resolveChatEnterAction } from "../../lib/composerKeys";
import { rewindController } from "../../lib/rewindController";
import { findMentionCandidates } from "../../lib/workspaceSearch";
import { useAppStore } from "../../store";
import type { AttachmentPayload, SlashCommand } from "../../types";
import {
  useComposerState,
  useFrontendService,
  useSessionHandle,
  useSessionState,
  useThemeState,
} from "../../sdk/index";

const HOST_FACTORIES_PLUGIN_ID = "core-host-factories";

export interface HostComposerInputFactoryProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
  readonly sessionKey: string;
  readonly sessionId?: string | null;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly isolated?: boolean;
  readonly quickChat?: boolean;
  readonly onSubmit?: () => void;
}

declare module "@qianji/client-slots" {
  interface SlotFactoryMap {
    "host.composer.input": SlotFactorySpec<HostComposerInputFactoryProps, "root">;
  }
}

function HostComposerInputFactory({
  cwd = "",
  sessionKey,
  sessionId,
  placeholder = "输入消息…",
  disabled = false,
  isolated = false,
  quickChat = false,
  onSubmit,
  ctx,
}: SlotComponentProps<HostComposerInputFactoryProps, "root">): ReactElement {
  const composerService = useFrontendService("composerService", ctx);
  const composerSnap = useComposerState(sessionKey, ctx);
  const sessionState = useSessionState(ctx);
  const themeState = useThemeState(ctx);
  const requireCtrlEnter = themeState?.requireCtrlEnter === true;
  const { snapshot: handleSnap } = useSessionHandle(sessionId ?? null, undefined, ctx);

  const serviceDraft = composerSnap?.draft ?? "";
  const [text, setText] = useState(serviceDraft);
  const [caret, setCaret] = useState(serviceDraft.length);
  const [syncedServiceDraft, setSyncedServiceDraft] = useState(serviceDraft);
  const [externalFocusNonce, setExternalFocusNonce] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestionMenuRef = useRef<HTMLDivElement>(null);
  const textRef = useRef(text);
  const resizeFrameRef = useRef<number | null>(null);

  if (syncedServiceDraft !== serviceDraft) {
    setSyncedServiceDraft(serviceDraft);
    setText(serviceDraft);
    setCaret(serviceDraft.length);
    if (serviceDraft !== "") {
      setExternalFocusNonce((n) => n + 1);
    }
  }

  useEffect(() => {
    textRef.current = text;
  }, [text]);

  // Focus & move caret to end after an external prefill updates the draft.
  useEffect(() => {
    if (externalFocusNonce === 0) return;
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") return;
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el === null) return;
      const targetLen = textRef.current.length;
      el.focus();
      el.setSelectionRange(targetLen, targetLen);
    });
  }, [externalFocusNonce]);

  // Resolve enclosing `[data-composer-card]` so Tauri drag-drop hit-testing covers the full card.
  useEffect(() => {
    const card = rootRef.current?.closest<HTMLDivElement>("[data-composer-card]") ?? rootRef.current;
    cardRef.current = card;
  }, []);

  const updateDraft = useCallback(
    (nextValue: string) => {
      textRef.current = nextValue;
      setText(nextValue);
      setSyncedServiceDraft(nextValue);
      composerService?.setDraft(nextValue, sessionKey);
    },
    [composerService, sessionKey],
  );

  // Bind main composer draft to `rewindController` so `/rewind` restores text & focuses input.
  useEffect(() => {
    if (disabled || isolated) return undefined;
    return rewindController.bindTextBridge({
      getText: () => textRef.current,
      setText: (nextText, focus) => {
        updateDraft(nextText);
        setCaret(nextText.length);
        if (focus && typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
          window.requestAnimationFrame(() => {
            const el = textareaRef.current;
            if (el === null) return;
            el.focus();
            el.setSelectionRange(nextText.length, nextText.length);
          });
        }
      },
    });
  }, [disabled, isolated, updateDraft]);

  // Auto-grow `<textarea>` up to 160px on text changes.
  useEffect(() => {
    const element = textareaRef.current;
    if (element === null || typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      return;
    }
    if (resizeFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeFrameRef.current);
    }
    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
    });
  }, [text]);

  useEffect(
    () => () => {
      if (resizeFrameRef.current !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(resizeFrameRef.current);
      }
    },
    [],
  );

  const commands = useMemo<SlashCommand[]>(() => {
    const raw = composerSnap?.commands ?? sessionState?.commands ?? useAppStore.getState().commands;
    return [...raw];
  }, [composerSnap?.commands, sessionState?.commands]);

  const onAttachFiles = useCallback(
    (paths: string[]) => {
      void composerService?.attachFiles(paths, sessionKey);
    },
    [composerService, sessionKey],
  );

  const onAttachPayloads = useCallback(
    (payloads: AttachmentPayload[]) => {
      composerService?.addAttachments(payloads, sessionKey);
    },
    [composerService, sessionKey],
  );

  const effectiveCwd = cwd.trim();
  const onSearchFiles = useMemo(
    () =>
      effectiveCwd !== "" && !quickChat
        ? (query: string, signal: AbortSignal) => findMentionCandidates(effectiveCwd, query, signal)
        : undefined,
    [effectiveCwd, quickChat],
  );

  const suggest = useComposerSuggestionsAndDrop({
    text,
    setText: updateDraft,
    caret,
    setCaret,
    disabled,
    commands,
    cardRef,
    textareaRef,
    suggestionMenuRef,
    onAttachFiles,
    onAttachPayloads,
    onSearchFiles,
  });

  // Reflect `dragOver` onto `[data-composer-card]` and attach browser HTML5 drop listeners on the card.
  useEffect(() => {
    const card = cardRef.current ?? rootRef.current?.closest<HTMLDivElement>("[data-composer-card]") ?? null;
    if (card === null) return;
    if (suggest.dragOver) {
      card.setAttribute("data-drag-over", "true");
    } else {
      card.removeAttribute("data-drag-over");
    }
    return () => {
      card.removeAttribute("data-drag-over");
    };
  }, [suggest.dragOver]);

  const attachImageFilesRef = useRef(suggest.attachImageFiles);
  useEffect(() => {
    attachImageFilesRef.current = suggest.attachImageFiles;
  }, [suggest.attachImageFiles]);

  const setDragOver = suggest.setDragOver;
  useEffect(() => {
    if (!suggest.browserDrop) return undefined;
    const card = cardRef.current ?? rootRef.current?.closest<HTMLDivElement>("[data-composer-card]") ?? null;
    if (card === null) return undefined;

    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      setDragOver(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (!card.contains(event.relatedTarget as Node | null)) {
        setDragOver(false);
      }
    };
    const onDrop = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      setDragOver(false);
      void attachImageFilesRef.current(Array.from(event.dataTransfer.files));
    };

    card.addEventListener("dragover", onDragOver);
    card.addEventListener("dragleave", onDragLeave);
    card.addEventListener("drop", onDrop);
    return () => {
      card.removeEventListener("dragover", onDragOver);
      card.removeEventListener("dragleave", onDragLeave);
      card.removeEventListener("drop", onDrop);
    };
  }, [setDragOver, suggest.browserDrop]);

  const isStreaming = handleSnap !== null ? handleSnap.isStreaming : (sessionState?.isStreaming ?? false);
  const menuOpen = suggest.commandMenuOpen || suggest.mentionMenuOpen;
  const activeDescendant =
    menuOpen && suggest.suggestionCount > 0
      ? `${suggest.suggestionsId}-${Math.min(suggest.suggestionIndex, suggest.suggestionCount - 1)}`
      : undefined;

  return (
    <div
      ref={rootRef}
      className="composer-input-slot"
      data-slot="composer.input"
      data-session-key={sessionKey}
    >
      <ComposerSuggestionMenus
        commandMenuOpen={suggest.commandMenuOpen}
        commandQuery={suggest.commandQuery}
        commandMatches={suggest.commandMatches}
        activeCommand={suggest.activeCommand}
        chooseCommand={suggest.chooseCommand}
        mentionMenuOpen={suggest.mentionMenuOpen}
        mentionQuery={suggest.mentionQuery}
        mentionEntries={suggest.mentionEntries}
        mentionLoading={suggest.mentionLoading}
        activeEntry={suggest.activeEntry}
        chooseEntry={suggest.chooseEntry}
        suggestionsId={suggest.suggestionsId}
        suggestionMenuRef={suggestionMenuRef}
        setSuggestionIndex={suggest.setSuggestionIndex}
      />

      <ComposerDirectiveBar
        text={text}
        commands={commands}
        suppress={suggest.commandMenuOpen}
        onClear={(remaining) => {
          updateDraft(remaining);
          setCaret(remaining.length);
          window.requestAnimationFrame(() => textareaRef.current?.focus());
        }}
      />

      <div className="dsh-claude-input-box" data-input-scroll="" onClick={() => textareaRef.current?.focus()}>
        <textarea
          ref={textareaRef}
          value={text}
          rows={1}
          disabled={disabled}
          className="composer-input"
          data-testid="composer-textarea"
          data-phase={isStreaming ? "streaming" : "idle"}
          data-session-key={sessionKey}
          placeholder={placeholder}
          role="combobox"
          aria-label="对话输入框"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? suggest.suggestionsId : undefined}
          aria-activedescendant={activeDescendant}
          aria-autocomplete="list"
          onChange={(event) => {
            updateDraft(event.target.value);
            setCaret(event.target.selectionStart);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onPaste={suggest.handlePaste}
          onKeyDown={(event) => {
            if (menuOpen && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                suggest.setSuggestionsDismissedFor(text);
                return;
              }
              if (suggest.suggestionCount > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                suggest.setSuggestionIndex(
                  (idx) => (Math.min(idx, suggest.suggestionCount - 1) + step + suggest.suggestionCount) % suggest.suggestionCount,
                );
                return;
              }
            }

            const action = resolveChatEnterAction(
              {
                key: event.key,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                shiftKey: event.shiftKey,
                altKey: event.altKey,
                isComposing: event.nativeEvent.isComposing,
                keyCode: event.nativeEvent.keyCode,
                defaultPrevented: event.defaultPrevented,
              },
              { requireCtrlEnter, hasActiveSuggestion: menuOpen && suggest.suggestionCount > 0 },
            );

            if (action === "accept-suggestion") {
              event.preventDefault();
              if (suggest.activeCommand !== undefined) {
                suggest.chooseCommand(suggest.activeCommand);
              } else if (suggest.activeEntry !== undefined) {
                suggest.chooseEntry(suggest.activeEntry, event.key === "Tab");
              }
              return;
            }
            if (action === "submit") {
              event.preventDefault();
              onSubmit?.();
              textareaRef.current?.focus();
              return;
            }
            if (action === "insert-newline") {
              event.preventDefault();
              const next = insertNewlineAtSelection(
                text,
                event.currentTarget.selectionStart,
                event.currentTarget.selectionEnd,
              );
              updateDraft(next.value);
              setCaret(next.caret);
              if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
                window.requestAnimationFrame(() => {
                  const el = textareaRef.current;
                  if (el !== null) {
                    el.setSelectionRange(next.caret, next.caret);
                  }
                });
              }
            }
          }}
        />
      </div>
    </div>
  );
}

export function registerHostComposerFactories(
  target: Pick<SlotRegistry, "registerFactory"> | Pick<ClientSlotsService, "registerFactory">,
): Array<() => void> {
  return [
    target.registerFactory("host.composer.input", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:composer-input`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostComposerInputFactory,
    }),
  ];
}
