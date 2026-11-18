/**
 * File-watcher controller for `watch: true` external/workspace plugins.
 * Defers hot-reloads while any `AgentLoop` run is active so `fiber.dispose()`
 * never tears down in-flight plugin streams or hooks mid-turn, then flushes
 * coalesced pending reloads once all active runs have settled.
 */
import { existsSync, watch as fsWatch, type FSWatcher } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import "@qianji/agent";
import type { ResolvedCandidate } from "./plugin-candidates.ts";
import { shouldIgnoreWatchedPath } from "./plugin-util.ts";

export const DEFAULT_WATCH_DEBOUNCE_MS = 120;
export const DEFAULT_SETTLED_HMR_GRACE_MS = 300;

interface WatcherEntry {
  dir: string;
  watcher: FSWatcher;
  timer?: ReturnType<typeof setTimeout>;
}

export interface PluginWatcherControllerOptions {
  ctx: Context;
  watchDebounceMs?: number;
  settledHmrGraceMs?: number;
  invalidateDir: (dir: string) => void;
  triggerHmrSync: (forceIds: ReadonlySet<string>) => Promise<unknown>;
}

export class PluginWatcherController {
  private readonly watchers = new Map<string, WatcherEntry>();
  private readonly pendingReloads = new Map<string, string>();
  private readonly activeSessions = new Set<string>();
  private readonly unsubscribers: Array<() => void> = [];
  private readonly watchDebounceMs: number;
  private readonly settledHmrGraceMs: number;
  private settledTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly options: PluginWatcherControllerOptions) {
    this.watchDebounceMs = Math.max(0, options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS);
    this.settledHmrGraceMs = Math.max(0, options.settledHmrGraceMs ?? DEFAULT_SETTLED_HMR_GRACE_MS);
    this.unsubscribers.push(
      options.ctx.on("agent/before-start", (session) => {
        this.activeSessions.add(session.id);
        this.cancelSettledTimer();
      }),
      options.ctx.on("agent/settled", (session) => {
        this.activeSessions.delete(session.id);
        this.scheduleSettledFlush();
        return Promise.resolve();
      }),
    );
  }

  /** Whether any `AgentLoop` run is currently active on the Host context. */
  isAgentBusy(): boolean {
    if (this.activeSessions.size > 0) return true;
    const agents = this.options.ctx.get("agents");
    return typeof agents?.isBusy === "function" && agents.isBusy();
  }

  /** Clear deferred HMR state for one plugin (or all plugins when omitted). */
  clearPending(id?: string): void {
    if (id === undefined) {
      this.pendingReloads.clear();
      this.cancelSettledTimer();
      return;
    }
    this.pendingReloads.delete(id);
    if (this.pendingReloads.size === 0) {
      this.cancelSettledTimer();
    }
  }

  /** Reconcile recursive `fs.watch` handles against enabled `watch: true` candidates. */
  reconcile(candidates: readonly ResolvedCandidate[]): void {
    const wanted = new Map<string, string>();
    for (const candidate of candidates) {
      if (candidate.enabled && candidate.watch && candidate.tier !== "builtin" && candidate.dir !== undefined && existsSync(candidate.dir)) {
        wanted.set(candidate.id, candidate.dir);
      }
    }

    for (const pendingId of [...this.pendingReloads.keys()]) {
      if (!wanted.has(pendingId)) {
        this.pendingReloads.delete(pendingId);
      }
    }
    if (this.pendingReloads.size === 0) {
      this.cancelSettledTimer();
    }

    for (const [id, entry] of this.watchers) {
      const targetDir = wanted.get(id);
      if (targetDir !== undefined && targetDir === entry.dir) continue;
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.watcher.close();
      this.watchers.delete(id);
    }

    for (const [id, dir] of wanted) {
      if (this.watchers.has(id)) continue;
      try {
        const watcher = fsWatch(dir, { recursive: true }, (_eventType, filename) => {
          if (this.disposed || shouldIgnoreWatchedPath(filename)) return;
          const active = this.watchers.get(id);
          if (active === undefined) return;
          if (active.timer !== undefined) clearTimeout(active.timer);
          active.timer = setTimeout(() => {
            active.timer = undefined;
            this.handleDebouncedChange(id, dir);
          }, this.watchDebounceMs);
        });
        watcher.on("error", (error) => {
          this.options.ctx.logger("plugins").warn("watcher error for %s (%s): %s", id, dir, error);
        });
        this.watchers.set(id, { dir, watcher });
      } catch (error) {
        this.options.ctx.logger("plugins").warn("could not watch plugin %s (%s): %s", id, dir, error);
      }
    }
  }

  /** Stop all active watchers, timers, and lifecycle listeners. */
  dispose(): void {
    this.disposed = true;
    for (const unsub of this.unsubscribers.splice(0)) {
      unsub();
    }
    this.cancelSettledTimer();
    this.pendingReloads.clear();
    this.activeSessions.clear();
    for (const entry of this.watchers.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.watcher.close();
    }
    this.watchers.clear();
  }

  private cancelSettledTimer(): void {
    if (this.settledTimer !== undefined) {
      clearTimeout(this.settledTimer);
      this.settledTimer = undefined;
    }
  }

  private handleDebouncedChange(id: string, dir: string): void {
    if (this.disposed) return;
    this.options.invalidateDir(dir);
    if (this.isAgentBusy()) {
      this.pendingReloads.set(id, dir);
      this.options.ctx.logger("plugins").debug("deferring HMR reload for %s until active agent run settles", id);
      return;
    }
    this.clearPending(id);
    void this.options.triggerHmrSync(new Set([id])).catch((error: unknown) => {
      this.options.ctx.logger("plugins").error("HMR sync failed for %s: %s", id, error);
    });
  }

  private scheduleSettledFlush(): void {
    if (this.disposed || this.pendingReloads.size === 0 || this.isAgentBusy()) return;
    this.cancelSettledTimer();
    this.settledTimer = setTimeout(() => {
      this.settledTimer = undefined;
      if (this.disposed || this.pendingReloads.size === 0 || this.isAgentBusy()) return;
      const entries = [...this.pendingReloads.entries()];
      this.pendingReloads.clear();
      for (const [, dir] of entries) {
        this.options.invalidateDir(dir);
      }
      const forceIds = new Set(entries.map(([id]) => id));
      void this.options.triggerHmrSync(forceIds).catch((error: unknown) => {
        this.options.ctx.logger("plugins").error("Deferred HMR sync failed: %s", error);
      });
    }, this.settledHmrGraceMs);
  }
}
