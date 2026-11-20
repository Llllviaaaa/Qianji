/**
 * Cordis Service wrapper (`ClientSlotsService`, `provide = "slots"`) around
 * `SlotRegistry` with automatic `ctx.effect()` disposal on Fiber unmount.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import type { SlotOverridesStore } from "../runtime/slotOverrides";
import type { SlotStoreRegistry } from "../store";
import type { AbdicationListener, AbdicationTracker } from "./abdication";
import { clientSlotsRegistry, type SlotRegistry } from "./registry";
import type {
  AnyFactoryKey,
  AnySlotKey,
  ChildSlotDecl,
  SlotFactoryRegistrationInput,
  SlotInspection,
  SlotRegistrationInput,
  SlotScopeAdapter,
  SlotWrapperInput,
} from "./types";

declare module "@deepseek-ai/cordis" {
  interface Context {
    slots: ClientSlotsService;
  }
}

/** Cordis Service (`ctx.slots`) exposing typed slot registration with automatic Fiber disposal. */
export class ClientSlotsService extends Service {
  static provide = "slots";
  readonly registry: SlotRegistry;

  constructor(ctx: Context, registry: SlotRegistry = clientSlotsRegistry) {
    super(ctx, "slots");
    this.registry = registry;
  }

  get stores(): SlotStoreRegistry {
    return this.registry.stores;
  }

  get abdication(): AbdicationTracker {
    return this.registry.abdication;
  }

  get overrides(): SlotOverridesStore {
    return this.registry.overrides;
  }

  private track(dispose: () => void): () => void {
    let disposed = false;
    const once = () => {
      if (disposed) return;
      disposed = true;
      dispose();
    };
    return this.ctx.effect(() => once);
  }

  defineSlot(slotKey: string, spec: ChildSlotDecl): () => void {
    return this.track(this.registry.defineSlot(slotKey, spec));
  }

  register<K extends AnySlotKey, TStore = unknown, TSelected = unknown>(
    slotKey: K,
    input: SlotRegistrationInput<K, TStore, TSelected>,
  ): () => void {
    return this.track(this.registry.register(slotKey, input, this.ctx));
  }

  registerFactory<K extends AnyFactoryKey, TStore = unknown>(
    factoryKey: K,
    input: SlotFactoryRegistrationInput<K, TStore>,
  ): () => void {
    return this.track(this.registry.registerFactory(factoryKey, input, this.ctx));
  }

  wrap<K extends AnySlotKey>(slotKey: K, input: SlotWrapperInput<K>): () => void {
    return this.track(this.registry.wrap(slotKey, input, this.ctx));
  }

  setScopeAdapter(adapter: SlotScopeAdapter | undefined): void {
    this.registry.setScopeAdapter(adapter);
  }

  getScopeAdapter(): SlotScopeAdapter | undefined {
    return this.registry.getScopeAdapter();
  }

  onAbdicate(listener: AbdicationListener): () => void {
    return this.track(this.registry.abdication.onAbdicate(listener));
  }

  inspectSlot(slotKey: string): SlotInspection {
    return this.registry.inspectSlot(slotKey);
  }

  inspectAllSlots(): SlotInspection[] {
    return this.registry.inspectAllSlots();
  }
}
