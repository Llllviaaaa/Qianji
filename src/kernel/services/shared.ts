/**
 * Shared lifecycle and subscription helpers for Qianji's frontend Cordis Service mesh (ADR 0023).
 */
import type { Context } from "@deepseek-ai/cordis";

/**
 * Bind a synchronous disposer to a Cordis Context's Fiber so cleanup runs
 * automatically when the calling plugin unloads, while also returning an
 * idempotent manual unsubscribe function compatible with `useSyncExternalStore`.
 */
export function trackContextEffect(ctx: Context, dispose: () => void): () => void {
  let disposed = false;
  const once = () => {
    if (disposed) return;
    disposed = true;
    dispose();
  };
  const detach = ctx.effect(() => once);
  return () => {
    once();
    void detach();
  };
}

/** Lightweight fan-out listener hub with per-listener error isolation. */
export class ServiceEmitter {
  private readonly listeners = new Set<() => void>();
  private readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  add(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error(`[qianji-services:${this.label}] subscriber error:`, error);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }

  get size(): number {
    return this.listeners.size;
  }
}

export function isTauriEnvironment(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function shallowEqualArray<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (!Object.is(left[i], right[i])) return false;
  }
  return true;
}

export function shallowEqualObject<T extends object>(left: T, right: T): boolean {
  if (left === right) return true;
  const leftKeys = Object.keys(left) as Array<keyof T>;
  const rightKeys = Object.keys(right) as Array<keyof T>;
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    if (!Object.is(left[key], right[key])) return false;
  }
  return true;
}
