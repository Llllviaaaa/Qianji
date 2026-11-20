import type { CSSProperties, ReactElement } from "react";
import { cn } from "../../components/ui/cn";
import type { CardPadding, CardProps, CardVariant } from "./types";

const CARD_VARIANT_STYLES: Record<CardVariant, CSSProperties> = {
  default: {
    background: "var(--qj-bg-surface)",
    borderColor: "var(--qj-border-default)",
  },
  subtle: {
    background: "var(--qj-bg-subtle)",
    borderColor: "var(--qj-border-subtle)",
  },
  elevated: {
    background: "var(--qj-bg-elevated)",
    borderColor: "var(--qj-border-strong)",
    boxShadow: "var(--pi-shadow-card, 0 2px 8px rgba(0, 0, 0, 0.2))",
  },
  interactive: {
    background: "var(--qj-bg-surface)",
    borderColor: "var(--qj-border-default)",
    transition: "background-color 140ms ease, border-color 140ms ease",
  },
};

const CARD_PADDING_VALUES: Record<CardPadding, string> = {
  none: "0",
  sm: "10px 12px",
  md: "14px 16px",
  lg: "18px 20px",
};

const CARD_SECTION_BORDER = "1px solid var(--qj-border-subtle)";

export function Card({
  variant = "default",
  padding = "md",
  header,
  footer,
  className,
  style,
  children,
  ref,
  ...rest
}: CardProps): ReactElement {
  const pad = CARD_PADDING_VALUES[padding];
  const hasChrome = header !== undefined || footer !== undefined;

  const rootStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    borderRadius: "var(--qj-radius-md)",
    borderWidth: "1px",
    borderStyle: "solid",
    color: "var(--qj-text-primary)",
    fontFamily: "var(--qj-font-sans)",
    overflow: "hidden",
    ...(hasChrome ? {} : { padding: pad }),
    ...CARD_VARIANT_STYLES[variant],
    ...style,
  };

  return (
    <div
      ref={ref}
      data-qj-primitive="card"
      data-variant={variant}
      className={cn("qj-card", `qj-card--${variant}`, `qj-card--pad-${padding}`, className)}
      style={rootStyle}
      {...rest}
    >
      {header !== undefined && (
        <div
          className="qj-card-header"
          style={{ padding: pad, borderBottom: CARD_SECTION_BORDER }}
        >
          {header}
        </div>
      )}
      {hasChrome ? (
        <div className="qj-card-body" style={{ padding: pad }}>
          {children}
        </div>
      ) : (
        children
      )}
      {footer !== undefined && (
        <div
          className="qj-card-footer"
          style={{
            padding: pad,
            borderTop: CARD_SECTION_BORDER,
            background: "var(--qj-bg-subtle)",
          }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}
