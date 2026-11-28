/**
 * Pure coordinate & input event translation helpers for `BotComputerViewport`
 * (`mouse`, `wheel`, `key`, `paste` -> `BotComputerInputEvent`).
 */
import type {
  BotComputerInputEvent,
  BotComputerKeyModifier,
  BotComputerMouseAction,
  BotComputerMouseButton,
} from "@qianji/protocol";

export interface ModifierFlagsLike {
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

export interface ViewportRectLike {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function extractModifiers(e: ModifierFlagsLike): BotComputerKeyModifier[] {
  const mods: BotComputerKeyModifier[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.shiftKey) mods.push("shift");
  if (e.altKey) mods.push("alt");
  if (e.metaKey) mods.push("meta");
  return mods;
}

export function mapMouseButton(button: number): BotComputerMouseButton {
  if (button === 2) return "right";
  if (button === 1) return "middle";
  return "left";
}

export function computeViewportCoords(
  clientX: number,
  clientY: number,
  rect: ViewportRectLike,
  vpWidth: number,
  vpHeight: number,
): { readonly x: number; readonly y: number } {
  if (rect.width > 0 && rect.height > 0) {
    const relX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const relY = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    return {
      x: Math.round(relX * vpWidth),
      y: Math.round(relY * vpHeight),
    };
  }
  return {
    x: Math.max(0, Math.min(vpWidth, Math.round(clientX))),
    y: Math.max(0, Math.min(vpHeight, Math.round(clientY))),
  };
}

export function buildMouseInputEvent(input: {
  readonly mouseAction: BotComputerMouseAction;
  readonly button?: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly rect: ViewportRectLike;
  readonly vpWidth: number;
  readonly vpHeight: number;
  readonly modifiers: ModifierFlagsLike;
}): BotComputerInputEvent {
  const { x, y } = computeViewportCoords(
    input.clientX,
    input.clientY,
    input.rect,
    input.vpWidth,
    input.vpHeight,
  );
  return {
    kind: "mouse",
    mouseAction: input.mouseAction,
    ...(input.button !== undefined ? { button: mapMouseButton(input.button) } : {}),
    x,
    y,
    viewportWidth: input.vpWidth,
    viewportHeight: input.vpHeight,
    modifiers: extractModifiers(input.modifiers),
  };
}

export function buildWheelInputEvent(input: {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly rect: ViewportRectLike;
  readonly vpWidth: number;
  readonly vpHeight: number;
  readonly modifiers: ModifierFlagsLike;
}): BotComputerInputEvent | null {
  if (input.deltaX === 0 && input.deltaY === 0) return null;
  const { x, y } = computeViewportCoords(
    input.clientX,
    input.clientY,
    input.rect,
    input.vpWidth,
    input.vpHeight,
  );
  return {
    kind: "wheel",
    x,
    y,
    deltaX: Math.round(input.deltaX),
    deltaY: Math.round(input.deltaY),
    viewportWidth: input.vpWidth,
    viewportHeight: input.vpHeight,
    modifiers: extractModifiers(input.modifiers),
  };
}

export function buildKeyInputEvent(
  e: { readonly key: string } & ModifierFlagsLike,
): BotComputerInputEvent | "allow-native-paste" {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
    return "allow-native-paste";
  }
  const modifiers = extractModifiers(e);
  const isPlainPrintable = e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey;
  return {
    kind: "key",
    key: e.key,
    ...(isPlainPrintable ? { text: e.key } : {}),
    modifiers,
  };
}

export function buildPasteInputEvent(pastedText: string): BotComputerInputEvent | null {
  if (pastedText === "") return null;
  return {
    kind: "paste",
    text: pastedText,
  };
}
