/**
 * Frameless Ambient Character Aura & Full-Bleed Gallery `ExhibitionBackdrop`
 * (`src/builtin-plugins/bot-mode/live2d/parallaxBackdrop.tsx`).
 *
 * Adheres strictly to `baseline-ui` & `craft-floor`:
 * - Ultra-subtle neutral/warm radial aura (`opacity <= 0.13`, zero rectangular
 *   edges, zero CSS `blur()` filters on moving `transform` layers) so Companion
 *   and Hero blend seamlessly into `--qj-bg-app`.
 * - Respects `prefers-reduced-motion: reduce` across all inertial parallax layers.
 */
import { useEffect, useRef, useSyncExternalStore, type ReactElement } from "react";
import type { Live2DBackdropThemeId } from "./types";

function subscribeHtmlTheme(onChange: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    return () => undefined;
  }
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

function getHtmlIsLightSnapshot(): boolean {
  if (typeof document === "undefined") return true;
  return document.documentElement.getAttribute("data-theme") === "light";
}

function getServerIsLightSnapshot(): boolean {
  return false;
}

export function useIsLightDocumentTheme(): boolean {
  return useSyncExternalStore(
    subscribeHtmlTheme,
    getHtmlIsLightSnapshot,
    getServerIsLightSnapshot,
  );
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface AmbientCharacterAuraProps {
  readonly accentHex: string;
  readonly glowHex: string;
  readonly showFloorShadow: boolean;
  readonly isCardPreview: boolean;
}

export function AmbientCharacterAura({
  accentHex,
  glowHex,
  showFloorShadow,
  isCardPreview,
}: AmbientCharacterAuraProps): ReactElement {
  const isLight = useIsLightDocumentTheme();

  return (
    <>
      <div
        className="qj-l2d-ambient-aura"
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: "4%",
          zIndex: 1,
          pointerEvents: "none",
          borderRadius: "50%",
          opacity: isCardPreview ? 0.09 : isLight ? 0.13 : 0.11,
          background: `radial-gradient(circle at 50% 44%, color-mix(in srgb, ${glowHex} 42%, var(--qj-bg-subtle)) 0%, color-mix(in srgb, ${accentHex} 18%, transparent) 44%, transparent 70%)`,
          transform:
            "translate3d(calc(var(--l2d-px, 0) * -4px), calc(var(--l2d-py, 0) * -3px), 0)",
        }}
      />

      {showFloorShadow && !isCardPreview && (
        <div
          className="qj-l2d-floor-shadow"
          aria-hidden="true"
          style={{
            position: "absolute",
            left: "24%",
            right: "24%",
            bottom: "3.5%",
            height: "6.5%",
            zIndex: 2,
            pointerEvents: "none",
            borderRadius: "50%",
            background: isLight
              ? "radial-gradient(ellipse at 50% 50%, rgba(15, 23, 42, 0.14) 0%, rgba(15, 23, 42, 0.04) 54%, transparent 76%)"
              : "radial-gradient(ellipse at 50% 50%, rgba(0, 0, 0, 0.32) 0%, rgba(0, 0, 0, 0.1) 54%, transparent 76%)",
          }}
        />
      )}
    </>
  );
}

interface GalleryPalette {
  readonly baseGradient: string;
  readonly bloomPrimary: string;
  readonly bloomSecondary: string;
  readonly beamGradient: string;
  readonly moteColor: string;
  readonly isDarkSurface: boolean;
}

function resolveGalleryPalette(theme: Live2DBackdropThemeId, isLight: boolean): GalleryPalette {
  if (theme === "velvet-night") {
    return {
      baseGradient: "linear-gradient(145deg, #151926 0%, #10131e 54%, #0b0d15 100%)",
      bloomPrimary: "rgba(96, 165, 250, 0.14)",
      bloomSecondary: "rgba(167, 139, 250, 0.1)",
      beamGradient: "linear-gradient(125deg, rgba(186, 230, 253, 0.07) 0%, transparent 62%)",
      moteColor: "rgba(226, 232, 240, 0.28)",
      isDarkSurface: true,
    };
  }

  if (theme === "sunlit-window") {
    if (isLight) {
      return {
        baseGradient: "linear-gradient(145deg, #fdfbf6 0%, #faf3e6 52%, #f5e9d6 100%)",
        bloomPrimary: "rgba(251, 191, 36, 0.18)",
        bloomSecondary: "rgba(253, 186, 116, 0.16)",
        beamGradient: "linear-gradient(122deg, rgba(255, 251, 235, 0.72) 0%, rgba(254, 243, 199, 0.24) 38%, transparent 68%)",
        moteColor: "rgba(245, 158, 11, 0.24)",
        isDarkSurface: false,
      };
    }
    return {
      baseGradient: "linear-gradient(145deg, #211a18 0%, #2b211d 54%, #1a1413 100%)",
      bloomPrimary: "rgba(245, 158, 11, 0.15)",
      bloomSecondary: "rgba(251, 146, 60, 0.12)",
      beamGradient: "linear-gradient(122deg, rgba(254, 215, 170, 0.1) 0%, transparent 64%)",
      moteColor: "rgba(253, 224, 71, 0.22)",
      isDarkSurface: true,
    };
  }

  if (theme === "stardust-sanctuary") {
    if (isLight) {
      return {
        baseGradient: "linear-gradient(145deg, #f8f5fe 0%, #f1ecfb 52%, #e9e1f8 100%)",
        bloomPrimary: "rgba(168, 85, 247, 0.15)",
        bloomSecondary: "rgba(103, 232, 249, 0.13)",
        beamGradient: "linear-gradient(128deg, rgba(255, 255, 255, 0.64) 0%, rgba(233, 213, 255, 0.2) 42%, transparent 70%)",
        moteColor: "rgba(147, 51, 234, 0.18)",
        isDarkSurface: false,
      };
    }
    return {
      baseGradient: "linear-gradient(145deg, #171429 0%, #221b3b 54%, #131022 100%)",
      bloomPrimary: "rgba(168, 85, 247, 0.18)",
      bloomSecondary: "rgba(56, 189, 248, 0.12)",
      beamGradient: "linear-gradient(128deg, rgba(216, 180, 254, 0.09) 0%, transparent 65%)",
      moteColor: "rgba(216, 180, 254, 0.25)",
      isDarkSurface: true,
    };
  }

  // `"atelier-aurora"` (`极光画室`, default)
  if (isLight) {
    return {
      baseGradient: "linear-gradient(145deg, #f9fafe 0%, #f2f5fc 52%, #ecf0f9 100%)",
      bloomPrimary: "rgba(124, 156, 255, 0.16)",
      bloomSecondary: "rgba(244, 180, 212, 0.14)",
      beamGradient: "linear-gradient(125deg, rgba(255, 255, 255, 0.76) 0%, rgba(224, 231, 255, 0.26) 40%, transparent 68%)",
      moteColor: "rgba(99, 102, 241, 0.18)",
      isDarkSurface: false,
    };
  }
  return {
    baseGradient: "linear-gradient(145deg, #151828 0%, #1d2238 54%, #121522 100%)",
    bloomPrimary: "rgba(124, 156, 255, 0.16)",
    bloomSecondary: "rgba(196, 181, 253, 0.12)",
    beamGradient: "linear-gradient(125deg, rgba(199, 210, 254, 0.09) 0%, transparent 64%)",
    moteColor: "rgba(199, 210, 254, 0.24)",
    isDarkSurface: true,
  };
}

export interface ExhibitionBackdropProps {
  readonly theme: Live2DBackdropThemeId;
  readonly accentHex?: string;
  readonly glowHex?: string;
  readonly parallaxStrength?: number;
  readonly className?: string;
}

export function ExhibitionBackdrop({
  theme,
  parallaxStrength = 1,
  className = "",
}: ExhibitionBackdropProps): ReactElement {
  const isLight = useIsLightDocumentTheme();
  const palette = resolveGalleryPalette(theme, isLight);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const strengthRef = useRef(parallaxStrength);

  useEffect(() => {
    strengthRef.current = parallaxStrength;
  }, [parallaxStrength]);

  useEffect(() => {
    if (typeof window === "undefined" || prefersReducedMotion()) return undefined;
    let targetX = 0;
    let targetY = 0;
    let smoothX = 0;
    let smoothY = 0;
    let rafId = 0;

    const onMove = (ev: PointerEvent): void => {
      if (window.innerWidth <= 0 || window.innerHeight <= 0) return;
      targetX = ((ev.clientX / window.innerWidth) * 2 - 1) * strengthRef.current;
      targetY = ((ev.clientY / window.innerHeight) * 2 - 1) * strengthRef.current;
    };

    const tick = (): void => {
      rafId = window.requestAnimationFrame(tick);
      smoothX += (targetX - smoothX) * 0.1;
      smoothY += (targetY - smoothY) * 0.1;
      const el = hostRef.current;
      if (el !== null) {
        el.style.setProperty("--exh-px", smoothX.toFixed(4));
        el.style.setProperty("--exh-py", smoothY.toFixed(4));
      }
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    rafId = window.requestAnimationFrame(tick);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.cancelAnimationFrame(rafId);
    };
  }, []);

  return (
    <div
      ref={hostRef}
      className={`qj-l2d-exhibition-backdrop${className ? ` ${className}` : ""}`}
      data-backdrop-theme={theme}
      data-backdrop-surface={palette.isDarkSurface ? "dark" : "light"}
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 0,
        overflow: "hidden",
        pointerEvents: "none",
        background: palette.baseGradient,
      }}
    >
      {/* Far watercolor radial wash & diagonal studio sunbeam (pure transform, zero CSS blur filter!) */}
      <div
        style={{
          position: "absolute",
          inset: -28,
          transform:
            "translate3d(calc(var(--exh-px, 0) * -14px), calc(var(--exh-py, 0) * -10px), 0)",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: "-4%",
            top: "-18%",
            width: "68%",
            height: "78%",
            borderRadius: "50%",
            background: `radial-gradient(circle, ${palette.bloomPrimary} 0%, transparent 68%)`,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: "22%",
            bottom: "-22%",
            width: "66%",
            height: "74%",
            borderRadius: "50%",
            background: `radial-gradient(circle, ${palette.bloomSecondary} 0%, transparent 70%)`,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: "-6%",
            top: "-10%",
            width: "78%",
            height: "92%",
            background: palette.beamGradient,
            transform: "skewX(-16deg)",
          }}
        />
      </div>

      {/* Mid-plane soft bokeh motes (pure radial gradients, zero CSS blur filter!) */}
      <div
        style={{
          position: "absolute",
          inset: -16,
          transform:
            "translate3d(calc(var(--exh-px, 0) * -7px), calc(var(--exh-py, 0) * -5px), 0)",
        }}
      >
        {[
          { left: "14%", top: "22%", size: 12 },
          { left: "44%", top: "16%", size: 9 },
          { left: "49%", top: "64%", size: 14 },
          { left: "11%", top: "70%", size: 10 },
          { left: "34%", top: "34%", size: 8 },
        ].map((mote, idx) => (
          <span
            key={idx}
            style={{
              position: "absolute",
              left: mote.left,
              top: mote.top,
              width: mote.size,
              height: mote.size,
              borderRadius: "50%",
              background: `radial-gradient(circle, ${palette.moteColor} 0%, transparent 72%)`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
