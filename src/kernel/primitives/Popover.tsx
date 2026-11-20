import {
  Fragment,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { cn } from "../../components/ui/cn";
import type { PopoverAlign, PopoverProps, PopoverRenderState, PopoverSide } from "./types";

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref !== null && ref !== undefined) {
    (ref as { current: T | null }).current = value;
  }
}

function resolveAriaHasPopup(
  role: NonNullable<PopoverProps["role"]>,
): "dialog" | "menu" | "listbox" | "true" {
  if (role === "menu" || role === "listbox" || role === "dialog") {
    return role;
  }
  return "true";
}

function buildPlacementStyle(
  side: PopoverSide,
  align: PopoverAlign,
  sideOffset: number,
): CSSProperties {
  const gap = `calc(100% + ${sideOffset}px)`;
  const style: CSSProperties = {
    position: "absolute",
    zIndex: 1250,
  };

  if (side === "bottom") {
    style.top = gap;
  } else if (side === "top") {
    style.bottom = gap;
  } else if (side === "right") {
    style.left = gap;
  } else {
    style.right = gap;
  }

  const horizontalAxis = side === "top" || side === "bottom";
  if (horizontalAxis) {
    if (align === "start") {
      style.left = 0;
    } else if (align === "end") {
      style.right = 0;
    } else {
      style.left = "50%";
      style.transform = "translateX(-50%)";
    }
  } else if (align === "start") {
    style.top = 0;
  } else if (align === "end") {
    style.bottom = 0;
  } else {
    style.top = "50%";
    style.transform = "translateY(-50%)";
  }

  return style;
}

const POPOVER_SURFACE_BASE_STYLE: CSSProperties = {
  minWidth: "180px",
  padding: "8px",
  borderRadius: "var(--qj-radius-md)",
  border: "1px solid var(--qj-border-strong)",
  background: "var(--qj-bg-surface)",
  color: "var(--qj-text-primary)",
  fontFamily: "var(--qj-font-sans)",
  boxShadow: "var(--muse-elevation-popover, 0 8px 24px rgba(0, 0, 0, 0.28))",
};

const POPOVER_ROOT_STYLE: CSSProperties = {
  position: "relative",
  display: "inline-flex",
  alignItems: "center",
};

function isDomNode(value: EventTarget | null): value is Node {
  return value !== null && typeof value === "object" && "nodeType" in value;
}

function hasElementClickHandler(node: ReactNode): boolean {
  if (!isValidElement(node)) return false;
  const props = node.props as { onClick?: unknown; children?: ReactNode };
  if (typeof props.onClick === "function") return true;
  if (Array.isArray(props.children)) {
    return props.children.some((child) => hasElementClickHandler(child as ReactNode));
  }
  return hasElementClickHandler(props.children);
}

export function Popover({
  trigger,
  content,
  children,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  disabled = false,
  closeOnEscape = true,
  closeOnOutsideClick = true,
  role = "dialog",
  ariaLabel,
  className,
  contentClassName,
  contentStyle,
  ref,
}: PopoverProps): ReactElement {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const isOpen = disabled ? false : (isControlled ? controlledOpen : uncontrolledOpen);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const contentId = useId();

  const setRootNode = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node;
      assignRef(ref, node);
    },
    [ref],
  );

  const commitOpen = useCallback(
    (next: boolean) => {
      if (disabled && next) return;
      if (!isControlled) {
        setUncontrolledOpen(next);
      }
      onOpenChange?.(next);
    },
    [disabled, isControlled, onOpenChange],
  );

  const close = useCallback(() => {
    commitOpen(false);
  }, [commitOpen]);

  const toggle = useCallback(() => {
    commitOpen(!isOpen);
  }, [commitOpen, isOpen]);

  const setOpen = useCallback(
    (next: boolean) => {
      commitOpen(next);
    },
    [commitOpen],
  );

  useEffect(() => {
    if (!isOpen || typeof document === "undefined") return;

    let pendingPointerDismiss = false;

    const isOutside = (target: EventTarget | null): boolean => {
      if (!isDomNode(target)) return false;
      const inRoot = rootRef.current?.contains(target) ?? false;
      const inContent = contentRef.current?.contains(target) ?? false;
      return !inRoot && !inContent;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!closeOnEscape || event.key !== "Escape") return;
      event.stopPropagation();
      commitOpen(false);
      const activeEl = document.activeElement;
      if (activeEl !== null && (contentRef.current?.contains(activeEl) ?? false)) {
        const triggerFocusable = rootRef.current?.querySelector<HTMLElement>(
          "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
        );
        triggerFocusable?.focus();
      }
    };

    const handlePointerDown = (event: Event) => {
      if (!closeOnOutsideClick) return;
      if (isOutside(event.target)) {
        pendingPointerDismiss = true;
        queueMicrotask(() => {
          pendingPointerDismiss = false;
        });
        commitOpen(false);
      }
    };

    const handleMouseDown = (event: Event) => {
      if (!closeOnOutsideClick) return;
      if (pendingPointerDismiss) {
        pendingPointerDismiss = false;
        return;
      }
      if (isOutside(event.target)) {
        commitOpen(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [isOpen, closeOnEscape, closeOnOutsideClick, commitOpen]);

  const renderState: PopoverRenderState = {
    open: isOpen,
    close,
    toggle,
    setOpen,
  };

  const triggerIsRenderProp = typeof trigger === "function";
  const resolvedTrigger = triggerIsRenderProp ? trigger(renderState) : trigger;
  const bodySource = content !== undefined ? content : children;
  const resolvedBody = typeof bodySource === "function" ? bodySource(renderState) : bodySource;
  const ariaHasPopup = resolveAriaHasPopup(role);
  const triggerOwnsClick = triggerIsRenderProp && hasElementClickHandler(resolvedTrigger);

  const handleWrapperClick = (event: ReactMouseEvent<HTMLSpanElement>) => {
    if (triggerOwnsClick || event.defaultPrevented || disabled) return;
    commitOpen(!isOpen);
  };

  let triggerNode: ReactElement;
  if (typeof resolvedTrigger === "string" || typeof resolvedTrigger === "number") {
    triggerNode = (
      <button
        type="button"
        className="qj-btn qj-btn--secondary qj-btn--md"
        disabled={disabled}
        aria-haspopup={ariaHasPopup}
        aria-expanded={isOpen}
        aria-controls={isOpen ? contentId : undefined}
        onClick={(event) => {
          if (event.defaultPrevented || disabled) return;
          commitOpen(!isOpen);
        }}
      >
        {resolvedTrigger}
      </button>
    );
  } else {
    const decoratedTrigger =
      isValidElement(resolvedTrigger) && resolvedTrigger.type !== Fragment
        ? cloneElement(resolvedTrigger as ReactElement<Record<string, unknown>>, {
            "aria-haspopup":
              (resolvedTrigger.props as Record<string, unknown>)["aria-haspopup"] ?? ariaHasPopup,
            "aria-expanded": isOpen,
            "aria-controls": isOpen ? contentId : undefined,
          })
        : resolvedTrigger;

    triggerNode = (
      <span
        className="qj-popover-trigger"
        style={{ display: "inline-flex" }}
        onClick={handleWrapperClick}
      >
        {decoratedTrigger}
      </span>
    );
  }

  const panelStyle: CSSProperties = {
    ...POPOVER_SURFACE_BASE_STYLE,
    ...buildPlacementStyle(side, align, sideOffset),
    ...contentStyle,
  };

  return (
    <div
      ref={setRootNode}
      className={cn("qj-popover", className)}
      data-qj-primitive="popover"
      data-state={isOpen ? "open" : "closed"}
      data-side={side}
      data-align={align}
      style={POPOVER_ROOT_STYLE}
    >
      {triggerNode}
      {isOpen && (
        <div
          ref={contentRef}
          id={contentId}
          role={role}
          aria-label={ariaLabel}
          className={cn("qj-popover-content", contentClassName)}
          data-state="open"
          data-side={side}
          data-align={align}
          style={panelStyle}
        >
          {resolvedBody}
        </div>
      )}
    </div>
  );
}
