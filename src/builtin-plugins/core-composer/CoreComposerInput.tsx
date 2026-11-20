/**
 * Built-in default `composer.input` slot component (ADR 0023 `core-composer`).
 *
 * Syncs draft edits with `composerService` while also holding local React
 * state so draft text survives both `overlay: true` chain takeover under
 * `display: none` and standalone rendering.
 */
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  useComposerState,
  useFrontendService,
  useSessionHandle,
  useSessionState,
  useThemeState,
} from "@qianji/client";
import type { ComposerInputSlotProps, SlotComponentProps } from "@qianji/client-slots";
import {
  extractLeadingSlashQuery,
  insertNewlineAtSelection,
  resolveChatEnterAction,
  resolveComposerSessionKey,
} from "./composerHelpers";

export function CoreComposerInput({
  placeholder = "输入消息…",
  disabled = false,
  sessionKey,
  sessionFile,
  sessionId,
  onSubmit,
}: SlotComponentProps<ComposerInputSlotProps, "session-maybe">): ReactNode {
  const composerService = useFrontendService("composerService");
  const resolvedKey = resolveComposerSessionKey(sessionKey, sessionId, sessionFile);
  const composerSnap = useComposerState(resolvedKey);
  const sessionState = useSessionState();
  const themeState = useThemeState();
  const requireCtrlEnter = themeState?.requireCtrlEnter === true;
  const { snapshot: handleSnap } = useSessionHandle(sessionId);

  const serviceDraft = composerSnap?.draft ?? "";
  const [text, setText] = useState(serviceDraft);
  const [syncedServiceDraft, setSyncedServiceDraft] = useState(serviceDraft);
  const [activeSuggestionIdx, setActiveSuggestionIdx] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestionsId = useId();

  if (syncedServiceDraft !== serviceDraft) {
    setSyncedServiceDraft(serviceDraft);
    setText(serviceDraft);
  }

  const isStreaming = handleSnap !== null ? handleSnap.isStreaming : (sessionState?.isStreaming ?? false);
  const composerCommands = composerSnap?.commands;
  const sessionCommands = sessionState?.commands;
  const slashQuery = extractLeadingSlashQuery(text);
  const commandMatches = useMemo(() => {
    if (slashQuery === null) return [];
    const commands = composerCommands ?? sessionCommands ?? [];
    const normalized = slashQuery.toLowerCase();
    return commands
      .filter((cmd) => normalized === "" || cmd.name.toLowerCase().includes(normalized))
      .slice(0, 20);
  }, [composerCommands, sessionCommands, slashQuery]);

  const menuOpen = !disabled && slashQuery !== null && dismissedFor !== text && commandMatches.length > 0;
  const clampedIndex = commandMatches.length > 0 ? Math.min(activeSuggestionIdx, commandMatches.length - 1) : 0;
  const activeCommand = menuOpen ? commandMatches[clampedIndex] : undefined;

  const updateDraft = (nextValue: string) => {
    setText(nextValue);
    setSyncedServiceDraft(nextValue);
    composerService?.setDraft(nextValue, resolvedKey);
  };

  const applyCommand = (name: string) => {
    const nextValue = `/${name} `;
    setDismissedFor(null);
    updateDraft(nextValue);
    textareaRef.current?.focus();
  };

  return (
    <div className="composer-input-slot" data-slot="composer.input" data-session-key={resolvedKey}>
      {menuOpen && (
        <div className="command-menu" role="listbox" id={suggestionsId} aria-label="快捷指令">
          {commandMatches.map((command, index) => {
            const isActive = index === clampedIndex;
            return (
              <button
                key={`${command.source}-${command.name}`}
                id={`${suggestionsId}-${index}`}
                type="button"
                role="option"
                aria-selected={isActive}
                className={`command-menu-item${isActive ? " active" : ""}`}
                onMouseEnter={() => setActiveSuggestionIdx(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => applyCommand(command.name)}
              >
                <span className="command-item-name">/{command.name}</span>
                {command.description !== undefined && command.description !== "" && (
                  <span className="command-item-desc">{command.description}</span>
                )}
                <span className="command-item-source">
                  {command.source === "skill"
                    ? "技能"
                    : command.source === "prompt"
                      ? "模板"
                      : command.source === "extension"
                        ? "扩展"
                        : "内置"}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="dsh-claude-input-box" data-input-scroll="" onClick={() => textareaRef.current?.focus()}>
        <textarea
          ref={textareaRef}
          value={text}
          rows={1}
          disabled={disabled}
          className="composer-input"
          data-testid="composer-textarea"
          data-phase={isStreaming ? "streaming" : "idle"}
          data-session-key={resolvedKey}
          placeholder={placeholder}
          role="combobox"
          aria-label="对话输入框"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? suggestionsId : undefined}
          aria-activedescendant={menuOpen ? `${suggestionsId}-${clampedIndex}` : undefined}
          aria-autocomplete="list"
          onChange={(event) => {
            setDismissedFor(null);
            updateDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (menuOpen && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setDismissedFor(text);
                return;
              }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const delta = event.key === "ArrowDown" ? 1 : -1;
                setActiveSuggestionIdx(
                  (idx) => (Math.min(idx, commandMatches.length - 1) + delta + commandMatches.length) % commandMatches.length,
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
              { requireCtrlEnter, hasActiveSuggestion: menuOpen },
            );

            if (action === "accept-suggestion" && activeCommand !== undefined) {
              event.preventDefault();
              applyCommand(activeCommand.name);
              return;
            }
            if (action === "submit") {
              event.preventDefault();
              onSubmit?.();
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
