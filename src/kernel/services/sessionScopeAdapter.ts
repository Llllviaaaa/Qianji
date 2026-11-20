/**
 * Bridges `SessionService` into `ClientSlotsService` (`SlotScopeAdapter`) so
 * `"session"` and `"session-maybe"` slots resolve the ambient active session ID
 * reactively and retain/release ref-counted `SessionHandle`s on `<SessionArea>`
 * mount/unmount (ADR 0023 Phase 1 + Phase 2 integration).
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ClientSlotsService, SlotScopeAdapter } from "../slots";
import type { SessionService } from "./sessionService";

/**
 * Create a `SlotScopeAdapter` backed by Qianji's frontend `SessionService`.
 */
export function createSessionScopeAdapter(sessionService: SessionService): SlotScopeAdapter {
  const resolveActiveId = (): string | null => {
    const snap = sessionService.getSnapshot();
    if (snap.sessionId !== null && snap.sessionId !== "") {
      return snap.sessionId;
    }
    if (snap.sessionFile !== null && snap.sessionFile !== "") {
      return snap.sessionFile;
    }
    return null;
  };

  return {
    getActiveSessionId: resolveActiveId,
    subscribeActiveSession(listener: () => void): () => void {
      let lastId = resolveActiveId();
      return sessionService.subscribe(() => {
        const nextId = resolveActiveId();
        if (nextId !== lastId) {
          lastId = nextId;
          listener();
        }
      });
    },
    onScopeMount(_scopeKey: string, sessionId: string): () => void {
      const handle = sessionService.retain(sessionId);
      return () => {
        handle.release();
      };
    },
  };
}

/**
 * Install `SessionScopeAdapter` on `root` once both `slots` (`ClientSlotsService`)
 * and `sessionService` (`SessionService`) are active, with automatic cleanup when
 * either service reloads or the returned disposer is called.
 */
export function installSessionScopeAdapter(root: Context): () => void {
  let installedAdapter: SlotScopeAdapter | undefined;
  let installedSlots: ClientSlotsService | undefined;

  const bind = (slots: ClientSlotsService, sessionService: SessionService): void => {
    if (installedAdapter !== undefined && installedSlots === slots) return;
    const adapter = createSessionScopeAdapter(sessionService);
    installedAdapter = adapter;
    installedSlots = slots;
    slots.setScopeAdapter(adapter);
  };

  const cleanup = (): void => {
    if (installedSlots !== undefined && installedAdapter !== undefined) {
      if (installedSlots.getScopeAdapter() === installedAdapter) {
        installedSlots.setScopeAdapter(undefined);
      }
    }
    installedAdapter = undefined;
    installedSlots = undefined;
  };

  const eagerSlots = root.get("slots");
  const eagerSession = root.get("sessionService");
  if (eagerSlots !== undefined && eagerSession !== undefined) {
    bind(eagerSlots, eagerSession);
  }

  const fiber = root.inject(["slots", "sessionService"], (ctx) => {
    bind(ctx.slots, ctx.sessionService);
    ctx.effect(() => cleanup);
  });

  return () => {
    cleanup();
    void fiber.dispose().catch(() => undefined);
  };
}
