// Standalone zero-dependency TypeScript declarations for ADR 0023 frontend
// microkernel packages (`@qianji/client-store`, `@qianji/client-slots`,
// `@qianji/client-primitives`) and `@qianji/client` frontend service hooks.

export const CLIENT_STORE_DTS = `export interface StoreDecl<TStore = unknown, TInit = unknown> {
  create(init: TInit, scopeKey: string): TStore;
  dispose?(store: TStore): void;
}

export interface ReactiveStore<TState> {
  get(): TState;
  set(next: TState | ((prev: TState) => TState)): void;
  getSnapshot(): TState;
  setState(next: TState | ((prev: TState) => TState)): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export interface RetainedFactoryStore<TStore = unknown> {
  readonly store: TStore;
  release(): void;
}

export declare function createReactiveStore<TState>(initial: TState): ReactiveStore<TState>;
export declare function useStoreValue<TState>(store: ReactiveStore<TState>): TState;
export declare function storeOf<TStore = unknown>(entryId: string, scopeKey?: string): TStore | undefined;
export declare function factoryStoreOf<TStore = unknown>(
  factoryKey: string,
  occurrenceKey: string,
  scopeKey?: string,
): TStore | undefined;
export declare function retainFactoryOccurrence<TStore = unknown, TInit = unknown>(
  factoryKey: string,
  occurrenceKey: string,
  scopeKey: string,
  init: TInit,
  options: { entryId: string; decl: StoreDecl<TStore, TInit> },
): RetainedFactoryStore<TStore>;
`;

export const CLIENT_SLOTS_DTS = `import type { ComponentType, ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { StoreDecl } from "@qianji/client-store";

export interface CoreSlotMap {
  root: SlotSpec<{ readonly safeMode?: boolean }, "single", "root">;
  "shell.menubar": SlotSpec<{ readonly title?: string; readonly sidebarVisible?: boolean; readonly onToggleSidebar?: () => void }, "single", "root">;
  "shell.sidebar": SlotSpec<{ readonly visible?: boolean; readonly width?: number; readonly onResize?: (width: number) => void }, "single", "root">;
  "shell.topbar": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly title?: string }, "single", "root">;
  "shell.stage": SlotSpec<{ readonly route?: unknown; readonly cwd?: string; readonly sessionFile?: string | null; readonly hubView?: string | null; readonly draftMode?: boolean }, "chain", "session-maybe">;
  "shell.workbench.right": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly open?: boolean; readonly maximized?: boolean }, "single", "session-maybe">;
  "shell.workbench.bottom": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly open?: boolean; readonly activeTab?: string }, "single", "session-maybe">;
  "shell.statusbar": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly align?: "left" | "right" }, "list", "session-maybe">;
  "shell.overlays": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null }, "list", "root">;
  "shell.modals": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null }, "list", "root">;
  "sidebar.header": SlotSpec<{ readonly cwd?: string; readonly onNewTask?: () => void }, "single", "root">;
  "sidebar.nav": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly activeView?: string | null }, "list", "root">;
  "sidebar.threads": SlotSpec<{ readonly cwd?: string; readonly activeSessionFile?: string | null; readonly searchQuery?: string }, "single", "root">;
  "sidebar.sessionRow": SlotSpec<{ readonly session: Record<string, unknown>; readonly active: boolean; readonly running?: boolean; readonly approval?: boolean; readonly pinned?: boolean; readonly projectLabel?: string; readonly snippet?: string; readonly onSelect: () => void }, "chain", "root">;
  "sidebar.sections": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null }, "list", "root">;
  "sidebar.footer": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly onOpenSettings?: (page?: string) => void }, "single", "root">;
  "home.hero": SlotSpec<{ readonly cwd?: string; readonly workspaceOptions?: readonly string[] }, "single", "root">;
  "home.quickActions": SlotSpec<{ readonly cwd: string; readonly sessionFile: string | null; readonly prefillComposer: (prompt: string) => void; readonly sendPrompt: (prompt: string) => void }, "list", "root">;
  "home.sections": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null }, "list", "root">;
  "conversation.header": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null }, "list", "session">;
  "conversation.transcript": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly messages?: readonly unknown[]; readonly isStreaming?: boolean }, "single", "session">;
  "conversation.turn": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly turnIndex: number; readonly userMessage?: unknown; readonly assistantMessages: readonly unknown[]; readonly isStreaming: boolean; readonly isLastTurn: boolean; readonly isLastUserTurn?: boolean }, "chain", "session">;
  "conversation.message": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly message: Record<string, unknown>; readonly isStreaming?: boolean; readonly isLast?: boolean; readonly isLastUserTurn?: boolean; readonly turnStartedAt?: number; readonly footer?: ReactNode }, "chain", "session">;
  "conversation.message.actions": SlotSpec<{ readonly cwd: string; readonly sessionFile: string | null; readonly message: Record<string, unknown>; readonly contentText: string }, "list", "session">;
  "conversation.thinking": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly message: Record<string, unknown>; readonly thinking: string; readonly isStreaming?: boolean }, "chain", "session">;
  "conversation.toolCall": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly call: Record<string, unknown>; readonly state: "running" | "error" | "ok"; readonly messageId?: string }, "keyed", "session">;
  "conversation.markdown.codeBlock": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly language: string; readonly code: string; readonly isStreaming?: boolean }, "keyed", "session">;
  "conversation.turnFooter": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly message: Record<string, unknown>; readonly durationMs?: number }, "list", "session">;
  "conversation.composerDock": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly variant?: "task-start" | "follow-up"; readonly isolated?: boolean }, "single", "session-maybe">;
  "conversation.approvalDialog": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly request: Record<string, unknown>; readonly onAnswer: (requestId: string, value: unknown) => void }, "chain", "session">;
  "composer.main": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly variant?: "task-start" | "follow-up"; readonly sessionKey?: string; readonly isolated?: boolean; readonly isStreaming?: boolean; readonly pendingApproval?: boolean; readonly quickChat?: boolean; readonly environment?: "local" | "worktree" }, "chain", "session-maybe">;
  "composer.banners": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly variant?: "task-start" | "follow-up"; readonly sessionKey?: string; readonly isolated?: boolean }, "list", "session-maybe">;
  "composer.attachments": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly variant?: "task-start" | "follow-up"; readonly sessionKey?: string; readonly isolated?: boolean; readonly attachments: readonly unknown[]; readonly onRemove?: (index: number) => void }, "single", "session-maybe">;
  "composer.input": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly variant?: "task-start" | "follow-up"; readonly sessionKey?: string; readonly isolated?: boolean; readonly quickChat?: boolean; readonly placeholder?: string; readonly disabled?: boolean; readonly onSubmit?: () => void }, "single", "session-maybe">;
  "composer.toolbar": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly variant?: "task-start" | "follow-up"; readonly sessionKey?: string; readonly isolated?: boolean }, "list", "session-maybe">;
  "composer.status": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly variant?: "task-start" | "follow-up"; readonly sessionKey?: string; readonly isolated?: boolean; readonly position?: "before-model" | "after-model" }, "list", "session-maybe">;
  "workbench.topbarControls": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null }, "list", "session-maybe">;
  "workbench.tilingGrid": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly openPanes?: readonly string[]; readonly maximizedPaneId?: string | null }, "single", "session-maybe">;
  "workbench.panes": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly paneId: string; readonly active: boolean; readonly maximized?: boolean; readonly onClose?: () => void; readonly paneControls?: ReactNode }, "keyed", "session-maybe">;
  "workbench.fileViewer": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly path: string; readonly content: string; readonly isBinary: boolean; readonly mimeType?: string; readonly dataBase64?: string; readonly size: number; readonly truncated?: boolean }, "keyed", "session-maybe">;
  "workbench.inspector.sections": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null }, "list", "session-maybe">;
  "workbench.bottom.tabs": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly tabId: string; readonly active: boolean }, "keyed", "session-maybe">;
  "settings.shell": SlotSpec<{ readonly open?: boolean; readonly page?: string; readonly cwd?: string; readonly sessionFile?: string | null; readonly onClose?: () => void; readonly onSelectPage?: (page: string) => void }, "single", "root">;
  "settings.pages": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly page: string; readonly closeSettings: () => void }, "keyed", "root">;
  "settings.sections": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly page: string; readonly closeSettings: () => void }, "list", "root">;
  "hub.pages": SlotSpec<{ readonly cwd?: string; readonly sessionFile?: string | null; readonly pageId: string; readonly onClose?: () => void }, "keyed", "root">;
}
export type CoreSlotKey = keyof CoreSlotMap;
export declare const CORE_SLOT_SPECS: Readonly<Record<CoreSlotKey, ChildSlotDecl>>;

export interface SlotMap extends CoreSlotMap {}
export interface SlotFactoryMap {
  "bot.rail": SlotFactorySpec<{ readonly active?: boolean }, "root">;
  "bot.stage": SlotFactorySpec<{ readonly active?: boolean; readonly cwd?: string }, "root">;
}
export interface LocaleNamespaceMap {}
export interface ResourceProtocolMap {}

export type SlotKind = "single" | "list" | "keyed" | "chain";
export type SlotScope = "root" | "session-maybe" | "session";
export type PluginTier = "builtin" | "user" | "workspace";

export interface SlotSpec<
  TProps = Record<string, unknown>,
  TKind extends SlotKind = SlotKind,
  TScope extends SlotScope = SlotScope,
  TKey extends string = string,
> {
  readonly kind: TKind;
  readonly scope: TScope;
  readonly props: TProps;
  readonly key?: TKey;
}

export interface SlotFactorySpec<
  TProps = Record<string, unknown>,
  TScope extends SlotScope = SlotScope,
> {
  readonly props: TProps;
  readonly scope?: TScope;
}

export type KnownSlotKey = Extract<keyof SlotMap, string>;
export type AnySlotKey = KnownSlotKey | (string & {});
export type KnownFactoryKey = Extract<keyof SlotFactoryMap, string>;
export type AnyFactoryKey = KnownFactoryKey | (string & {});
export type LocaleNamespaceKey = Extract<keyof LocaleNamespaceMap, string> | (string & {});
export type ResourceProtocolKey = Extract<keyof ResourceProtocolMap, string> | (string & {});

export type SlotPropsOf<K extends string> =
  K extends keyof SlotMap
    ? SlotMap[K] extends { props: infer P }
      ? P
      : SlotMap[K]
    : Record<string, unknown>;

export type SlotScopeOf<K extends string> =
  K extends keyof SlotMap
    ? SlotMap[K] extends { scope: infer S extends SlotScope }
      ? S
      : SlotScope
    : SlotScope;

export type FactoryPropsOf<K extends string> =
  K extends keyof SlotFactoryMap
    ? SlotFactoryMap[K] extends { props: infer P }
      ? P
      : SlotFactoryMap[K]
    : Record<string, unknown>;

export type FactoryScopeOf<K extends string> =
  K extends keyof SlotFactoryMap
    ? SlotFactoryMap[K] extends { scope: infer S extends SlotScope }
      ? S
      : "root"
    : SlotScope;

export type ResourceValueOf<P extends string> =
  P extends keyof ResourceProtocolMap ? ResourceProtocolMap[P] : unknown;

export type TranslateFn<NS extends string = string> = (
  key: NS extends keyof LocaleNamespaceMap ? Extract<keyof LocaleNamespaceMap[NS], string> | (string & {}) : string,
  params?: Readonly<Record<string, string | number | boolean>>,
) => string;

export interface SlotScopeTargetMap {
  root: { readonly scope: "root"; readonly scopeKey: "root" };
  "session-maybe": { readonly scope: "session-maybe"; readonly sessionId: string | null; readonly scopeKey: string };
  session: { readonly scope: "session"; readonly sessionId: string; readonly scopeKey: string };
}

export interface RenderSlotOptions {
  readonly key?: string;
  readonly mode?: "single" | "all";
  readonly sessionId?: string | null;
  readonly compact?: boolean;
  readonly fallback?: ReactNode;
}

export interface RenderSlotChainOptions {
  readonly sessionId?: string | null;
  readonly compact?: boolean;
  readonly fallback?: ReactNode;
}

export interface RenderFactoryOptions {
  readonly occurrenceKey?: string;
  readonly sessionId?: string | null;
  readonly compact?: boolean;
  readonly fallback?: ReactNode;
}

export type BoundRenderSlotFn = <K extends AnySlotKey>(
  slotKey: K,
  props?: SlotPropsOf<K>,
  options?: RenderSlotOptions,
) => ReactNode;

export type BoundRenderSlotChainFn = <K extends AnySlotKey>(
  slotKey: K,
  props?: SlotPropsOf<K>,
  options?: RenderSlotChainOptions,
) => ReactNode;

export type BoundRenderFactoryFn = <K extends AnyFactoryKey>(
  factoryKey: K,
  props?: FactoryPropsOf<K>,
  options?: RenderFactoryOptions,
) => ReactNode;

export interface GlobalStandardProps {
  readonly ctx?: Context;
  readonly scope: SlotScopeTargetMap["root"];
  readonly renderSlot: BoundRenderSlotFn;
  readonly renderSlotChain: BoundRenderSlotChainFn;
  readonly renderFactory: BoundRenderFactoryFn;
  readonly t?: TranslateFn;
  readonly store?: unknown;
}

export interface SessionMaybeStandardProps {
  readonly ctx?: Context;
  readonly scope: SlotScopeTargetMap["session-maybe"];
  readonly sessionId: string | null;
  readonly renderSlot: BoundRenderSlotFn;
  readonly renderSlotChain: BoundRenderSlotChainFn;
  readonly renderFactory: BoundRenderFactoryFn;
  readonly t?: TranslateFn;
  readonly store?: unknown;
}

export interface SessionStandardProps {
  readonly ctx?: Context;
  readonly scope: SlotScopeTargetMap["session"];
  readonly sessionId: string;
  readonly renderSlot: BoundRenderSlotFn;
  readonly renderSlotChain: BoundRenderSlotChainFn;
  readonly renderFactory: BoundRenderFactoryFn;
  readonly t?: TranslateFn;
  readonly store?: unknown;
}

export type StandardPropsForScope<S extends SlotScope> =
  S extends "session"
    ? SessionStandardProps
    : S extends "session-maybe"
      ? SessionMaybeStandardProps
      : GlobalStandardProps;

export interface ChildSlotDecl<
  TKind extends SlotKind = SlotKind,
  TScope extends SlotScope = SlotScope,
> {
  readonly kind: TKind;
  readonly scope: TScope;
  readonly inject?: readonly string[];
  readonly description?: string;
}

export type ChildrenDecl = Readonly<Record<string, ChildSlotDecl>>;

export type SlotChainSelector<TProps = Record<string, unknown>, TSelected = unknown> = (
  ownerProps: TProps,
) => TSelected | null | undefined | false;

export type SlotComponentProps<
  TProps = Record<string, unknown>,
  TScope extends SlotScope = SlotScope,
  TStore = unknown,
  TSelected = unknown,
> = TProps &
  Omit<StandardPropsForScope<TScope>, "store"> & {
    readonly store: TStore;
    readonly selected?: TSelected;
  };

export interface SlotRegistrationInput<
  K extends AnySlotKey = AnySlotKey,
  TStore = unknown,
  TSelected = unknown,
  TScope extends SlotScope = SlotScopeOf<K>,
> {
  readonly id?: string;
  readonly pluginId?: string;
  readonly tier?: PluginTier;
  readonly priority?: number;
  readonly order?: number;
  readonly key?: string | readonly string[];
  readonly matchKey?: (routeKey: string) => boolean;
  readonly select?: SlotChainSelector<SlotPropsOf<K>, TSelected>;
  readonly overlay?: boolean;
  readonly children?: ChildrenDecl;
  readonly store?: StoreDecl<TStore, SlotPropsOf<K>>;
  readonly locale?: LocaleNamespaceKey;
  readonly component: ComponentType<SlotComponentProps<SlotPropsOf<K>, TScope, TStore, TSelected>>;
}

export interface SlotFactoryRegistrationInput<
  K extends AnyFactoryKey = AnyFactoryKey,
  TStore = unknown,
  TScope extends SlotScope = FactoryScopeOf<K>,
> {
  readonly id?: string;
  readonly pluginId?: string;
  readonly tier?: PluginTier;
  readonly priority?: number;
  readonly scope?: TScope;
  readonly store?: StoreDecl<TStore, FactoryPropsOf<K>>;
  readonly locale?: LocaleNamespaceKey;
  readonly component: ComponentType<SlotComponentProps<FactoryPropsOf<K>, TScope, TStore, never>>;
}

export interface SlotWrapperProps<TProps = Record<string, unknown>> {
  readonly slotKey: string;
  readonly props: TProps;
  readonly children: ReactNode;
}

export type SlotWrapperComponent<TProps = Record<string, unknown>> = ComponentType<SlotWrapperProps<TProps>>;

export interface SlotWrapperRegistrationInput<K extends AnySlotKey = AnySlotKey> {
  readonly id?: string;
  readonly pluginId?: string;
  readonly tier?: PluginTier;
  readonly priority?: number;
  readonly order?: number;
  readonly component: SlotWrapperComponent<SlotPropsOf<K>>;
}

export type SlotWrapperInput<K extends AnySlotKey = AnySlotKey> =
  | SlotWrapperComponent<SlotPropsOf<K>>
  | SlotWrapperRegistrationInput<K>;

export interface SlotScopeAdapter {
  getActiveSessionId(): string | null;
  subscribeActiveSession?(listener: () => void): () => void;
  onScopeMount?(scopeKey: string, sessionId: string): (() => void) | void;
}

export interface SlotCandidateSummary {
  readonly id: string;
  readonly pluginId: string;
  readonly tier: PluginTier;
  readonly priority: number;
  readonly order: number;
  readonly abdicated: boolean;
}

export interface SlotInspection {
  readonly slotKey: string;
  readonly kind: SlotKind;
  readonly scope: SlotScope;
  readonly override?: string;
  readonly winner?: SlotCandidateSummary;
  readonly candidates: readonly SlotCandidateSummary[];
  readonly wrapperIds: readonly string[];
}

export interface ClientSlotsService {
  defineSlot(slotKey: string, spec: ChildSlotDecl): () => void;
  register<K extends AnySlotKey, TStore = unknown, TSelected = unknown>(
    slotKey: K,
    input: SlotRegistrationInput<K, TStore, TSelected>,
  ): () => void;
  registerFactory<K extends AnyFactoryKey, TStore = unknown>(
    factoryKey: K,
    input: SlotFactoryRegistrationInput<K, TStore>,
  ): () => void;
  wrap<K extends AnySlotKey>(slotKey: K, input: SlotWrapperInput<K>): () => void;
  setScopeAdapter(adapter: SlotScopeAdapter | undefined): void;
  getScopeAdapter(): SlotScopeAdapter | undefined;
  inspectSlot(slotKey: string): SlotInspection;
  inspectAllSlots(): SlotInspection[];
}

export declare class SlotOwnershipError extends Error {
  readonly entryId: string;
  readonly slotKey: string;
  readonly ownedSlots: readonly string[];
}

export declare class StaleAuthorizationError extends Error {
  readonly entryId: string;
  readonly slotKey: string;
}

export interface SessionAreaProps {
  readonly sessionId: string | null;
  readonly disposeStoresOnUnmount?: boolean;
  readonly children?: ReactNode;
}

export declare function SessionArea(props: SessionAreaProps): ReactNode;
export declare const SessionProvider: typeof SessionArea;
export declare function useSlotScope(): { readonly sessionId: string | null; readonly hasExplicitArea: boolean };
export declare function useResource<P extends string = string>(address: string): ResourceValueOf<P> | undefined;
export declare function SlotHost(props: {
  readonly slotKey: string;
  readonly props?: Record<string, unknown>;
  readonly routeKey?: string;
  readonly mode?: "single" | "all";
  readonly sessionId?: string | null;
  readonly compact?: boolean;
  readonly fallback?: ReactNode;
}): ReactNode;
export declare function SlotFactoryHost(props: {
  readonly factoryKey: string;
  readonly props?: Record<string, unknown>;
  readonly occurrenceKey?: string;
  readonly sessionId?: string | null;
  readonly compact?: boolean;
  readonly fallback?: ReactNode;
}): ReactNode;
export declare function SlotRoot(props: { readonly fallback?: ReactNode }): ReactNode;
`;

export const CLIENT_PRIMITIVES_DTS = `import type {
  ButtonHTMLAttributes,
  CSSProperties,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactElement,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
} from "react";
import type { SlotFactorySpec } from "@qianji/client-slots";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg" | "icon";
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  ref?: Ref<HTMLButtonElement>;
}

export type TooltipSide = "top" | "bottom";
export type IconButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type IconButtonSize = "sm" | "md" | "lg";
export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  "aria-label": string;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  active?: boolean;
  tooltip?: ReactNode;
  tooltipSide?: TooltipSide;
  ref?: Ref<HTMLButtonElement>;
}

export type CardVariant = "default" | "subtle" | "elevated" | "interactive";
export type CardPadding = "none" | "sm" | "md" | "lg";
export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  padding?: CardPadding;
  header?: ReactNode;
  footer?: ReactNode;
  ref?: Ref<HTMLDivElement>;
}

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

export type PopoverSide = "top" | "bottom" | "left" | "right";
export type PopoverAlign = "start" | "center" | "end";
export interface PopoverRenderState {
  open: boolean;
  close: () => void;
  toggle: () => void;
  setOpen: (next: boolean) => void;
}
export interface PopoverProps {
  trigger: ReactNode | ((state: PopoverRenderState) => ReactNode);
  content?: ReactNode | ((state: PopoverRenderState) => ReactNode);
  children?: ReactNode | ((state: PopoverRenderState) => ReactNode);
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: PopoverSide;
  align?: PopoverAlign;
  sideOffset?: number;
  disabled?: boolean;
  closeOnEscape?: boolean;
  closeOnOutsideClick?: boolean;
  role?: "dialog" | "menu" | "listbox" | "region";
  ariaLabel?: string;
  className?: string;
  contentClassName?: string;
  contentStyle?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
}

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

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  ref?: Ref<HTMLButtonElement>;
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement>;
}

export type BadgeVariant = "neutral" | "brand" | "success" | "warning" | "danger";
export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  ref?: Ref<HTMLSpanElement>;
}

export interface TooltipProps {
  content: ReactNode;
  side?: TooltipSide;
  children: ReactNode;
  className?: string;
}

export type MarkdownOpenFileHandler = (path: string, line?: number) => void;
export interface MarkdownProps {
  content: string;
  className?: string;
  cwd?: string;
  onOpenFile?: MarkdownOpenFileHandler;
  allowRichContent?: boolean;
  isStreaming?: boolean;
}

export type ScrollAreaOrientation = "vertical" | "horizontal" | "both";
export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  orientation?: ScrollAreaOrientation;
  maxHeight?: number | string;
  maxWidth?: number | string;
  focusable?: boolean;
  ref?: Ref<HTMLDivElement>;
}

export type CorePrimitiveFactoryKey =
  | "primitive.markdown"
  | "primitive.dialog"
  | "primitive.popover"
  | "primitive.card"
  | "primitive.scrollArea";

declare module "@qianji/client-slots" {
  interface SlotFactoryMap {
    "primitive.markdown": SlotFactorySpec<MarkdownProps, "root">;
    "primitive.dialog": SlotFactorySpec<DialogProps, "root">;
    "primitive.popover": SlotFactorySpec<PopoverProps, "root">;
    "primitive.card": SlotFactorySpec<CardProps, "root">;
    "primitive.scrollArea": SlotFactorySpec<ScrollAreaProps, "root">;
  }
}

export declare function Badge(props: BadgeProps): ReactElement;
export declare function Button(props: ButtonProps): ReactElement;
export declare function Card(props: CardProps): ReactElement;
export declare function Dialog(props: DialogProps): ReactElement;
export declare function DialogSection(props: DialogSectionProps): ReactElement;
export declare function IconButton(props: IconButtonProps): ReactElement;
export declare function Input(props: InputProps): ReactElement;
export declare function Markdown(props: MarkdownProps): ReactElement;
export declare function Popover(props: PopoverProps): ReactElement;
export declare function ScrollArea(props: ScrollAreaProps): ReactElement;
export declare function Select(props: SelectProps): ReactElement;
export declare function Switch(props: SwitchProps): ReactElement;
export declare function Tabs(props: TabsProps): ReactElement;
export declare function TabsContent(props: TabsContentProps): ReactElement;
export declare function TabsList(props: TabsListProps): ReactElement;
export declare function TabsTrigger(props: TabsTriggerProps): ReactElement;
export declare function Tooltip(props: TooltipProps): ReactElement;

export declare const CLIENT_PRIMITIVES_EXPORTS: readonly [
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
];

export type ClientPrimitiveExportName = (typeof CLIENT_PRIMITIVES_EXPORTS)[number];
`;

export const CLIENT_FRONTEND_SERVICE_HOOKS_DTS = `
export type FrontendServiceName =
  | "sessionService"
  | "workspaceService"
  | "composerService"
  | "workbenchService"
  | "navigationService"
  | "themeService"
  | "shortcutService"
  | "menuService"
  | "rpcService"
  | "localeService"
  | "resourcesService";

export type SafeModeReason = "query" | "window-flag" | "session-storage" | "hotkey" | "manual";

export interface SafeModeSnapshot {
  readonly active: boolean;
  readonly enabled: boolean;
  readonly reason: SafeModeReason | null;
  readonly toggledCount: number;
}

export interface SessionHandleSnapshot {
  readonly sessionId: string | null;
  readonly sessionFile: string | null;
  readonly sessionName: string | null;
  readonly cwd: string;
  readonly runtimeId: string | null;
  readonly isolated: boolean;
  readonly phase: "idle" | "starting" | "ready" | "error";
  readonly error: string | null;
  readonly messages: readonly UiMessage[];
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly retryStatus: string | null;
  readonly stats: SessionStats | null;
}

export interface RetainSessionOptions {
  cwd?: string;
  parentSessionFile?: string;
  isolated?: boolean;
  autoStart?: boolean;
  initialMessages?: readonly UiMessage[];
  thinkingLevel?: string;
}

export interface SessionHandle {
  readonly sessionId: string;
  readonly isolated: boolean;
  readonly released: boolean;
  getSnapshot(): SessionHandleSnapshot;
  subscribe(listener: () => void): () => void;
  sendMessage(text: string, attachments?: AttachmentPayload[], behavior?: "steer" | "followUp"): Promise<boolean>;
  abort(): Promise<void>;
  steer(text: string, attachments?: AttachmentPayload[]): Promise<boolean>;
  followUp(text: string, attachments?: AttachmentPayload[]): Promise<boolean>;
  release(): void;
}

export interface SessionHandleHookResult {
  readonly handle: SessionHandle | null;
  readonly snapshot: SessionHandleSnapshot | null;
}

export interface FrontendSubscribableService<S = Record<string, unknown>> {
  getSnapshot(...args: unknown[]): S;
  subscribe(listener: () => void): () => void;
  [method: string]: unknown;
}

export declare function useClientContext(explicitCtx?: Context): Context | undefined;
export declare function useFrontendService<K extends FrontendServiceName>(
  name: K,
  explicitCtx?: Context,
): Context[K] | undefined;
export declare function useSessionState(explicitCtx?: Context): Record<string, unknown> | undefined;
export declare function useSessionHandle(
  sessionId: string | null | undefined,
  options?: RetainSessionOptions,
  explicitCtx?: Context,
): SessionHandleHookResult;
export declare function useWorkspaceState(explicitCtx?: Context): Record<string, unknown> | undefined;
export declare function useComposerState(sessionKey?: string, explicitCtx?: Context): Record<string, unknown> | undefined;
export declare function useWorkbenchState(explicitCtx?: Context): Record<string, unknown> | undefined;
export declare function useNavigationState(explicitCtx?: Context): Record<string, unknown> | undefined;
export declare function useThemeState(explicitCtx?: Context): Record<string, unknown> | undefined;
export declare function useShortcutsState(explicitCtx?: Context): Record<string, unknown> | undefined;
export declare function useMenusState(explicitCtx?: Context): Record<string, unknown> | undefined;
export declare function useRpcState(explicitCtx?: Context): Record<string, unknown> | undefined;
export declare function useLocaleState(explicitCtx?: Context): Record<string, unknown> | undefined;
export declare function useResourcesState(explicitCtx?: Context): Record<string, unknown> | undefined;
export declare function useSafeMode(): SafeModeSnapshot;
export declare function useSlotOverrides(): Readonly<Record<string, string>>;
`;

export const CORDIS_CLIENT_KERNEL_AUGMENTATION = `
import type { ClientSlotsService } from "@qianji/client-slots";
import type { FrontendSubscribableService } from "@qianji/client";

export interface Context {
  slots: ClientSlotsService;
  sessionService: FrontendSubscribableService;
  workspaceService: FrontendSubscribableService;
  composerService: FrontendSubscribableService;
  workbenchService: FrontendSubscribableService;
  navigationService: FrontendSubscribableService;
  themeService: FrontendSubscribableService;
  shortcutService: FrontendSubscribableService;
  menuService: FrontendSubscribableService;
  rpcService: FrontendSubscribableService;
  localeService: FrontendSubscribableService;
  resourcesService: FrontendSubscribableService;
}
`;
