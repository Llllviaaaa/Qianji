/**
 * Frontend Cordis `composerService` (ADR 0023 Phase 2).
 *
 * Manages per-session/draft composer state (draft text, prefill, attachments,
 * steering/follow-up queues, slash commands) plus Cordis-tracked registries for
 * slash interceptors and rewind handlers.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import { mergeAttachments } from "../../lib/attachments";
import {
  clientContributions,
  ClientContributionRegistry,
  type ClientRewindHandlerContribution,
  type ClientSlashInterceptorContribution,
  type WorkbenchSlotContext,
} from "../../lib/clientContributions";
import { resolveContextPluginId } from "../../lib/clientPluginRuntime";
import {
  rewindController,
  type PerformedRewindResult,
  type RewindMode,
  type RewindTargetSummary,
  type RewindTurnSummary,
} from "../../lib/rewindController";
import { useAppStore } from "../../store";
import type {
  AttachmentPayload,
  ManagedQueuedMessage,
  SlashCommand,
  UiMessage,
} from "../../types";
import { ServiceEmitter, shallowEqualObject, trackContextEffect } from "./shared";

declare module "@deepseek-ai/cordis" {
  interface Context {
    composerService: ComposerService;
  }
}

export const DRAFT_COMPOSER_KEY = "__draft__";

export interface ComposerSessionBucket {
  draft: string;
  prefill: string | null;
  attachments: AttachmentPayload[];
}

export interface ComposerSnapshot {
  readonly sessionKey: string;
  readonly draft: string;
  readonly prefill: string | null;
  readonly attachments: readonly AttachmentPayload[];
  readonly managedFollowUpQueue: readonly ManagedQueuedMessage[];
  readonly steeringQueue: readonly unknown[];
  readonly followUpQueue: readonly unknown[];
  readonly commands: readonly SlashCommand[];
  readonly slashInterceptors: readonly ClientSlashInterceptorContribution[];
  readonly rewindHandlers: readonly ClientRewindHandlerContribution[];
}

export interface ComposerServiceOptions {
  registry?: ClientContributionRegistry;
}

const EMPTY_ATTACHMENTS: readonly AttachmentPayload[] = [];
const EMPTY_QUEUE: readonly ManagedQueuedMessage[] = [];
const EMPTY_UNKNOWN_QUEUE: readonly unknown[] = [];

function activeSessionKey(): string {
  const s = useAppStore.getState();
  return s.sessionFile ?? s.sessionId ?? DRAFT_COMPOSER_KEY;
}

interface ComposerInternalState {
  readonly registry: ClientContributionRegistry;
  readonly buckets: Map<string, ComposerSessionBucket>;
  readonly snapshotCache: Map<string, ComposerSnapshot>;
  readonly emitter: ServiceEmitter;
}

export class ComposerService extends Service {
  static provide = "composerService";
  private readonly internal: ComposerInternalState;

  constructor(ctx: Context, options?: ComposerServiceOptions) {
    super(ctx, "composerService");
    const registry = options?.registry ?? clientContributions;
    this.internal = {
      registry,
      buckets: new Map(),
      snapshotCache: new Map(),
      emitter: new ServiceEmitter("composerService"),
    };

    let prevActive = this.computeSnapshot(activeSessionKey());
    this.internal.snapshotCache.set(prevActive.sessionKey, prevActive);

    const notifyIfChanged = () => {
      const key = activeSessionKey();
      const next = this.computeSnapshot(key);
      const cached = this.internal.snapshotCache.get(key);
      if (!cached || !shallowEqualObject(cached, next)) {
        this.internal.snapshotCache.set(key, next);
        prevActive = next;
        this.internal.emitter.emit();
      } else if (prevActive.sessionKey !== key) {
        prevActive = cached;
        this.internal.emitter.emit();
      }
    };

    const offStore = useAppStore.subscribe(() => {
      notifyIfChanged();
    });
    const offContributions = registry.subscribe(() => {
      this.internal.snapshotCache.clear();
      this.internal.emitter.emit();
    });

    ctx.effect(() => () => {
      offStore();
      offContributions();
      this.internal.buckets.clear();
      this.internal.snapshotCache.clear();
      this.internal.emitter.clear();
    });
  }

  private resolveKey(sessionKey?: string): { key: string; isActive: boolean } {
    const active = activeSessionKey();
    if (sessionKey === undefined || sessionKey.trim() === "") {
      return { key: active, isActive: true };
    }
    const trimmed = sessionKey.trim();
    return { key: trimmed, isActive: trimmed === active };
  }

  private getOrCreateBucket(key: string): ComposerSessionBucket {
    let bucket = this.internal.buckets.get(key);
    if (bucket === undefined) {
      bucket = { draft: "", prefill: null, attachments: [] };
      this.internal.buckets.set(key, bucket);
    }
    return bucket;
  }

  private computeSnapshot(key: string): ComposerSnapshot {
    const isActive = key === activeSessionKey();
    const bucket = this.internal.buckets.get(key);
    const app = useAppStore.getState();
    const contrib = this.internal.registry.getSnapshot();
    return {
      sessionKey: key,
      draft: bucket?.draft ?? "",
      prefill: isActive ? app.composerPrefill : (bucket?.prefill ?? null),
      attachments: bucket ? bucket.attachments : EMPTY_ATTACHMENTS,
      managedFollowUpQueue: isActive ? app.managedFollowUpQueue : EMPTY_QUEUE,
      steeringQueue: isActive ? app.steeringQueue : EMPTY_UNKNOWN_QUEUE,
      followUpQueue: isActive ? app.followUpQueue : EMPTY_UNKNOWN_QUEUE,
      commands: app.commands,
      slashInterceptors: contrib.slashInterceptors,
      rewindHandlers: contrib.rewindHandlers,
    };
  }

  private invalidateAndEmit(key: string): void {
    const next = this.computeSnapshot(key);
    const prev = this.internal.snapshotCache.get(key);
    if (!prev || !shallowEqualObject(prev, next)) {
      this.internal.snapshotCache.set(key, next);
      this.internal.emitter.emit();
    }
  }

  getSnapshot(sessionKey?: string): ComposerSnapshot {
    const { key } = this.resolveKey(sessionKey);
    const next = this.computeSnapshot(key);
    const cached = this.internal.snapshotCache.get(key);
    if (cached && shallowEqualObject(cached, next)) return cached;
    this.internal.snapshotCache.set(key, next);
    return next;
  }

  subscribe(listener: () => void): () => void {
    const rawUnsub = this.internal.emitter.add(listener);
    return trackContextEffect(this.ctx, rawUnsub);
  }

  getDraft(sessionKey?: string): string {
    const { key } = this.resolveKey(sessionKey);
    return this.internal.buckets.get(key)?.draft ?? "";
  }

  setDraft(text: string, sessionKey?: string): void {
    const { key } = this.resolveKey(sessionKey);
    const bucket = this.getOrCreateBucket(key);
    if (bucket.draft === text) return;
    bucket.draft = text;
    this.invalidateAndEmit(key);
  }

  prefill(text: string, sessionKey?: string): void {
    const { key, isActive } = this.resolveKey(sessionKey);
    if (isActive) {
      useAppStore.setState({ composerPrefill: text });
      this.invalidateAndEmit(key);
      return;
    }
    const bucket = this.getOrCreateBucket(key);
    bucket.prefill = text;
    this.invalidateAndEmit(key);
  }

  consumePrefill(sessionKey?: string): string | null {
    const { key, isActive } = this.resolveKey(sessionKey);
    if (isActive) {
      const value = useAppStore.getState().composerPrefill;
      if (value === null) return null;
      useAppStore.getState().clearComposerPrefill();
      this.invalidateAndEmit(key);
      return value;
    }
    const bucket = this.internal.buckets.get(key);
    if (!bucket || bucket.prefill === null) return null;
    const value = bucket.prefill;
    bucket.prefill = null;
    this.invalidateAndEmit(key);
    return value;
  }

  addAttachments(items: readonly AttachmentPayload[], sessionKey?: string): void {
    if (items.length === 0) return;
    const { key } = this.resolveKey(sessionKey);
    const bucket = this.getOrCreateBucket(key);
    const merged = mergeAttachments(bucket.attachments, [...items]);
    if (merged.length === bucket.attachments.length) return;
    bucket.attachments = merged;
    this.invalidateAndEmit(key);
  }

  removeAttachment(path: string, sessionKey?: string): void {
    const { key } = this.resolveKey(sessionKey);
    const bucket = this.internal.buckets.get(key);
    if (!bucket) return;
    const filtered = bucket.attachments.filter((item) => item.path !== path);
    if (filtered.length === bucket.attachments.length) return;
    bucket.attachments = filtered;
    this.invalidateAndEmit(key);
  }

  clearAttachments(sessionKey?: string): void {
    const { key } = this.resolveKey(sessionKey);
    const bucket = this.internal.buckets.get(key);
    if (!bucket || bucket.attachments.length === 0) return;
    bucket.attachments = [];
    this.invalidateAndEmit(key);
  }

  moveQueuedMessage(id: string, direction: -1 | 1): void {
    useAppStore.getState().moveManagedFollowUp(id, direction);
  }

  removeQueuedMessage(id: string): void {
    useAppStore.getState().removeManagedFollowUp(id);
  }

  async steerQueuedMessage(id: string): Promise<void> {
    await useAppStore.getState().steerManagedFollowUp(id);
  }

  async refreshCommands(cwd?: string): Promise<void> {
    await useAppStore.getState().refreshCommands(cwd);
  }

  registerSlashInterceptor(interceptor: ClientSlashInterceptorContribution): () => void {
    const pluginId = interceptor.pluginId ?? resolveContextPluginId(this.ctx);
    const tagged = pluginId !== undefined && interceptor.pluginId === undefined
      ? { ...interceptor, pluginId }
      : interceptor;
    const dispose = this.internal.registry.registerSlashInterceptor(tagged);
    return trackContextEffect(this.ctx, dispose);
  }

  registerRewindHandler(handler: ClientRewindHandlerContribution): () => void {
    const pluginId = handler.pluginId ?? resolveContextPluginId(this.ctx);
    const tagged = pluginId !== undefined && handler.pluginId === undefined
      ? { ...handler, pluginId }
      : handler;
    const dispose = this.internal.registry.registerRewindHandler(tagged);
    return trackContextEffect(this.ctx, dispose);
  }

  async tryHandleSlashCommand(
    name: string,
    rawArgs: string,
    context?: Partial<WorkbenchSlotContext>,
  ): Promise<boolean> {
    const app = useAppStore.getState();
    const resolvedContext: WorkbenchSlotContext = {
      cwd: context?.cwd ?? app.cwd,
      sessionFile: context?.sessionFile !== undefined ? context.sessionFile : app.sessionFile,
      ...(context?.variant === undefined ? {} : { variant: context.variant }),
    };
    return this.internal.registry.tryHandleSlashCommand(name, rawArgs, resolvedContext);
  }

  hasRewindHandler(): boolean {
    return this.internal.registry.hasRewindHandler();
  }

  async tryHandleRewind(message: UiMessage): Promise<boolean> {
    return this.internal.registry.tryHandleRewind(message);
  }

  openRewindTimeline(): boolean {
    return this.internal.registry.openRewindTimeline();
  }

  listRewindableTurns(): RewindTurnSummary[] {
    return rewindController.listRewindableTurns();
  }

  async inspectRewindMessage(messageId: string): Promise<RewindTargetSummary | null> {
    return rewindController.inspectMessage(messageId);
  }

  async performRewind(params: {
    message: UiMessage;
    entryId?: string;
    mode?: RewindMode;
    protectDraft?: boolean;
  }): Promise<PerformedRewindResult | null> {
    return rewindController.performRewind(params);
  }
}
