/**
 * Crisp vector brand icons for Qianji Bot Mode Connectors (`BotConnectorLogos.tsx`).
 */
import type { ReactElement } from "react";
import { Blocks, Cpu, FileText, Mail, Webhook } from "lucide-react";

function GmailSvg(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="60%" height="60%" aria-hidden="true">
      <path fill="#4285F4" d="M3 7.2V18a1.5 1.5 0 0 0 1.5 1.5H7V11L3 7.2Z" />
      <path fill="#34A853" d="M21 7.2V18a1.5 1.5 0 0 1-1.5 1.5H17V11l4-3.8Z" />
      <path fill="#FBBC05" d="M17 11V5.6l2.2-1.4A1.5 1.5 0 0 1 21 5.4v1.8L17 11Z" />
      <path fill="#EA4335" d="M7 11V5.6L12 9.4l5-3.8V11l-5 3.7L7 11Z" />
      <path fill="#C5221F" d="M3 5.4A1.5 1.5 0 0 1 4.8 4.2L7 5.6V11L3 7.2V5.4Z" />
    </svg>
  );
}

function OutlookSvg(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="60%" height="60%" aria-hidden="true">
      <rect x="9" y="5" width="12" height="14" rx="2" fill="#0A66C2" />
      <path fill="#50B5FF" d="M9 9.5 15 13l6-3.5V7a2 2 0 0 0-2-2H9v4.5Z" />
      <rect x="2.5" y="7" width="10.5" height="10" rx="2" fill="#0078D4" />
      <circle cx="7.75" cy="12" r="2.6" fill="none" stroke="#fff" strokeWidth="1.7" />
    </svg>
  );
}

function GoogleDriveSvg(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="60%" height="60%" aria-hidden="true">
      <path fill="#0066DA" d="m4.2 15.2 2.4 4.1h10.8l2.4-4.1H4.2Z" />
      <path fill="#00AC47" d="M9.6 5.3 4.2 15.2l2.4 4.1 5.4-9.9-2.4-4.1Z" />
      <path fill="#EA4335" d="m14.4 5.3-2.4 4.1 5.4 9.9 2.4-4.1-5.4-9.9Z" />
      <path fill="#FFBA00" d="M9.6 5.3h4.8l5.4 9.9H15L9.6 5.3Z" opacity="0.92" />
    </svg>
  );
}

function CalendarSvg(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="60%" height="60%" aria-hidden="true">
      <rect x="4" y="5" width="16" height="15" rx="2.6" fill="#fff" stroke="#4285F4" strokeWidth="1.7" />
      <path fill="#4285F4" d="M4 7.6A2.6 2.6 0 0 1 6.6 5h10.8A2.6 2.6 0 0 1 20 7.6V9H4V7.6Z" />
      <text x="12" y="16.5" textAnchor="middle" fill="#1A73E8" fontSize="7.8" fontWeight="700" fontFamily="sans-serif">26</text>
    </svg>
  );
}

function GitHubSvg(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="62%" height="62%" fill="#181717" aria-hidden="true">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z" />
    </svg>
  );
}

function NotionSvg(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="60%" height="60%" aria-hidden="true">
      <path fill="#111827" d="M5.2 4.5 16.5 3.6c.9-.1 1.4.2 2 .6l1.7 1.2c.4.3.5.5.5.9v12.8c0 .8-.3 1.3-1.2 1.4l-12 .7c-.8 0-1.2-.2-1.7-.8l-1.9-2.4c-.4-.6-.6-1-.6-1.7V5.9c0-.8.3-1.3 1.9-1.4Z" />
      <rect x="6.5" y="6.2" width="11.5" height="12.6" rx="1.2" fill="#fff" />
      <path fill="#111827" d="M9.1 15.8V9.2h1.5l3.2 4.4V9.2h1.4v6.6h-1.4l-3.3-4.5v4.5H9.1Z" />
    </svg>
  );
}

function SlackSvg(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="60%" height="60%" aria-hidden="true">
      <rect x="9.5" y="3" width="2.4" height="7" rx="1.2" fill="#36C5F0" />
      <rect x="3" y="9.5" width="7" height="2.4" rx="1.2" fill="#E01E5A" />
      <rect x="14" y="12.1" width="7" height="2.4" rx="1.2" fill="#2EB67D" />
      <rect x="12.1" y="14" width="2.4" height="7" rx="1.2" fill="#ECB22E" />
      <circle cx="7.2" cy="7.2" r="1.4" fill="#36C5F0" />
      <circle cx="16.8" cy="7.2" r="1.4" fill="#2EB67D" />
      <circle cx="7.2" cy="16.8" r="1.4" fill="#E01E5A" />
      <circle cx="16.8" cy="16.8" r="1.4" fill="#ECB22E" />
    </svg>
  );
}

function FeishuSvg(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="60%" height="60%" aria-hidden="true">
      <path fill="#00D6B9" d="M4.5 6.2 14.2 3.5l5.3 4.8-8.2 3.8L4.5 6.2Z" />
      <path fill="#3370FF" d="M4.5 6.2 11.3 12.1l8.2 5.4-9.8 3-5.2-14.3Z" />
      <path fill="#133C9A" d="M11.3 12.1 19.5 8.3v9.2l-8.2-5.4Z" opacity="0.88" />
    </svg>
  );
}

function TelegramSvg(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="60%" height="60%" aria-hidden="true">
      <circle cx="12" cy="12" r="9.5" fill="#26A5E4" />
      <path fill="#fff" d="m16.7 8.1-1.9 9c-.1.6-.5.7-1 .5l-2.8-2.1-1.3 1.3c-.2.2-.3.3-.6.3l.2-2.9 5.3-4.8c.2-.2 0-.3-.3-.1l-6.6 4.1-2.8-.9c-.6-.2-.6-.6.1-.9l11-4.2c.5-.2 1 .1.8.8Z" />
    </svg>
  );
}

function FigmaSvg(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="56%" height="56%" aria-hidden="true">
      <path fill="#F24E1E" d="M8.5 3h3.5v6H8.5a3 3 0 1 1 0-6Z" />
      <path fill="#FF7262" d="M12 3h3.5a3 3 0 1 1 0 6H12V3Z" />
      <path fill="#A259FF" d="M8.5 9H12v6H8.5a3 3 0 1 1 0-6Z" />
      <circle cx="15" cy="12" r="3" fill="#1ABCFE" />
      <path fill="#0ACF83" d="M8.5 15H12v3a3 3 0 1 1-3.5-3Z" />
    </svg>
  );
}

function LinearSvg(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="58%" height="58%" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="#5E6AD2" />
      <path d="M5.5 14.5 9.5 18.5M4.8 11.4 12.6 19.2M6.2 8.2 15.8 17.8" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ExcalidrawSvg(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="58%" height="58%" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="4" fill="#6965DB" />
      <path d="M8 15.5 15.5 8m0 0H11m4.5 0v4.5" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="8.5" cy="8.5" r="1.4" fill="#A5F3FC" />
    </svg>
  );
}

function DeepWikiSvg(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="58%" height="58%" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="#0F172A" />
      <path d="M8 8.5h8M8 12h6M8 15.5h8" stroke="#38BDF8" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function CanvaSvg(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="58%" height="58%" aria-hidden="true">
      <defs><linearGradient id="cvg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#00C4CC" /><stop offset="100%" stopColor="#7D2AE8" /></linearGradient></defs>
      <circle cx="12" cy="12" r="9.5" fill="url(#cvg)" />
      <text x="12" y="15.2" textAnchor="middle" fill="#fff" fontSize="10" fontWeight="700" fontFamily="Georgia,serif">C</text>
    </svg>
  );
}

function VercelSvg(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="52%" height="52%" fill="#111827" aria-hidden="true">
      <path d="M12 4 21 19.5H3L12 4Z" />
    </svg>
  );
}

function SentrySvg(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="58%" height="58%" fill="#362D59" aria-hidden="true">
      <path d="M13.5 4.3a1.7 1.7 0 0 0-3 0L3.3 16.8a1.7 1.7 0 0 0 1.5 2.5h3.4c.2-2.7-1.1-5.1-3.1-6.5l1-1.7a9 9 0 0 1 4.6 8.2h2a11 11 0 0 0-5.6-9.8l1-1.8a13 13 0 0 1 6.7 11.6h4.4a1.7 1.7 0 0 0 1.5-2.5L13.5 4.3Z" />
    </svg>
  );
}

function CloudflareSvg(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="60%" height="60%" aria-hidden="true">
      <path fill="#F38020" d="M16.9 16.5H6.3a2.8 2.8 0 0 1-.4-5.6A4.5 4.5 0 0 1 14.5 9a3.4 3.4 0 0 1 4 3 2.5 2.5 0 0 1-1.6 4.5Z" />
    </svg>
  );
}

function AtlassianSvg(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="58%" height="58%" aria-hidden="true">
      <path fill="#2684FF" d="M8.6 11.4c-.3-.4-.9-.3-1.1.1L4.1 18.4c-.2.5.1 1 .6 1h4.6c.4 0 .7-.2.8-.6.9-2.2.3-5.2-1.5-7.4Z" />
      <path fill="#0052CC" d="M12.2 4.7c-1.8 2.8-2 6.5-.5 9.8l2 4.3c.2.4.5.6.9.6h4.7c.5 0 .8-.5.6-1L13.4 4.7c-.2-.5-.9-.5-1.2 0Z" />
    </svg>
  );
}

function StripeSvg(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="58%" height="58%" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" fill="#635BFF" />
      <path fill="#fff" d="M11.6 9.8c0-.6.5-.9 1.4-.9 1.1 0 2.3.3 3.2.8V7.1a8 8 0 0 0-3.2-.6c-2.6 0-4.3 1.3-4.3 3.5 0 3.3 4.6 2.8 4.6 4.2 0 .7-.6 1-1.5 1-1.3 0-2.7-.5-3.8-1.1v2.6c1.2.5 2.5.8 3.8.8 2.7 0 4.5-1.2 4.5-3.5 0-3.6-4.7-2.9-4.7-4.2Z" />
    </svg>
  );
}

function NetlifySvg(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="58%" height="58%" aria-hidden="true">
      <path fill="#00C7B7" d="M12 3 21 12l-9 9-9-9 9-9Z" />
      <path stroke="#fff" strokeWidth="1.6" d="M7.5 12h9M12 7.5v9" strokeLinecap="round" />
    </svg>
  );
}

const TILE_BACKGROUNDS: Readonly<Record<string, string>> = {
  gmail: "#FFFFFF",
  outlook: "#EFF6FF",
  calendar: "#EFF6FF",
  github: "#FFFFFF",
  notion: "#FFFFFF",
  slack: "#FFFFFF",
  feishu: "#ECFDF5",
  google_drive: "#F0FDF4",
  telegram: "#E0F2FE",
  meeting_notes: "#F5F3FF",
  processes: "#F0FDF4",
  excalidraw: "#EEF2FF",
  deepwiki: "#F1F5F9",
  linear: "#EEF2FF",
  figma: "#FFF7ED",
  canva: "#ECFEFF",
  atlassian: "#EFF6FF",
  vercel: "#FFFFFF",
  sentry: "#F5F3FF",
  cloudflare: "#FFF7ED",
  stripe: "#EEF2FF",
  netlify: "#ECFEFF",
  custom_webhook: "#FFF7ED",
  imap_email: "#FEF3C7",
  mcp: "#F3F4F6",
};

export function ConnectorBrandIcon({
  id,
  size = 40,
  icon,
  iconBg,
}: {
  readonly id: string;
  readonly size?: number;
  readonly icon?: string;
  readonly iconBg?: string;
}): ReactElement {
  const iconPx = Math.round(size * 0.5);
  const lookupKey = icon && TILE_BACKGROUNDS[icon] ? icon : id;
  const bg = iconBg?.trim() || TILE_BACKGROUNDS[lookupKey] || "#F3F4F6";
  let inner: ReactElement | null = null;
  if (icon) {
    const trimmed = icon.trim();
    if (/^(?:https?:\/\/|data:image\/)/i.test(trimmed)) {
      inner = (
        <img
          src={trimmed}
          alt=""
          style={{ width: "62%", height: "62%", objectFit: "contain", borderRadius: 4 }}
        />
      );
    } else if (!TILE_BACKGROUNDS[trimmed] && [...trimmed].length <= 3) {
      inner = (
        <span style={{ fontSize: Math.max(13, Math.round(size * 0.46)), lineHeight: 1, fontWeight: 600 }}>
          {trimmed}
        </span>
      );
    }
  }
  if (inner === null) {
    switch (lookupKey) {
      case "gmail": inner = <GmailSvg />; break;
      case "google_drive": inner = <GoogleDriveSvg />; break;
      case "outlook": inner = <OutlookSvg />; break;
      case "calendar": inner = <CalendarSvg />; break;
      case "github": inner = <GitHubSvg />; break;
      case "notion": inner = <NotionSvg />; break;
      case "slack": inner = <SlackSvg />; break;
      case "feishu": inner = <FeishuSvg />; break;
      case "telegram": inner = <TelegramSvg />; break;
      case "figma": inner = <FigmaSvg />; break;
      case "linear": inner = <LinearSvg />; break;
      case "excalidraw": inner = <ExcalidrawSvg />; break;
      case "deepwiki": inner = <DeepWikiSvg />; break;
      case "canva": inner = <CanvaSvg />; break;
      case "vercel": inner = <VercelSvg />; break;
      case "sentry": inner = <SentrySvg />; break;
      case "cloudflare": inner = <CloudflareSvg />; break;
      case "atlassian": inner = <AtlassianSvg />; break;
      case "stripe": inner = <StripeSvg />; break;
      case "netlify": inner = <NetlifySvg />; break;
      case "meeting_notes": inner = <FileText size={iconPx} color="#6D28D9" />; break;
      case "processes": inner = <Cpu size={iconPx} color="#15803D" />; break;
      case "custom_webhook": inner = <Webhook size={iconPx} color="#EA580C" />; break;
      case "imap_email": inner = <Mail size={iconPx} color="#D97706" />; break;
      default: inner = <Blocks size={iconPx} color="#374151" />; break;
    }
  }
  return (
    <span className="qj-conn-icon-tile" style={{ width: size, height: size, borderRadius: Math.max(10, Math.round(size * 0.27)), background: bg }} aria-hidden="true">
      {inner}
    </span>
  );
}
