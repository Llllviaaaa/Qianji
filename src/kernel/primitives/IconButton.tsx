import type { CSSProperties, ReactElement } from "react";
import { Button as HostButton } from "../../components/ui/Button";
import { Tooltip as HostTooltip } from "../../components/ui/Tooltip";
import { cn } from "../../components/ui/cn";
import type { IconButtonProps, IconButtonSize } from "./types";

const ICON_BUTTON_SIZES: Record<IconButtonSize, CSSProperties> = {
  sm: { width: "24px", height: "24px" },
  md: { width: "30px", height: "30px" },
  lg: { width: "36px", height: "36px" },
};

export function IconButton({
  "aria-label": ariaLabel,
  "aria-pressed": ariaPressed,
  variant = "ghost",
  size = "md",
  active = false,
  tooltip,
  tooltipSide = "top",
  className,
  style,
  title,
  children,
  ref,
  ...rest
}: IconButtonProps): ReactElement {
  const mergedStyle: CSSProperties = {
    ...ICON_BUTTON_SIZES[size],
    ...(active
      ? {
          background: "var(--qj-bg-active)",
          color: "var(--qj-text-primary)",
          borderColor: "var(--qj-border-default)",
        }
      : {}),
    ...style,
  };

  const buttonNode = (
    <HostButton
      ref={ref}
      variant={variant}
      size="icon"
      aria-label={ariaLabel}
      aria-pressed={ariaPressed ?? (active ? true : undefined)}
      title={title ?? (tooltip === undefined ? ariaLabel : undefined)}
      data-qj-primitive="icon-button"
      data-active={active ? "true" : "false"}
      className={cn("qj-icon-btn", `qj-icon-btn--${size}`, active && "qj-icon-btn--active", className)}
      style={mergedStyle}
      {...rest}
    >
      {children}
    </HostButton>
  );

  if (tooltip !== undefined && tooltip !== null && tooltip !== "") {
    return (
      <HostTooltip content={tooltip} side={tooltipSide}>
        {buttonNode}
      </HostTooltip>
    );
  }

  return buttonNode;
}
