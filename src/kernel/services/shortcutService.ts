/**
 * Frontend Cordis `shortcutService` (ADR 0023 Phase 2).
 *
 * Global keybinding registry supporting explicit priority, `allowInEditable`,
 * dynamic context predicates (`when`), reserved Safe Mode chord exclusion
 * (`Ctrl+Shift+Alt+R` / `Cmd+Shift+Alt+R`), guarded callback execution, and
 * automatic Cordis Fiber disposal.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import { recordClientRenderError, resolveContextPluginId } from "../../lib/clientPluginRuntime";
import {
  keyChordFromEvent,
  normalizeKeyChord,
  runPluginCallback,
} from "../../lib/pluginKeybindings";
import { useAppStore } from "../../store";
import { ServiceEmitter, trackContextEffect } from "./shared";

declare module "@deepseek-ai/cordis" {
  interface Context {
    shortcutService: ShortcutService;
  }
}

/** Reserved Safe Mode emergency recovery chord (ADR 0023 §5.2): Ctrl+Shift+Alt+R / Cmd+Shift+Alt+R. */
export const RESERVED_SAFE_MODE_CHORD = "ctrl+alt+shift+r";

const RESERVED_SHORTCUT_CHORDS: ReadonlySet<string> = new Set([RESERVED_SAFE_MODE_CHORD]);
const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable="true"], [contenteditable=""], .cm-editor, .xterm';
const TERMINAL_SELECTOR = ".xterm";
const RECORDER_SELECTOR = '[data-shortcut-recorder="true"]';

export function isReservedShortcutChord(chord: string): boolean {
  const normalized = normalizeKeyChord(chord);
  return normalized !== "" && RESERVED_SHORTCUT_CHORDS.has(normalized);
}

export interface ShortcutContext {
  readonly cwd: string;
  readonly sessionFile: string | null;
  readonly inEditable: boolean;
  readonly inTerminal: boolean;
  readonly event: KeyboardEvent;
}

export interface ShortcutRegistration {
  id: string;
  pluginId?: string;
  /** Key chord such as `"Ctrl+Shift+K"`, `"Cmd+K"`, `"Alt+F2"`, or `"F6"`. */
  key: string;
  label?: string;
  /** Higher priority matches first (default `0`). Ties break by lower `order` (default `100`), then `id`. */
  priority?: number;
  order?: number;
  /** Allow firing while focus is in an input/textarea/CodeMirror/terminal (default `false`). */
  allowInEditable?: boolean;
  /** Optional dynamic context matcher; throwing predicates fail closed and are reported. */
  when?: (context: ShortcutContext) => boolean;
  run: (context: ShortcutContext) => void | Promise<void>;
}

export interface ShortcutEntry extends ShortcutRegistration {
  readonly normalizedKey: string;
  readonly priority: number;
  readonly order: number;
  readonly allowInEditable: boolean;
}

export interface ShortcutServiceSnapshot {
  readonly shortcuts: readonly ShortcutEntry[];
}

export interface ShortcutServiceOptions {
  /** Target to attach the global `keydown` listener to. Defaults to `window` when present; pass `null` to disable auto-attach. */
  target?: EventTarget | null;
}

interface ClosestCapable {
  closest: (selector: string) => unknown;
}

function asClosestCapable(target: EventTarget | null): ClosestCapable | null {
  if (typeof target !== "object" || target === null) return null;
  const candidate = target as { closest?: unknown };
  return typeof candidate.closest === "function" ? (candidate as ClosestCapable) : null;
}

function sortShortcuts(entries: Iterable<ShortcutEntry>): ShortcutEntry[] {
  return [...entries].sort(
    (left, right) =>
      right.priority - left.priority
      || left.order - right.order
      || left.id.localeCompare(right.id),
  );
}

interface ShortcutInternalState {
  readonly entries: Map<string, ShortcutEntry>;
  snapshot: ShortcutServiceSnapshot;
  readonly emitter: ServiceEmitter;
}

export class ShortcutService extends Service {
  static provide = "shortcutService";
  private readonly internal: ShortcutInternalState;

  constructor(ctx: Context, options?: ShortcutServiceOptions) {
    super(ctx, "shortcutService");
    this.internal = {
      entries: new Map(),
      snapshot: { shortcuts: [] },
      emitter: new ServiceEmitter("shortcutService"),
    };

    const target = options !== undefined && "target" in options
      ? options.target
      : (typeof window !== "undefined" ? window : null);

    let detachTarget: (() => void) | undefined;
    if (target !== null && target !== undefined) {
      const listener = (event: Event) => {
        this.dispatch(event as KeyboardEvent);
      };
      target.addEventListener("keydown", listener);
      detachTarget = () => target.removeEventListener("keydown", listener);
    }

    ctx.effect(() => () => {
      detachTarget?.();
      this.internal.entries.clear();
      this.internal.snapshot = { shortcuts: [] };
      this.internal.emitter.clear();
    });
  }

  private rebuildSnapshot(): void {
    this.internal.snapshot = {
      shortcuts: sortShortcuts(this.internal.entries.values()),
    };
    this.internal.emitter.emit();
  }

  getSnapshot(): ShortcutServiceSnapshot {
    return this.internal.snapshot;
  }

  subscribe(listener: () => void): () => void {
    const rawUnsub = this.internal.emitter.add(listener);
    return trackContextEffect(this.ctx, rawUnsub);
  }

  /** Attach an additional `keydown` dispatch target, automatically removed on Fiber disposal. */
  attach(target: EventTarget): () => void {
    const listener = (event: Event) => {
      this.dispatch(event as KeyboardEvent);
    };
    target.addEventListener("keydown", listener);
    return trackContextEffect(this.ctx, () => {
      target.removeEventListener("keydown", listener);
    });
  }

  /**
   * Register a global shortcut. Reserved Safe Mode chords (`Ctrl+Shift+Alt+R`)
   * are rejected and never override the un-overridable Safe Mode capture path.
   */
  register(registration: ShortcutRegistration): () => void {
    const normalizedKey = normalizeKeyChord(registration.key);
    if (normalizedKey === "") {
      console.warn(`[qianji-services:shortcutService] ignoring invalid keybinding "${registration.id}" ("${registration.key}")`);
      return () => undefined;
    }
    if (RESERVED_SHORTCUT_CHORDS.has(normalizedKey)) {
      console.warn(
        `[qianji-services:shortcutService] refusing reserved Safe Mode chord "${registration.key}" for "${registration.id}"`,
      );
      return () => undefined;
    }
    const pluginId = registration.pluginId ?? resolveContextPluginId(this.ctx);
    const entry: ShortcutEntry = {
      ...registration,
      ...(pluginId === undefined ? {} : { pluginId }),
      normalizedKey,
      priority: registration.priority ?? 0,
      order: registration.order ?? 100,
      allowInEditable: registration.allowInEditable === true,
    };
    this.internal.entries.set(entry.id, entry);
    this.rebuildSnapshot();

    return trackContextEffect(this.ctx, () => {
      if (this.internal.entries.get(entry.id) === entry) {
        this.internal.entries.delete(entry.id);
        this.rebuildSnapshot();
      }
    });
  }

  /** Evaluate matching shortcut for `event` without running its handler. */
  match(event: KeyboardEvent): { entry: ShortcutEntry; context: ShortcutContext } | null {
    if (event.defaultPrevented || event.isComposing) return null;
    const chord = keyChordFromEvent(event);
    if (chord === null || RESERVED_SHORTCUT_CHORDS.has(chord)) return null;

    const targetEl = asClosestCapable(event.target);
    if (targetEl?.closest(RECORDER_SELECTOR)) return null;
    const inEditable = Boolean(targetEl?.closest(EDITABLE_SELECTOR));
    const inTerminal = Boolean(targetEl?.closest(TERMINAL_SELECTOR));
    const app = useAppStore.getState();
    const context: ShortcutContext = {
      cwd: app.cwd,
      sessionFile: app.sessionFile,
      inEditable,
      inTerminal,
      event,
    };

    for (const entry of this.internal.snapshot.shortcuts) {
      if (entry.normalizedKey !== chord) continue;
      if (inEditable && !entry.allowInEditable) continue;
      if (entry.when !== undefined) {
        try {
          if (!entry.when(context)) continue;
        } catch (error) {
          recordClientRenderError(entry.pluginId, `shortcut:${entry.id}`, error);
          console.error(`[qianji-services:shortcutService] shortcut "${entry.id}" when() failed:`, error);
          continue;
        }
      }
      return { entry, context };
    }
    return null;
  }

  /** Dispatch a `KeyboardEvent` to the highest-priority matching shortcut. Returns `true` if handled. */
  dispatch(event: KeyboardEvent): boolean {
    const matched = this.match(event);
    if (matched === null) return false;
    event.preventDefault();
    event.stopPropagation();
    const { entry, context } = matched;
    runPluginCallback(entry.pluginId, `shortcut:${entry.id}`, () => entry.run(context));
    return true;
  }
}
