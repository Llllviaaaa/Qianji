/**
 * Built-in core UI primitive factories registered into `@qianji/client-slots`'s
 * `SlotFactoryMap` (ADR 0023 §3.2).
 *
 * Allows built-in and external plugins to render replaceable core primitives via
 * `renderFactory("primitive.markdown", ...)` / `<SlotFactoryHost>` while keeping
 * built-in fallbacks registered at `tier: "builtin", priority: 0`.
 */
import { createElement, type ReactElement } from "react";
import type {
  ClientSlotsService,
  SlotComponentProps,
  SlotFactorySpec,
  SlotRegistry,
} from "@qianji/client-slots";
import { Dialog as HostDialog } from "../../components/ui/Dialog";
import { Card } from "./Card";
import { Markdown } from "./Markdown";
import { Popover } from "./Popover";
import { ScrollArea } from "./ScrollArea";
import type {
  CardProps,
  DialogProps,
  MarkdownProps,
  PopoverProps,
  ScrollAreaProps,
} from "./types";

declare module "@qianji/client-slots" {
  interface SlotFactoryMap {
    "primitive.markdown": SlotFactorySpec<MarkdownProps, "root">;
    "primitive.dialog": SlotFactorySpec<DialogProps, "root">;
    "primitive.popover": SlotFactorySpec<PopoverProps, "root">;
    "primitive.card": SlotFactorySpec<CardProps, "root">;
    "primitive.scrollArea": SlotFactorySpec<ScrollAreaProps, "root">;
  }
}

export const CORE_PRIMITIVE_FACTORY_KEYS = [
  "primitive.markdown",
  "primitive.dialog",
  "primitive.popover",
  "primitive.card",
  "primitive.scrollArea",
] as const;

export type CorePrimitiveFactoryKey = (typeof CORE_PRIMITIVE_FACTORY_KEYS)[number];

const CORE_PRIMITIVES_PLUGIN_ID = "core-primitives";

function stripSlotStandardProps<T extends object>(
  props: SlotComponentProps<T, "root", unknown, never>,
): T {
  const {
    ctx: _ctx,
    scope: _scope,
    renderSlot: _renderSlot,
    renderSlotChain: _renderSlotChain,
    renderFactory: _renderFactory,
    t: _t,
    store: _store,
    selected: _selected,
    ...rest
  } = props;
  return rest as unknown as T;
}

function MarkdownFactory(props: SlotComponentProps<MarkdownProps, "root", unknown, never>): ReactElement {
  return createElement(Markdown, stripSlotStandardProps(props));
}

function DialogFactory(props: SlotComponentProps<DialogProps, "root", unknown, never>): ReactElement {
  return createElement(HostDialog, stripSlotStandardProps(props));
}

function PopoverFactory(props: SlotComponentProps<PopoverProps, "root", unknown, never>): ReactElement {
  return createElement(Popover, stripSlotStandardProps(props));
}

function CardFactory(props: SlotComponentProps<CardProps, "root", unknown, never>): ReactElement {
  return createElement(Card, stripSlotStandardProps(props));
}

function ScrollAreaFactory(props: SlotComponentProps<ScrollAreaProps, "root", unknown, never>): ReactElement {
  return createElement(ScrollArea, stripSlotStandardProps(props));
}

/**
 * Register Qianji's built-in core primitive factories into `SlotRegistry` or
 * `ClientSlotsService` (`tier: "builtin"`, `priority: 0`). Returns a disposer
 * removing all registered built-in factories.
 */
export function registerCorePrimitiveFactories(
  target: Pick<SlotRegistry, "registerFactory"> | Pick<ClientSlotsService, "registerFactory">,
): () => void {
  const disposers = [
    target.registerFactory("primitive.markdown", {
      id: `${CORE_PRIMITIVES_PLUGIN_ID}:markdown`,
      pluginId: CORE_PRIMITIVES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: MarkdownFactory,
    }),
    target.registerFactory("primitive.dialog", {
      id: `${CORE_PRIMITIVES_PLUGIN_ID}:dialog`,
      pluginId: CORE_PRIMITIVES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: DialogFactory,
    }),
    target.registerFactory("primitive.popover", {
      id: `${CORE_PRIMITIVES_PLUGIN_ID}:popover`,
      pluginId: CORE_PRIMITIVES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: PopoverFactory,
    }),
    target.registerFactory("primitive.card", {
      id: `${CORE_PRIMITIVES_PLUGIN_ID}:card`,
      pluginId: CORE_PRIMITIVES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: CardFactory,
    }),
    target.registerFactory("primitive.scrollArea", {
      id: `${CORE_PRIMITIVES_PLUGIN_ID}:scrollArea`,
      pluginId: CORE_PRIMITIVES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: ScrollAreaFactory,
    }),
  ];

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of disposers) dispose();
  };
}
