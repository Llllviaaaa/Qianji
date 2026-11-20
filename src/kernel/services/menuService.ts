/**
 * Frontend Cordis `menuService` (ADR 0023 Phase 2).
 *
 * Unified registry for all host menu locations (`menubar.file`, `menubar.edit`,
 * `menubar.view`, `menubar.help`, `menubar.tools`, `thread.more`,
 * `sidebar.project`, `sidebar.thread`, `file.context`) with guarded `when`,
 * `disabled`, and `onSelect` evaluation and automatic Cordis Fiber disposal.
 */
import type { ReactNode } from "react";
import { Context, Service } from "@deepseek-ai/cordis";
import {
  clientContributions,
  ClientContributionRegistry,
  type ClientMenuContextMap,
  type ClientMenuItemContribution,
  type ClientMenuItemFor,
  type ClientMenuLocation,
} from "../../lib/clientContributions";
import { recordClientRenderError, resolveContextPluginId } from "../../lib/clientPluginRuntime";
import { runPluginCallback } from "../../lib/pluginKeybindings";
import { ServiceEmitter, trackContextEffect } from "./shared";

export type {
  ClientMenuContextMap,
  ClientMenuItemContribution,
  ClientMenuItemFor,
  ClientMenuLocation,
};

declare module "@deepseek-ai/cordis" {
  interface Context {
    menuService: MenuService;
  }
}

export const MENU_LOCATIONS = [
  "menubar.file",
  "menubar.edit",
  "menubar.view",
  "menubar.help",
  "menubar.tools",
  "thread.more",
  "sidebar.project",
  "sidebar.thread",
  "file.context",
] as const satisfies readonly ClientMenuLocation[];

export interface ResolvedMenuItem<L extends ClientMenuLocation = ClientMenuLocation> {
  readonly id: string;
  readonly pluginId?: string;
  readonly location: L;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly shortcut?: string;
  readonly order: number;
  readonly danger: boolean;
  readonly disabled: boolean;
  readonly item: ClientMenuItemFor<L>;
  readonly select: () => void;
}

export interface MenuServiceSnapshot {
  readonly items: readonly ClientMenuItemContribution[];
  readonly byLocation: Readonly<Record<ClientMenuLocation, readonly ClientMenuItemContribution[]>>;
}

export interface MenuServiceOptions {
  registry?: ClientContributionRegistry;
}

function safeMenuPredicate<C>(
  item: { id: string; pluginId?: string },
  predicate: ((context: C) => boolean) | undefined,
  context: C,
  defaultValue: boolean,
): boolean {
  if (predicate === undefined) return defaultValue;
  try {
    return predicate(context);
  } catch (error) {
    recordClientRenderError(item.pluginId, `menu:${item.id}`, error);
    console.error(`[qianji-services:menuService] predicate for "${item.id}" failed:`, error);
    return !defaultValue;
  }
}

function buildMenuSnapshot(items: readonly ClientMenuItemContribution[]): MenuServiceSnapshot {
  const byLocation = Object.fromEntries(
    MENU_LOCATIONS.map((loc) => [loc, items.filter((item) => item.location === loc)]),
  ) as unknown as Record<ClientMenuLocation, readonly ClientMenuItemContribution[]>;
  return { items, byLocation };
}

interface MenuInternalState {
  readonly registry: ClientContributionRegistry;
  cachedItemsRef: readonly ClientMenuItemContribution[];
  snapshot: MenuServiceSnapshot;
  readonly emitter: ServiceEmitter;
}

export class MenuService extends Service {
  static provide = "menuService";
  private readonly internal: MenuInternalState;

  constructor(ctx: Context, options?: MenuServiceOptions) {
    super(ctx, "menuService");
    const registry = options?.registry ?? clientContributions;
    const initialItems = registry.getSnapshot().menuItems;
    this.internal = {
      registry,
      cachedItemsRef: initialItems,
      snapshot: buildMenuSnapshot(initialItems),
      emitter: new ServiceEmitter("menuService"),
    };

    const offContrib = registry.subscribe(() => {
      const nextItems = registry.getSnapshot().menuItems;
      if (nextItems !== this.internal.cachedItemsRef) {
        this.internal.cachedItemsRef = nextItems;
        this.internal.snapshot = buildMenuSnapshot(nextItems);
        this.internal.emitter.emit();
      }
    });

    ctx.effect(() => () => {
      offContrib();
      this.internal.emitter.clear();
    });
  }

  getSnapshot(): MenuServiceSnapshot {
    return this.internal.snapshot;
  }

  subscribe(listener: () => void): () => void {
    const rawUnsub = this.internal.emitter.add(listener);
    return trackContextEffect(this.ctx, rawUnsub);
  }

  register<L extends ClientMenuLocation>(item: ClientMenuItemFor<L>): () => void {
    const pluginId = item.pluginId ?? resolveContextPluginId(this.ctx);
    const tagged = (pluginId !== undefined && item.pluginId === undefined
      ? { ...item, pluginId }
      : item) as unknown as ClientMenuItemContribution;
    const rawDispose = this.internal.registry.registerMenuItem(tagged);
    return trackContextEffect(this.ctx, rawDispose);
  }

  hasItems(location: ClientMenuLocation): boolean {
    return this.internal.snapshot.byLocation[location].length > 0;
  }

  /**
   * Resolve visible menu items for `location` against `context`.
   * - `when` throws -> recorded as clientError and item is hidden.
   * - `disabled` throws -> recorded as clientError and item is disabled.
   * - `select()` runs `onSelect` guarded against sync throws and async rejections.
   */
  getItems<L extends ClientMenuLocation>(
    location: L,
    context: ClientMenuContextMap[L],
  ): ResolvedMenuItem<L>[] {
    const candidates = this.internal.snapshot.byLocation[location] as readonly unknown[] as readonly ClientMenuItemFor<L>[];
    const resolved: ResolvedMenuItem<L>[] = [];

    for (const item of candidates) {
      if (!safeMenuPredicate(item, item.when, context, true)) continue;
      const disabled = safeMenuPredicate(item, item.disabled, context, false);
      resolved.push({
        id: item.id,
        ...(item.pluginId === undefined ? {} : { pluginId: item.pluginId }),
        location: item.location,
        label: item.label,
        ...(item.icon === undefined ? {} : { icon: item.icon }),
        ...(item.shortcut === undefined ? {} : { shortcut: item.shortcut }),
        order: item.order ?? 100,
        danger: item.danger === true,
        disabled,
        item,
        select: () => {
          if (disabled) return;
          runPluginCallback(item.pluginId, `menu:${item.id}`, () => item.onSelect(context));
        },
      });
    }
    return resolved;
  }

  /** Guarded async execution of a menu item's `onSelect`. Returns `false` if disabled or errored. */
  async executeItem<L extends ClientMenuLocation>(
    item: ClientMenuItemFor<L>,
    context: ClientMenuContextMap[L],
  ): Promise<boolean> {
    if (!safeMenuPredicate(item, item.when, context, true)) return false;
    if (safeMenuPredicate(item, item.disabled, context, false)) return false;
    try {
      await item.onSelect(context);
      return true;
    } catch (error) {
      recordClientRenderError(item.pluginId, `menu:${item.id}`, error);
      console.error(`[qianji-services:menuService] menu "${item.id}" onSelect failed:`, error);
      return false;
    }
  }
}
