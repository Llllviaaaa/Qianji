/**
 * Built-in `core-conversation` Cordis client plugin (ADR 0023 Wave 2B).
 *
 * Registers Qianji's active conversation stage onto `"shell.stage"` (wrapped
 * inside `<SessionArea>`), claims the canonical `conversation.*` slot subtree
 * from `CORE_SLOT_SPECS`, registers default built-in implementations for all
 * conversation slots, and exposes `<SessionConversationSurface>` plus the
 * `"conversation.surface"` slot factory for multi-session surfaces (e.g. side-chat).
 */
import { createElement } from "react";
import type { Context, Plugin } from "@deepseek-ai/cordis";
import {
  CORE_SLOT_SPECS,
  type CoreShellStageProps,
  type SlotFactorySpec,
} from "@qianji/client-slots";
import {
  CoreApprovalDialog,
  CoreSessionChangeCard,
} from "./CoreConversationApprovalAndFooter";
import {
  CoreComposerDock,
  CoreWorkspaceTrustBanner,
} from "./CoreConversationHeaderAndDock";
import {
  CoreConversationStage,
  SessionConversationSurface,
  type SessionConversationSurfaceProps,
} from "./CoreConversationPlugin";
import {
  CoreConversationTranscript,
  CoreConversationTurn,
} from "./CoreConversationTranscript";
import { CoreMessageItem } from "./CoreMessageItem";
import {
  CoreCodeBlock,
  CoreLegacyMessageActions,
  CoreThinkingBlock,
  CoreToolCallCard,
} from "./CoreMessageSubSlots";

export const CORE_CONVERSATION_PLUGIN_ID = "core-conversation";
export const CONVERSATION_SURFACE_FACTORY_KEY = "conversation.surface";

export type ConversationSurfaceFactoryProps = SessionConversationSurfaceProps;

declare module "@qianji/client-slots" {
  interface SlotFactoryMap {
    "conversation.surface": SlotFactorySpec<ConversationSurfaceFactoryProps, "root">;
  }
}

export {
  CoreApprovalDialog,
  CoreCodeBlock,
  CoreComposerDock,
  CoreConversationStage,
  CoreConversationTranscript,
  CoreConversationTurn,
  CoreLegacyMessageActions,
  CoreMessageItem,
  CoreSessionChangeCard,
  CoreThinkingBlock,
  CoreToolCallCard,
  CoreWorkspaceTrustBanner,
  SessionConversationSurface,
  type SessionConversationSurfaceProps,
};

function selectConversationStage(ownerProps: CoreShellStageProps): { readonly mode: "conversation" } | null {
  if (ownerProps.hubView != null) return null;
  if (ownerProps.draftMode === true) return null;
  if (
    ownerProps.route !== undefined &&
    (ownerProps.route.kind === "home" ||
      ownerProps.route.kind === "hub" ||
      ownerProps.route.kind === "plugin-page")
  ) {
    return null;
  }
  return { mode: "conversation" };
}

export const coreConversationPlugin: Plugin.Object = {
  name: CORE_CONVERSATION_PLUGIN_ID,
  inject: [
    "slots",
    "sessionService",
    "workspaceService",
    "composerService",
    "workbenchService",
    "navigationService",
    "themeService",
  ],
  apply(ctx: Context): void {
    // 1. Main conversation stage on `shell.stage` (chain)
    ctx.slots.register("shell.stage", {
      id: `${CORE_CONVERSATION_PLUGIN_ID}:stage`,
      pluginId: CORE_CONVERSATION_PLUGIN_ID,
      tier: "builtin",
      priority: -50,
      select: selectConversationStage,
      children: {
        "conversation.header": CORE_SLOT_SPECS["conversation.header"],
        "conversation.transcript": CORE_SLOT_SPECS["conversation.transcript"],
        "conversation.approvalDialog": CORE_SLOT_SPECS["conversation.approvalDialog"],
        "conversation.composerDock": CORE_SLOT_SPECS["conversation.composerDock"],
      },
      component: CoreConversationStage,
    });

    // 2. Default `conversation.header` (WorkspaceTrustBanner)
    ctx.slots.register("conversation.header", {
      id: `${CORE_CONVERSATION_PLUGIN_ID}:header:trust-banner`,
      pluginId: CORE_CONVERSATION_PLUGIN_ID,
      tier: "builtin",
      order: 10,
      component: CoreWorkspaceTrustBanner,
    });

    // 3. Default `conversation.transcript` (owns `conversation.turn`)
    ctx.slots.register("conversation.transcript", {
      id: `${CORE_CONVERSATION_PLUGIN_ID}:transcript`,
      pluginId: CORE_CONVERSATION_PLUGIN_ID,
      tier: "builtin",
      priority: -100,
      children: {
        "conversation.turn": CORE_SLOT_SPECS["conversation.turn"],
      },
      component: CoreConversationTranscript,
    });

    // 4. Default `conversation.turn` (owns `conversation.message`, `conversation.turnFooter`)
    ctx.slots.register("conversation.turn", {
      id: `${CORE_CONVERSATION_PLUGIN_ID}:turn`,
      pluginId: CORE_CONVERSATION_PLUGIN_ID,
      tier: "builtin",
      priority: -100,
      select: () => true,
      children: {
        "conversation.message": CORE_SLOT_SPECS["conversation.message"],
        "conversation.turnFooter": CORE_SLOT_SPECS["conversation.turnFooter"],
      },
      component: CoreConversationTurn,
    });

    // 5. Default `conversation.message` (owns thinking, toolCall, codeBlock, message.actions)
    ctx.slots.register("conversation.message", {
      id: `${CORE_CONVERSATION_PLUGIN_ID}:message`,
      pluginId: CORE_CONVERSATION_PLUGIN_ID,
      tier: "builtin",
      priority: -100,
      select: () => true,
      children: {
        "conversation.thinking": CORE_SLOT_SPECS["conversation.thinking"],
        "conversation.toolCall": CORE_SLOT_SPECS["conversation.toolCall"],
        "conversation.markdown.codeBlock": CORE_SLOT_SPECS["conversation.markdown.codeBlock"],
        "conversation.message.actions": CORE_SLOT_SPECS["conversation.message.actions"],
      },
      component: CoreMessageItem,
    });

    // 6. Default `conversation.thinking`
    ctx.slots.register("conversation.thinking", {
      id: `${CORE_CONVERSATION_PLUGIN_ID}:thinking`,
      pluginId: CORE_CONVERSATION_PLUGIN_ID,
      tier: "builtin",
      priority: -100,
      select: (props) => (props.thinking.trim() !== "" ? true : null),
      component: CoreThinkingBlock,
    });

    // 7. Default `conversation.toolCall` wildcard
    ctx.slots.register("conversation.toolCall", {
      id: `${CORE_CONVERSATION_PLUGIN_ID}:toolCall`,
      pluginId: CORE_CONVERSATION_PLUGIN_ID,
      tier: "builtin",
      priority: -100,
      key: "*",
      component: CoreToolCallCard,
    });

    // 8. Default `conversation.markdown.codeBlock` wildcard
    ctx.slots.register("conversation.markdown.codeBlock", {
      id: `${CORE_CONVERSATION_PLUGIN_ID}:codeBlock`,
      pluginId: CORE_CONVERSATION_PLUGIN_ID,
      tier: "builtin",
      priority: -100,
      key: "*",
      component: CoreCodeBlock,
    });

    // 9. Legacy `conversation.message.actions` bridge
    ctx.slots.register("conversation.message.actions", {
      id: `${CORE_CONVERSATION_PLUGIN_ID}:messageActions:legacy`,
      pluginId: CORE_CONVERSATION_PLUGIN_ID,
      tier: "builtin",
      order: 100,
      component: CoreLegacyMessageActions,
    });

    // 10. Default `conversation.turnFooter` (SessionChangeCard)
    ctx.slots.register("conversation.turnFooter", {
      id: `${CORE_CONVERSATION_PLUGIN_ID}:turnFooter:changes`,
      pluginId: CORE_CONVERSATION_PLUGIN_ID,
      tier: "builtin",
      order: 10,
      component: CoreSessionChangeCard,
    });

    // 11. Default `conversation.approvalDialog` (ExtensionDialog)
    ctx.slots.register("conversation.approvalDialog", {
      id: `${CORE_CONVERSATION_PLUGIN_ID}:approvalDialog`,
      pluginId: CORE_CONVERSATION_PLUGIN_ID,
      tier: "builtin",
      priority: -100,
      select: (props) => (props.request !== undefined ? true : null),
      component: CoreApprovalDialog,
    });

    // 12. Default `conversation.composerDock` (owns `composer.main`)
    ctx.slots.register("conversation.composerDock", {
      id: `${CORE_CONVERSATION_PLUGIN_ID}:composerDock`,
      pluginId: CORE_CONVERSATION_PLUGIN_ID,
      tier: "builtin",
      priority: -100,
      children: {
        "composer.main": CORE_SLOT_SPECS["composer.main"],
      },
      component: CoreComposerDock,
    });

    // 13. Reusable multi-session surface factory (`conversation.surface`)
    ctx.slots.registerFactory(CONVERSATION_SURFACE_FACTORY_KEY, {
      id: `${CORE_CONVERSATION_PLUGIN_ID}:surface-factory`,
      pluginId: CORE_CONVERSATION_PLUGIN_ID,
      tier: "builtin",
      priority: -100,
      scope: "root",
      component: ({
        sessionId,
        cwd,
        sessionFile,
        compact,
        isolated,
        variant,
        showHeader,
        showComposerDock,
        className,
      }) =>
        createElement(SessionConversationSurface, {
          sessionId,
          cwd,
          sessionFile,
          compact,
          isolated,
          variant,
          showHeader,
          showComposerDock,
          className,
        }),
    });
  },
};
