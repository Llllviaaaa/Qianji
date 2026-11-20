/**
 * Pure leaf WeakMap associating Cordis Fiber objects with owning plugin IDs.
 *
 * Lives in `src/kernel/runtime/` with zero upstream imports so low-level
 * kernel modules (`src/kernel/slots/*`) never cycle through `src/lib/*`.
 */
const fiberToPluginId = new WeakMap<object, string>();

/** Associate a Cordis Fiber object with an owning plugin ID. */
export function tagFiberPluginId(fiber: object, pluginId: string): void {
  fiberToPluginId.set(fiber, pluginId);
}

/** Walk a Cordis `Context`'s fiber ancestry to determine which plugin owns the call. */
export function resolveContextPluginId(ctx: unknown): string | undefined {
  if (typeof ctx !== "object" || ctx === null) return undefined;
  let cursor: unknown = (ctx as { fiber?: unknown }).fiber;
  let guard = 0;
  while (typeof cursor === "object" && cursor !== null && guard < 32) {
    const tagged = fiberToPluginId.get(cursor);
    if (tagged !== undefined) return tagged;
    cursor = (cursor as { parent?: { fiber?: unknown } }).parent?.fiber;
    guard += 1;
  }
  return undefined;
}
