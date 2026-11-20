import type { CSSProperties, ReactElement } from "react";
import { cn } from "../../components/ui/cn";
import type { ScrollAreaOrientation, ScrollAreaProps } from "./types";

function resolveOverflow(orientation: ScrollAreaOrientation): Pick<CSSProperties, "overflowX" | "overflowY"> {
  if (orientation === "horizontal") {
    return { overflowX: "auto", overflowY: "hidden" };
  }
  if (orientation === "both") {
    return { overflowX: "auto", overflowY: "auto" };
  }
  return { overflowX: "hidden", overflowY: "auto" };
}

function normalizeDimension(value: number | string | undefined): string | number | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" ? `${value}px` : value;
}

export function ScrollArea({
  orientation = "vertical",
  maxHeight,
  maxWidth,
  focusable = true,
  className,
  style,
  role,
  tabIndex,
  children,
  ref,
  ...rest
}: ScrollAreaProps): ReactElement {
  const hasAccessibleName =
    rest["aria-label"] !== undefined || rest["aria-labelledby"] !== undefined;
  const resolvedRole = role ?? (hasAccessibleName ? "region" : undefined);
  const resolvedTabIndex = tabIndex ?? (focusable ? 0 : undefined);

  const mergedStyle: CSSProperties = {
    minHeight: 0,
    minWidth: 0,
    ...resolveOverflow(orientation),
    maxHeight: normalizeDimension(maxHeight),
    maxWidth: normalizeDimension(maxWidth),
    scrollbarWidth: "thin",
    scrollbarColor: "var(--qj-border-strong) transparent",
    ...style,
  };

  return (
    <div
      ref={ref}
      role={resolvedRole}
      tabIndex={resolvedTabIndex}
      data-qj-primitive="scroll-area"
      data-orientation={orientation}
      className={cn("qj-scroll-area", `qj-scroll-area--${orientation}`, className)}
      style={mergedStyle}
      {...rest}
    >
      {children}
    </div>
  );
}
