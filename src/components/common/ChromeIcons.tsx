import { useId } from "react";

export interface DockIconProps {
  open?: boolean;
  size?: number;
}

export function DockLeftIcon({ open = false, size = 15 }: DockIconProps) {
  const clipId = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <defs>
        <clipPath id={clipId}>
          <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2.5" />
        </clipPath>
      </defs>
      <rect
        x="1.75"
        y="2.25"
        width="4.5"
        height="11.5"
        fill="currentColor"
        fillOpacity={open ? 0.78 : 0.14}
        clipPath={`url(#${clipId})`}
      />
      <path d="M6.25 2.5V13.5" stroke="currentColor" strokeWidth="1.25" />
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function DockBottomIcon({ open = false, size = 15 }: DockIconProps) {
  const clipId = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <defs>
        <clipPath id={clipId}>
          <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2.5" />
        </clipPath>
      </defs>
      <rect
        x="1.75"
        y="9.25"
        width="12.5"
        height="4.5"
        fill="currentColor"
        fillOpacity={open ? 0.78 : 0.14}
        clipPath={`url(#${clipId})`}
      />
      <path d="M2 9.25H14" stroke="currentColor" strokeWidth="1.25" />
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function DockRightIcon({ open = false, size = 15 }: DockIconProps) {
  const clipId = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <defs>
        <clipPath id={clipId}>
          <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2.5" />
        </clipPath>
      </defs>
      <rect
        x="9.75"
        y="2.25"
        width="4.5"
        height="11.5"
        fill="currentColor"
        fillOpacity={open ? 0.78 : 0.14}
        clipPath={`url(#${clipId})`}
      />
      <path d="M9.75 2.5V13.5" stroke="currentColor" strokeWidth="1.25" />
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function ChromeSearchIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.35" stroke="currentColor" strokeWidth="1.35" />
      <path d="M10.2 10.2L13.3 13.3" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
    </svg>
  );
}

export function ChromeInboxIcon({ active = false, size = 15 }: { active?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 9.25H5.55L6.45 10.75H9.55L10.45 9.25H13.5V11.3C13.5 12.35 12.65 13.2 11.6 13.2H4.4C3.35 13.2 2.5 12.35 2.5 11.3V9.25Z"
        fill="currentColor"
        fillOpacity={active ? 0.22 : 0.1}
      />
      <path
        d="M2.5 9.25H5.55L6.45 10.75H9.55L10.45 9.25H13.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <rect x="2.25" y="2.5" width="11.5" height="11" rx="2.4" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function ChromePinIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M9.7 2.5L13.5 6.3L12 7.2L10.2 5.4L7.9 8.7L8.6 10.7L7.7 11.6L5.9 9.8L2.7 13.3L6.2 10.1L4.4 8.3L5.3 7.4L7.3 8.1L10.6 5.8L8.8 4L9.7 2.5Z"
        fill="currentColor"
        fillOpacity="0.14"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ChromeChevronDownIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M3 4.5L6 7.5L9 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ChromeFolderIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.25 4.25C2.25 3.42 2.92 2.75 3.75 2.75H6.2C6.64 2.75 7.05 2.94 7.34 3.28L8.15 4.25H12.25C13.08 4.25 13.75 4.92 13.75 5.75V11.75C13.75 12.58 13.08 13.25 12.25 13.25H3.75C2.92 13.25 2.25 12.58 2.25 11.75V4.25Z"
        fill="currentColor"
        fillOpacity="0.1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CursorGlyph({ size = 15, monochrome = false }: { size?: number; monochrome?: boolean }) {
  if (monochrome) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 1.6L13.6 4.85L8 8.1L2.4 4.85L8 1.6Z" fill="currentColor" fillOpacity="0.08" />
        <path d="M2.4 4.85L8 8.1V14.4L2.4 11.15V4.85Z" fill="currentColor" fillOpacity="0.2" />
        <path d="M13.6 4.85L8 8.1V14.4L13.6 11.15V4.85Z" fill="currentColor" fillOpacity="0.34" />
        <path
          d="M8 1.6L13.6 4.85V11.15L8 14.4L2.4 11.15V4.85L8 1.6Z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <path d="M2.6 4.95L8 8.1L13.4 4.95M8 8.1V14.2" stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect width="24" height="24" rx="5.5" fill="#1b1c1f" />
      <rect x="0.5" y="0.5" width="23" height="23" rx="5" stroke="#ffffff" strokeOpacity="0.12" />
      <path d="M12 5.4 18 8.85 12 12.3 6 8.85 12 5.4Z" fill="#f7f7f7" />
      <path d="M6 8.85 12 12.3v6.3l-6-3.45v-6.3Z" fill="#a7a7a7" />
      <path d="M18 8.85 12 12.3v6.3l6-3.45v-6.3Z" fill="#d7d7d7" />
    </svg>
  );
}

export function VsCodeGlyph({ size = 15, monochrome = false }: { size?: number; monochrome?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <path
        d="M96.461 10.796 75.857.876c-2.385-1.149-5.235-.664-7.107 1.207L1.299 63.583c-1.815 1.654-1.813 4.511.004 6.162l5.51 5.009c1.485 1.35 3.722 1.45 5.321.237l81.227-61.621c2.725-2.067 6.639-.124 6.639 3.297v-.239c0-2.402-1.375-4.59-3.539-5.632Z"
        fill={monochrome ? "currentColor" : "#0065A9"}
        fillOpacity={monochrome ? 0.58 : 1}
      />
      <path
        d="M96.461 89.204 75.857 99.124c-2.385 1.149-5.235.665-7.107-1.207L1.299 36.417c-1.815-1.654-1.813-4.511.004-6.162l5.51-5.009c1.485-1.35 3.722-1.45 5.321-.236l81.227 61.62c2.725 2.067 6.639.124 6.639-3.297v.24c0 2.401-1.375 4.59-3.539 5.631Z"
        fill={monochrome ? "currentColor" : "#007ACC"}
        fillOpacity={monochrome ? 0.78 : 1}
      />
      <path
        d="M75.858 99.126c-2.386 1.148-5.236.663-7.108-1.209 2.306 2.306 6.25.673 6.25-2.589V4.672c0-3.262-3.944-4.895-6.25-2.589C70.622.211 73.472-.274 75.858.874l20.601 9.907C98.623 11.822 100 14.011 100 16.413v67.174c0 2.402-1.377 4.592-3.541 5.633L75.858 99.126Z"
        fill={monochrome ? "currentColor" : "#1F9CF0"}
      />
    </svg>
  );
}

export function AntigravityMonochromeGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 2.25L13.1 13.15C11.55 11.35 9.95 10.35 8 10.35C6.05 10.35 4.45 11.35 2.9 13.15L8 2.25Z"
        fill="currentColor"
        fillOpacity="0.18"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
