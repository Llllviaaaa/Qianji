import type * as PIXI from "pixi.js";

export type {
  Cubism4InternalModel,
  Cubism4ModelSettings,
  InternalModel,
  Live2DFactoryOptions,
  Live2DModel,
  ModelSettings,
} from "pixi-live2d-display-lipsyncpatch/cubism4";

declare global {
  interface Window {
    PIXI?: typeof PIXI;
    Live2DCubismCore?: {
      readonly Version?: {
        readonly csmGetVersion?: () => number;
      };
      readonly Moc?: unknown;
      readonly Model?: unknown;
    };
  }
}
