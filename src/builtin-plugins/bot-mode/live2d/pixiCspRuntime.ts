/**
 * Strict-CSP PixiJS v7 Runtime Bootstrap (`pixiCspRuntime.ts`).
 *
 * Packaged Tauri builds enforce `script-src 'self' blob: 'wasm-unsafe-eval'`
 * (no `'unsafe-eval'`). Without `@pixi/unsafe-eval`, `PIXI.ShaderSystem.prototype.systemCheck`
 * throws on `new PIXI.Renderer(...)`, leaving `<Live2DViewport>` blank/white.
 *
 * In addition, disabling `CREATE_IMAGE_BITMAP` and `@pixi/assets` Web Workers ensures
 * `PIXI.ImageResource` uploads decoded `HTMLImageElement` textures synchronously to WebGL
 * without secondary `fetch(..., { mode: "cors" })` round-trips or premature `ImageBitmap.close()`
 * eviction across `http://tauri.localhost/` and `blob:` custom ZIP packages.
 */
import * as PIXI from "pixi.js";
import "@pixi/unsafe-eval";

let configured = false;

interface PixiLoadTexturesParser {
  config?: {
    preferWorkers?: boolean;
    preferCreateImageBitmap?: boolean;
  };
}

export function ensurePixiCspRuntime(): typeof PIXI {
  if (!configured) {
    PIXI.settings.CREATE_IMAGE_BITMAP = false;
    const maybeLoadTextures = (PIXI as unknown as { loadTextures?: PixiLoadTexturesParser })
      .loadTextures;
    if (maybeLoadTextures?.config !== undefined) {
      maybeLoadTextures.config.preferWorkers = false;
      maybeLoadTextures.config.preferCreateImageBitmap = false;
    }
    configured = true;
  }
  if (typeof window !== "undefined") {
    (window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI;
  }
  return PIXI;
}

ensurePixiCspRuntime();

export { PIXI };
