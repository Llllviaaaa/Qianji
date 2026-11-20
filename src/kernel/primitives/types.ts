/**
 * SemVer-stable public prop contracts for `@qianji/client-primitives`.
 *
 * These interfaces decouple external and built-in plugins from internal host UI
 * component signatures under `src/components/ui/` so host screens can evolve
 * freely while plugin consumers remain type-safe across minor upgrades.
 */
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
} from "react";

/* ── Button ── */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  ref?: Ref<HTMLButtonElement>;
}

/* ── IconButton ── */

export type IconButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type IconButtonSize = "sm" | "md" | "lg";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  /** Required accessible label for screen readers. */
  "aria-label": string;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  /** Active/toggled state reflected via `aria-pressed` and `--qj-*` active surface tokens. */
  active?: boolean;
  /** Optional tooltip content shown on hover/focus. */
  tooltip?: ReactNode;
  /** Preferred tooltip placement when `tooltip` is provided. */
  tooltipSide?: TooltipSide;
  ref?: Ref<HTMLButtonElement>;
}

/* ── Card ── */

export type CardVariant = "default" | "subtle" | "elevated" | "interactive";
export type CardPadding = "none" | "sm" | "md" | "lg";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  padding?: CardPadding;
  header?: ReactNode;
  footer?: ReactNode;
  ref?: Ref<HTMLDivElement>;
}

/* ── Dialog ── */

export interface DialogProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  hideCloseButton?: boolean;
}

export type DialogSectionProps = HTMLAttributes<HTMLDivElement>;

/* ── Popover ── */

export type PopoverSide = "top" | "bottom" | "left" | "right";
export type PopoverAlign = "start" | "center" | "end";

export interface PopoverRenderState {
  open: boolean;
  close: () => void;
  toggle: () => void;
  setOpen: (next: boolean) => void;
}

export interface PopoverProps {
  /** Trigger element, label, or render callback. */
  trigger: ReactNode | ((state: PopoverRenderState) => ReactNode);
  /** Floating popover body or render callback. */
  content?: ReactNode | ((state: PopoverRenderState) => ReactNode);
  /** Alias for `content` when passing JSX children. */
  children?: ReactNode | ((state: PopoverRenderState) => ReactNode);
  /** Controlled open state. Omit to run uncontrolled. */
  open?: boolean;
  /** Initial open state when uncontrolled. Defaults to `false`. */
  defaultOpen?: boolean;
  /** Fired whenever the popover requests an open state change. */
  onOpenChange?: (open: boolean) => void;
  /** Preferred side relative to the trigger. Defaults to `"bottom"`. */
  side?: PopoverSide;
  /** Cross-axis alignment relative to the trigger. Defaults to `"start"`. */
  align?: PopoverAlign;
  /** Gap in pixels between trigger and floating surface. Defaults to `6`. */
  sideOffset?: number;
  /** Prevent opening the popover. */
  disabled?: boolean;
  /** Dismiss when pressing Escape. Defaults to `true`. */
  closeOnEscape?: boolean;
  /** Dismiss when pressing outside the trigger and floating surface. Defaults to `true`. */
  closeOnOutsideClick?: boolean;
  /** ARIA role for the floating panel. Defaults to `"dialog"`. */
  role?: "dialog" | "menu" | "listbox" | "region";
  /** Accessible label applied to the floating panel. */
  ariaLabel?: string;
  /** Class name applied to the outer anchor container. */
  className?: string;
  /** Class name applied to the floating panel. */
  contentClassName?: string;
  /** Additional inline styles merged onto the floating panel. */
  contentStyle?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
}

/* ── Tabs ── */

export interface TabsProps extends HTMLAttributes<HTMLDivElement> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  children: ReactNode;
}

export type TabsListProps = HTMLAttributes<HTMLDivElement>;

export interface TabsTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

export interface TabsContentProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
}

/* ── Select ── */

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange"> {
  options?: readonly SelectOption[];
  onValueChange?: (value: string) => void;
  onChange?: SelectHTMLAttributes<HTMLSelectElement>["onChange"];
  wrapperClassName?: string;
  ref?: Ref<HTMLSelectElement>;
}

/* ── Switch ── */

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  ref?: Ref<HTMLButtonElement>;
}

/* ── Input ── */

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement>;
}

/* ── Badge ── */

export type BadgeVariant = "neutral" | "brand" | "success" | "warning" | "danger";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  ref?: Ref<HTMLSpanElement>;
}

/* ── Tooltip ── */

export type TooltipSide = "top" | "bottom";

export interface TooltipProps {
  content: ReactNode;
  side?: TooltipSide;
  children: ReactNode;
  className?: string;
}

/* ── Markdown ── */

export type MarkdownOpenFileHandler = (path: string, line?: number) => void;

export interface MarkdownProps {
  /** Markdown document source text. */
  content: string;
  /** Optional class name applied to the outer markdown container. */
  className?: string;
  /** Optional workspace root used to resolve relative file links before opening. */
  cwd?: string;
  /** Optional callback invoked when a file reference inside markdown is activated. */
  onOpenFile?: MarkdownOpenFileHandler;
  /** Enable rich content fence rendering when present. Defaults to `false`. */
  allowRichContent?: boolean;
  /** Optimize incremental block chunking while content is streaming. Defaults to `false`. */
  isStreaming?: boolean;
}

/* ── ScrollArea ── */

export type ScrollAreaOrientation = "vertical" | "horizontal" | "both";

export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  /** Scrollable axes. Defaults to `"vertical"`. */
  orientation?: ScrollAreaOrientation;
  /** Optional max-height constraint (numbers are treated as px). */
  maxHeight?: number | string;
  /** Optional max-width constraint (numbers are treated as px). */
  maxWidth?: number | string;
  /** Make the scroll container keyboard-focusable (`tabIndex={0}`). Defaults to `true`. */
  focusable?: boolean;
  ref?: Ref<HTMLDivElement>;
}
