// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./novnc.d.ts" />
/**
 * Real `@novnc/novnc` RFB WebSocket desktop connection, `Ctrl+V`/`Cmd+V` clipboard
 * paste bridge, and Unicode keysym text typing (`typeOnDesktop`).
 *
 * Adapted from `OpenMausBot` (`src/lib/desktop-connection.ts`).
 */
import type RFB from "@novnc/novnc";
import type { RFBClipboardEventDetail } from "@novnc/novnc";

export interface DesktopConnectionEvents {
  connected(): void;
  disconnected(): void;
  clipboard?(text: string): void;
}

const XK_CONTROL_L = 0xffe3;
const XK_CONTROL_R = 0xffe4;
const XK_V = 0x76;
const MAC_COMMAND_KEYSYMS: Readonly<Record<string, number>> = {
  MetaLeft: 0xffe9,
  MetaRight: 0xffeb,
};

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");
}

/** V, or physical KeyV on a non-Latin keyboard layout, matching native browser paste triggers. */
export function isPasteKey(event: { readonly key: string; readonly code: string }): boolean {
  const key = event.key.toLowerCase();
  return key === "v" || (event.code === "KeyV" && !/^[a-z]$/.test(key));
}

export type DesktopRfbKeySink = Pick<RFB, "viewOnly" | "clipboardPasteFrom" | "sendKey">;

/**
 * Places local clipboard text on the remote VNC clipboard and synthesizes `Ctrl+V`
 * (`⌘` on macOS is released before `V` so the remote Linux/VM desktop receives a clean `Ctrl+V`).
 */
export function pasteOnDesktop(client: DesktopRfbKeySink, text: string, held: string | null): void {
  if (client.viewOnly) return;
  if (text !== "") client.clipboardPasteFrom(text);
  const ctrl = held !== null && held.startsWith("Control") ? held : "ControlLeft";
  client.sendKey(ctrl === "ControlRight" ? XK_CONTROL_R : XK_CONTROL_L, ctrl, true);
  if (held !== null) {
    const macSym = MAC_COMMAND_KEYSYMS[held];
    if (macSym !== undefined) {
      client.sendKey(macSym, held, false);
    }
  }
  client.sendKey(XK_V, "KeyV");
  if (ctrl !== held) {
    client.sendKey(XK_CONTROL_L, ctrl, false);
  }
}

/** Explicit text entry using X11 / Unicode keysyms (`0x01000000 | codepoint` for non-Latin/CJK). */
export function typeOnDesktop(client: Pick<RFB, "sendKey">, text: string): void {
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    const keysym =
      code === 10
        ? 0xff0d
        : code === 9
          ? 0xff09
          : code <= 255
            ? code
            : 0x01000000 | code;
    client.sendKey(keysym, null);
  }
}

export function forwardPaste(screen: HTMLElement, client: DesktopRfbKeySink, signal: AbortSignal): void {
  const mac = isMacPlatform();
  const pasteModifier = mac ? /^Meta(Left|Right)$/ : /^Control(Left|Right)$/;
  let held: string | null = null;

  screen.addEventListener(
    "keydown",
    (event) => {
      if (pasteModifier.test(event.code)) held = event.code;
      const modifier = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (client.viewOnly || !modifier || event.altKey || event.shiftKey || !isPasteKey(event)) return;
      event.stopPropagation();
    },
    { capture: true, signal },
  );
  screen.addEventListener(
    "keyup",
    (event) => {
      if (event.code === held) held = null;
    },
    { capture: true, signal },
  );
  screen.addEventListener(
    "focusout",
    () => {
      held = null;
    },
    { signal },
  );
  screen.addEventListener(
    "paste",
    (event) => {
      event.preventDefault();
      pasteOnDesktop(client, event.clipboardData?.getData("text/plain") ?? "", held);
    },
    { signal },
  );
}

export async function openDesktopRfb(
  screen: HTMLElement,
  socket: string | WebSocket,
  options: {
    readonly password?: string;
    readonly viewOnly?: boolean;
    readonly signal: AbortSignal;
    readonly events: DesktopConnectionEvents;
    readonly RfbCtor?: typeof RFB;
  },
): Promise<RFB> {
  const { password = "", viewOnly = false, signal: cancelled, events, RfbCtor } = options;
  const Ctor = RfbCtor ?? (await import("@novnc/novnc")).default;
  if (cancelled.aborted) {
    throw new Error("VNC connection aborted");
  }

  const client = new Ctor(screen, socket, {
    credentials: { password, username: "", target: "" },
  });
  client.scaleViewport = true;
  client.viewOnly = viewOnly;
  client.background = "#111214";

  let ended = false;
  const end = () => {
    clearTimeout(deadline);
    if (ended || cancelled.aborted) return;
    ended = true;
    events.disconnected();
  };
  const deadline = setTimeout(() => {
    client.disconnect();
    end();
  }, 15_000);

  cancelled.addEventListener("abort", () => clearTimeout(deadline), { once: true });
  client.addEventListener("connect", () => {
    clearTimeout(deadline);
    if (!cancelled.aborted) events.connected();
  });
  client.addEventListener("disconnect", end);
  client.addEventListener("clipboard", (event: CustomEvent<RFBClipboardEventDetail>) => {
    if (!cancelled.aborted) events.clipboard?.(event.detail.text);
  });
  forwardPaste(screen, client, cancelled);
  return client;
}
