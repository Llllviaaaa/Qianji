/**
 * Virtual keycode & modifier mapping for CDP `Input.dispatchKeyEvent` (`packages/host/src/bot/computer/cdp-keymap.ts`).
 */
import type { BotComputerKeyModifier } from "@qianji/protocol";

export interface CdpKeyDescriptor {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
  modifiers: number;
  text?: string;
  unmodifiedText?: string;
}

const NAMED_KEYS: Record<string, [string, string, number, string?]> = {
  enter: ["Enter", "Enter", 13, "\r"], return: ["Enter", "Enter", 13, "\r"],
  backspace: ["Backspace", "Backspace", 8], tab: ["Tab", "Tab", 9],
  escape: ["Escape", "Escape", 27], esc: ["Escape", "Escape", 27],
  space: [" ", "Space", 32, " "], " ": [" ", "Space", 32, " "],
  arrowleft: ["ArrowLeft", "ArrowLeft", 37], left: ["ArrowLeft", "ArrowLeft", 37],
  arrowup: ["ArrowUp", "ArrowUp", 38], up: ["ArrowUp", "ArrowUp", 38],
  arrowright: ["ArrowRight", "ArrowRight", 39], right: ["ArrowRight", "ArrowRight", 39],
  arrowdown: ["ArrowDown", "ArrowDown", 40], down: ["ArrowDown", "ArrowDown", 40],
  delete: ["Delete", "Delete", 46], insert: ["Insert", "Insert", 45],
  home: ["Home", "Home", 36], end: ["End", "End", 35],
  pageup: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34],
};

const OEM_PUNCT: Record<string, [string, number, boolean]> = {
  ";": ["Semicolon", 186, false], ":": ["Semicolon", 186, true],
  "=": ["Equal", 187, false], "+": ["Equal", 187, true],
  ",": ["Comma", 188, false], "<": ["Comma", 188, true],
  "-": ["Minus", 189, false], _: ["Minus", 189, true],
  ".": ["Period", 190, false], ">": ["Period", 190, true],
  "/": ["Slash", 191, false], "?": ["Slash", 191, true],
  "`": ["Backquote", 192, false], "~": ["Backquote", 192, true],
  "[": ["BracketLeft", 219, false], "{": ["BracketLeft", 219, true],
  "\\": ["Backslash", 220, false], "|": ["Backslash", 220, true],
  "]": ["BracketRight", 221, false], "}": ["BracketRight", 221, true],
  "'": ["Quote", 222, false], "\"": ["Quote", 222, true],
  ")": ["Digit0", 48, true], "!": ["Digit1", 49, true],
  "@": ["Digit2", 50, true], "#": ["Digit3", 51, true],
  $: ["Digit4", 52, true], "%": ["Digit5", 53, true],
  "^": ["Digit6", 54, true], "&": ["Digit7", 55, true],
  "*": ["Digit8", 56, true], "(": ["Digit9", 57, true],
};

export function encodeCdpModifiers(modifiers?: readonly BotComputerKeyModifier[]): number {
  let mask = 0;
  for (const mod of modifiers ?? []) {
    if (mod === "alt") mask |= 1;
    else if (mod === "ctrl") mask |= 2;
    else if (mod === "meta") mask |= 4;
    else if (mod === "shift") mask |= 8;
  }
  return mask;
}

export function resolveCdpKeyDescriptor(
  rawKey: string,
  modifiers?: readonly BotComputerKeyModifier[],
  explicitText?: string,
): CdpKeyDescriptor | null {
  let mask = encodeCdpModifiers(modifiers);
  let token = rawKey;
  if (rawKey.length > 1 && rawKey.includes("+")) {
    const parts = rawKey.split("+").map((p) => p.trim()).filter(Boolean);
    const tail = parts.pop();
    if (tail) {
      token = tail;
      for (const p of parts) {
        const low = p.toLowerCase();
        if (low === "alt") mask |= 1;
        else if (low === "ctrl" || low === "control") mask |= 2;
        else if (low === "meta" || low === "cmd" || low === "win") mask |= 4;
        else if (low === "shift") mask |= 8;
      }
    }
  }
  const hasCmdMod = (mask & (1 | 2 | 4)) !== 0;
  const named = NAMED_KEYS[token.toLowerCase()];
  if (named) {
    return {
      key: named[0], code: named[1], windowsVirtualKeyCode: named[2], nativeVirtualKeyCode: named[2],
      modifiers: mask, ...(!hasCmdMod && named[3] ? { text: named[3], unmodifiedText: named[3] } : {}),
    };
  }
  const fnMatch = /^f([1-9]|1[0-2])$/i.exec(token);
  if (fnMatch && fnMatch[1]) {
    const fnNum = Number.parseInt(fnMatch[1], 10);
    return { key: `F${fnNum}`, code: `F${fnNum}`, windowsVirtualKeyCode: 111 + fnNum, nativeVirtualKeyCode: 111 + fnNum, modifiers: mask };
  }
  if ([...token].length !== 1) return null;
  const cp = token.codePointAt(0) ?? 0;
  if (cp > 126) return null;
  if (/^[a-zA-Z]$/.test(token)) {
    const upper = token.toUpperCase();
    const vk = upper.charCodeAt(0);
    const shifted = (mask & 8) !== 0 || (token === upper && !hasCmdMod);
    const outKey = hasCmdMod ? ((mask & 8) !== 0 ? upper : token.toLowerCase()) : shifted ? upper : token.toLowerCase();
    return {
      key: outKey, code: `Key${upper}`, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mask,
      ...(!hasCmdMod ? { text: explicitText ?? outKey, unmodifiedText: token.toLowerCase() } : {}),
    };
  }
  if (/^[0-9]$/.test(token)) {
    const vk = token.charCodeAt(0);
    return {
      key: token, code: `Digit${token}`, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mask,
      ...(!hasCmdMod ? { text: explicitText ?? token, unmodifiedText: token } : {}),
    };
  }
  const punct = OEM_PUNCT[token];
  if (punct) {
    return {
      key: token, code: punct[0], windowsVirtualKeyCode: punct[1], nativeVirtualKeyCode: punct[1],
      modifiers: punct[2] ? mask | 8 : mask, ...(!hasCmdMod ? { text: explicitText ?? token } : {}),
    };
  }
  return {
    key: token, code: token, windowsVirtualKeyCode: cp, nativeVirtualKeyCode: cp,
    modifiers: mask, ...(!hasCmdMod ? { text: explicitText ?? token } : {}),
  };
}
