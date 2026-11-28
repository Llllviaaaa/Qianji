/**
 * Opt-In Local 20fps Webcam Head Parallax Tracker for Qianji 2.5D Live2D Stage
 * (`src/builtin-plugins/bot-mode/live2d/webcamTracker.ts`).
 *
 * - Runs strictly locally inside an unattached `64 × 48` canvas (`FaceDetector`
 *   when supported + YCbCr skin-chrominance/luminance centroid fallback).
 * - Mirrors sensor X so moving physically right (`+X`) shifts `nx > 0`.
 * - Zero network requests; cleanly stops all `MediaStreamTrack`s on teardown.
 */
import type { HeadTrackingStatus } from "./types";

export interface WebcamHeadTrackerOptions {
  readonly smoothing?: number;
  readonly targetFps?: number;
  readonly onHeadMove: (nx: number, ny: number) => void;
  readonly onStatusChange?: (status: HeadTrackingStatus) => void;
}

export interface WebcamHeadTrackerHandle {
  readonly stop: () => void;
}

interface ExperimentalFaceBox {
  readonly boundingBox?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

interface ExperimentalFaceDetector {
  detect(source: CanvasImageSource): Promise<ReadonlyArray<ExperimentalFaceBox>>;
}

type ExperimentalFaceDetectorCtor = new (options?: {
  readonly fastMode?: boolean;
  readonly maxDetectedFaces?: number;
}) => ExperimentalFaceDetector;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function tryCreateBrowserFaceDetector(): ExperimentalFaceDetector | null {
  if (typeof window === "undefined") return null;
  const maybeCtor = (window as unknown as { readonly FaceDetector?: ExperimentalFaceDetectorCtor })
    .FaceDetector;
  if (typeof maybeCtor !== "function") return null;
  try {
    return new maybeCtor({ fastMode: true, maxDetectedFaces: 1 });
  } catch {
    return null;
  }
}

function estimateHeadCentroidFromPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): { readonly cx: number; readonly cy: number } | null {
  let weightedX = 0;
  let weightedY = 0;
  let totalWeight = 0;

  for (let y = 0; y < height; y += 1) {
    const ny = (y + 0.5) / height;
    const verticalPrior = Math.exp(-((ny - 0.44) * (ny - 0.44)) / 0.16);
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      const r = pixels[idx] ?? 0;
      const g = pixels[idx + 1] ?? 0;
      const b = pixels[idx + 2] ?? 0;

      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      if (luma < 24 || luma > 246) continue;

      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      const isSkinTone = cb >= 76 && cb <= 132 && cr >= 131 && cr <= 178;

      const nx = (x + 0.5) / width;
      const horizontalPrior = Math.exp(-((nx - 0.5) * (nx - 0.5)) / 0.28);
      const skinBoost = isSkinTone ? 4.2 : 0.22 * (luma / 255);
      const weight = skinBoost * verticalPrior * horizontalPrior;

      weightedX += nx * weight;
      weightedY += ny * weight;
      totalWeight += weight;
    }
  }

  if (totalWeight < 6) return null;
  return { cx: weightedX / totalWeight, cy: weightedY / totalWeight };
}

export function startWebcamHeadTracker(
  options: WebcamHeadTrackerOptions,
): WebcamHeadTrackerHandle {
  const smoothing = clamp(options.smoothing ?? 0.24, 0.05, 0.85);
  const intervalMs = Math.round(1000 / clamp(options.targetFps ?? 20, 8, 30));

  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    typeof navigator === "undefined" ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== "function"
  ) {
    options.onStatusChange?.("fallback");
    return { stop: () => undefined };
  }

  let disposed = false;
  let stream: MediaStream | null = null;
  let videoEl: HTMLVideoElement | null = null;
  let timerId: number | null = null;
  let detectBusy = false;
  let smoothX = 0;
  let smoothY = 0;

  const SAMPLE_W = 64;
  const SAMPLE_H = 48;
  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = SAMPLE_W;
  sampleCanvas.height = SAMPLE_H;
  const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
  const faceDetector = tryCreateBrowserFaceDetector();
  let faceDetectorFailed = false;

  const stopTracks = (): void => {
    if (timerId !== null) {
      window.clearInterval(timerId);
      timerId = null;
    }
    if (videoEl !== null) {
      videoEl.pause();
      videoEl.srcObject = null;
      videoEl = null;
    }
    if (stream !== null) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      stream = null;
    }
  };

  const applyNormalizedEstimate = (sensorCx: number, sensorCy: number): void => {
    const targetX = clamp((0.5 - sensorCx) * 2.75, -1, 1);
    const targetY = clamp((0.46 - sensorCy) * 2.45, -1, 1);
    smoothX += (targetX - smoothX) * smoothing;
    smoothY += (targetY - smoothY) * smoothing;
    options.onHeadMove(smoothX, smoothY);
  };

  options.onStatusChange?.("requesting");

  void navigator.mediaDevices
    .getUserMedia({
      video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: "user" },
      audio: false,
    })
    .then(async (mediaStream) => {
      if (disposed) {
        for (const track of mediaStream.getTracks()) track.stop();
        return;
      }
      stream = mediaStream;
      const firstTrack = mediaStream.getVideoTracks()[0];
      if (firstTrack) {
        firstTrack.addEventListener("ended", () => {
          if (!disposed) {
            stopTracks();
            options.onStatusChange?.("fallback");
          }
        });
      }

      const video = document.createElement("video");
      video.playsInline = true;
      video.muted = true;
      video.autoplay = true;
      video.srcObject = mediaStream;
      videoEl = video;

      try {
        await video.play();
      } catch {
        // Proceed once metadata frames arrive.
      }
      if (disposed) {
        stopTracks();
        return;
      }

      options.onStatusChange?.("active");

      timerId = window.setInterval(() => {
        if (disposed || detectBusy || videoEl === null || videoEl.readyState < 2) return;
        const vw = videoEl.videoWidth || 320;
        const vh = videoEl.videoHeight || 240;

        if (faceDetector !== null && !faceDetectorFailed) {
          detectBusy = true;
          void faceDetector
            .detect(videoEl)
            .then((faces) => {
              detectBusy = false;
              if (disposed) return;
              const box = faces[0]?.boundingBox;
              if (box && vw > 0 && vh > 0) {
                applyNormalizedEstimate((box.x + box.width * 0.5) / vw, (box.y + box.height * 0.45) / vh);
                return;
              }
              if (sampleCtx !== null) {
                sampleCtx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
                const est = estimateHeadCentroidFromPixels(
                  sampleCtx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data,
                  SAMPLE_W,
                  SAMPLE_H,
                );
                if (est !== null) applyNormalizedEstimate(est.cx, est.cy);
              }
            })
            .catch(() => {
              detectBusy = false;
              faceDetectorFailed = true;
            });
          return;
        }

        if (sampleCtx !== null) {
          sampleCtx.drawImage(videoEl, 0, 0, SAMPLE_W, SAMPLE_H);
          const est = estimateHeadCentroidFromPixels(
            sampleCtx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data,
            SAMPLE_W,
            SAMPLE_H,
          );
          if (est !== null) applyNormalizedEstimate(est.cx, est.cy);
        }
      }, intervalMs);
    })
    .catch(() => {
      if (!disposed) {
        stopTracks();
        options.onStatusChange?.("fallback");
      }
    });

  return {
    stop: () => {
      if (disposed) return;
      disposed = true;
      stopTracks();
    },
  };
}
