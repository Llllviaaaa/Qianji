/**
 * Persistent user slot override pins (`localStorage["qianji:slot-overrides"]`)
 * and runtime plugin tier registry (ADR 0023 §5.3).
 *
 * Allows users to pin a specific plugin/entry as the winner of any `single`
 * (or `chain`/`keyed`) slot above tier and priority election, or reset back
 * to automatic election.
 */
import { useSyncExternalStore } from "react";

export const SLOT_OVERRIDES_STORAGE_KEY = "qianji:slot-overrides";

export type RuntimePluginTier = "builtin" | "user" | "workspace";

export interface SlotOverridesStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SlotOverridesStoreOptions {
  readonly storage?: SlotOverridesStorageLike | null;
  readonly storageKey?: string;
}

function readOverridesFromStorage(
  storage: SlotOverridesStorageLike | null,
  storageKey: string,
): Record<string, string> {
  if (storage === null) return {};
  try {
    const raw = storage.getItem(storageKey);
    if (raw === null || raw.trim() === "") return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key === "string" && key.trim() !== "" && typeof value === "string" && value.trim() !== "") {
        clean[key] = value.trim();
      }
    }
    return clean;
  } catch {
    return {};
  }
}

function writeOverridesToStorage(
  storage: SlotOverridesStorageLike | null,
  storageKey: string,
  map: Readonly<Record<string, string>>,
): void {
  if (storage === null) return;
  try {
    const keys = Object.keys(map);
    if (keys.length === 0) {
      storage.removeItem(storageKey);
    } else {
      storage.setItem(storageKey, JSON.stringify(map));
    }
  } catch {
    // Ignore storage write errors in private/restricted environments.
  }
}

export class SlotOverridesStore {
  private readonly storage: SlotOverridesStorageLike | null;
  private readonly storageKey: string;
  private readonly listeners = new Set<() => void>();
  private snapshot: Readonly<Record<string, string>>;

  constructor(options: SlotOverridesStoreOptions = {}) {
    const defaultStorage = typeof window !== "undefined" ? (window.localStorage ?? null) : null;
    this.storage = options.storage === undefined ? defaultStorage : options.storage;
    this.storageKey = options.storageKey ?? SLOT_OVERRIDES_STORAGE_KEY;
    this.snapshot = readOverridesFromStorage(this.storage, this.storageKey);
  }

  getSnapshot = (): Readonly<Record<string, string>> => this.snapshot;

  get(slotKey: string): string | undefined {
    return this.snapshot[slotKey];
  }

  /** Pin `slotKey` to a specific `pluginId` or registration `entryId`. */
  set(slotKey: string, target: string): void {
    const cleanSlot = slotKey.trim();
    const cleanTarget = target.trim();
    if (cleanSlot === "" || cleanTarget === "") return;
    if (this.snapshot[cleanSlot] === cleanTarget) return;
    const next: Record<string, string> = { ...this.snapshot, [cleanSlot]: cleanTarget };
    this.snapshot = next;
    writeOverridesToStorage(this.storage, this.storageKey, next);
    this.emit();
  }

  /** Clear the manual override for a single slot so automatic election takes over. */
  clear(slotKey: string): void {
    if (!(slotKey in this.snapshot)) return;
    const next: Record<string, string> = { ...this.snapshot };
    delete next[slotKey];
    this.snapshot = next;
    writeOverridesToStorage(this.storage, this.storageKey, next);
    this.emit();
  }

  /** Reset all manual slot overrides. */
  resetAll(): void {
    if (Object.keys(this.snapshot).length === 0) return;
    this.snapshot = {};
    writeOverridesToStorage(this.storage, this.storageKey, this.snapshot);
    this.emit();
  }

  /** Replace the full override map atomically (e.g. syncing from Host settings). */
  replaceAll(nextMap: Readonly<Record<string, string>>): void {
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(nextMap)) {
      if (key.trim() !== "" && value.trim() !== "") {
        clean[key.trim()] = value.trim();
      }
    }
    const prevKeys = Object.keys(this.snapshot);
    const nextKeys = Object.keys(clean);
    if (
      prevKeys.length === nextKeys.length &&
      nextKeys.every((k) => this.snapshot[k] === clean[k])
    ) {
      return;
    }
    this.snapshot = clean;
    writeOverridesToStorage(this.storage, this.storageKey, clean);
    this.emit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function createSlotOverridesStore(options?: SlotOverridesStoreOptions): SlotOverridesStore {
  return new SlotOverridesStore(options);
}

export const slotOverridesStore = new SlotOverridesStore();

export function useSlotOverrides(store: SlotOverridesStore = slotOverridesStore): Readonly<Record<string, string>> {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

const runtimePluginTiers = new Map<string, RuntimePluginTier>();

/** Record the discovered tier (`builtin` | `user` | `workspace`) of a client plugin ID. */
export function setPluginTier(pluginId: string, tier: RuntimePluginTier): void {
  if (pluginId === "") return;
  runtimePluginTiers.set(pluginId, tier);
}

/** Look up the known tier for `pluginId`, defaulting to `"user"` for unknown external plugins. */
export function getPluginTier(pluginId: string | undefined): RuntimePluginTier {
  if (pluginId === undefined || pluginId === "") return "builtin";
  return runtimePluginTiers.get(pluginId) ?? "user";
}

/** Clear recorded plugin tiers (used by test teardown). */
export function clearPluginTiers(): void {
  runtimePluginTiers.clear();
}
