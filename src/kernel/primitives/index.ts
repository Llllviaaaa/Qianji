/**
 * Authoritative `@qianji/client-primitives` Public UI Primitives Barrel.
 *
 * Exposes Qianji's frozen, `--qj-*` token-driven UI primitives for both
 * built-in core plugins (`src/builtin-plugins/*`) and dynamic external plugins.
 */
import { createElement, type ReactElement } from "react";
import { Badge as HostBadge } from "../../components/ui/Badge";
import { Button as HostButton } from "../../components/ui/Button";
import { Dialog as HostDialog, DialogSection as HostDialogSection } from "../../components/ui/Dialog";
import { Input as HostInput } from "../../components/ui/Input";
import { Select as HostSelect } from "../../components/ui/Select";
import { Switch as HostSwitch } from "../../components/ui/Switch";
import {
  Tabs as HostTabs,
  TabsContent as HostTabsContent,
  TabsList as HostTabsList,
  TabsTrigger as HostTabsTrigger,
} from "../../components/ui/Tabs";
import { Tooltip as HostTooltip } from "../../components/ui/Tooltip";
import { Card } from "./Card";
import { IconButton } from "./IconButton";
import { Markdown } from "./Markdown";
import { Popover } from "./Popover";
import { ScrollArea } from "./ScrollArea";
import type {
  BadgeProps,
  ButtonProps,
  DialogProps,
  DialogSectionProps,
  InputProps,
  SelectProps,
  SwitchProps,
  TabsContentProps,
  TabsListProps,
  TabsProps,
  TabsTriggerProps,
  TooltipProps,
} from "./types";

export function Button(props: ButtonProps): ReactElement {
  return createElement(HostButton, props);
}

export function Dialog(props: DialogProps): ReactElement {
  return createElement(HostDialog, props);
}

export function DialogSection(props: DialogSectionProps): ReactElement {
  return createElement(HostDialogSection, props);
}

export function Tabs(props: TabsProps): ReactElement {
  return createElement(HostTabs, props);
}

export function TabsList(props: TabsListProps): ReactElement {
  return createElement(HostTabsList, props);
}

export function TabsTrigger(props: TabsTriggerProps): ReactElement {
  return createElement(HostTabsTrigger, props);
}

export function TabsContent(props: TabsContentProps): ReactElement {
  return createElement(HostTabsContent, props);
}

export function Select(props: SelectProps): ReactElement {
  return createElement(HostSelect, props);
}

export function Switch(props: SwitchProps): ReactElement {
  return createElement(HostSwitch, props);
}

export function Input(props: InputProps): ReactElement {
  return createElement(HostInput, props);
}

export function Badge(props: BadgeProps): ReactElement {
  return createElement(HostBadge, props);
}

export function Tooltip(props: TooltipProps): ReactElement {
  return createElement(HostTooltip, props);
}

export { Card, IconButton, Markdown, Popover, ScrollArea };

/**
 * Frozen runtime export manifest for `@qianji/client-primitives`.
 * Used by guardrail tests, `qianji_inspect`, and plugin declaration generation.
 */
export const CLIENT_PRIMITIVES_EXPORTS = [
  "Badge",
  "Button",
  "Card",
  "Dialog",
  "DialogSection",
  "IconButton",
  "Input",
  "Markdown",
  "Popover",
  "ScrollArea",
  "Select",
  "Switch",
  "Tabs",
  "TabsContent",
  "TabsList",
  "TabsTrigger",
  "Tooltip",
] as const;

export type ClientPrimitiveExportName = (typeof CLIENT_PRIMITIVES_EXPORTS)[number];

export type { CorePrimitiveFactoryKey } from "./factories";

export type {
  BadgeProps,
  BadgeVariant,
  ButtonProps,
  ButtonSize,
  ButtonVariant,
  CardPadding,
  CardProps,
  CardVariant,
  DialogProps,
  DialogSectionProps,
  IconButtonProps,
  IconButtonSize,
  IconButtonVariant,
  InputProps,
  MarkdownOpenFileHandler,
  MarkdownProps,
  PopoverAlign,
  PopoverProps,
  PopoverRenderState,
  PopoverSide,
  ScrollAreaOrientation,
  ScrollAreaProps,
  SelectOption,
  SelectProps,
  SwitchProps,
  TabsContentProps,
  TabsListProps,
  TabsProps,
  TabsTriggerProps,
  TooltipProps,
  TooltipSide,
} from "./types";
