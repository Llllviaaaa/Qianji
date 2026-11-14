import type { Context } from "@deepseek-ai/cordis";
import { sendChatPrompt, showToast, usePluginConfig } from "@qianji/client";
import { Link2, Quote, Share2 } from "lucide-react";

export const name = "message-actions";
export const inject = ["contributions"];

export interface MessageActionsConfig {
  enableShare?: boolean;
  enablePermalink?: boolean;
  enableQuoteReply?: boolean;
}

const DEFAULT_CONFIG: Required<MessageActionsConfig> = {
  enableShare: true,
  enablePermalink: true,
  enableQuoteReply: true,
};

function AssistantMessageTools({
  messageId,
  contentText,
}: {
  messageId: string;
  contentText: string;
}) {
  const cfg = usePluginConfig<MessageActionsConfig>("message-actions", DEFAULT_CONFIG);
  const enableShare = cfg.enableShare !== false;
  const enablePermalink = cfg.enablePermalink !== false;
  const enableQuoteReply = cfg.enableQuoteReply !== false;

  const shareContent = () => {
    const nav = navigator as Navigator & { share?: (data: { text?: string }) => Promise<void> };
    if (typeof nav.share === "function") {
      void nav.share({ text: contentText }).catch(() => {
        void navigator.clipboard
          .writeText(contentText)
          .then(() => showToast("已复制回复，可粘贴分享", "info"))
          .catch(() => undefined);
      });
      return;
    }
    void navigator.clipboard
      .writeText(contentText)
      .then(() => showToast("已复制回复，可粘贴分享", "info"))
      .catch(() => undefined);
  };

  const anchorMessage = () => {
    const node = document.getElementById(`message-${messageId}`);
    node?.scrollIntoView({ behavior: "smooth", block: "center" });
    const base = window.location.href.split("#")[0] ?? "";
    const url = `${base}#message-${messageId}`;
    void navigator.clipboard
      .writeText(url)
      .then(() => showToast("已复制消息定位", "info"))
      .catch(() => undefined);
  };

  const quoteReply = () => {
    const excerpt = contentText
      .trim()
      .split(/\r?\n/)
      .slice(0, 6)
      .map((line) => `> ${line}`)
      .join("\n");
    if (!excerpt) return;
    void sendChatPrompt(`${excerpt}\n\n请基于以上内容继续说明：`, { prefillOnly: true });
  };

  return (
    <>
      {enableShare && (
        <button type="button" className="dshc-action" title="分享" aria-label="分享" onClick={shareContent}>
          <Share2 size={15} strokeWidth={1.25} />
        </button>
      )}
      {enablePermalink && (
        <button type="button" className="dshc-action" title="定位此消息" aria-label="定位此消息" onClick={anchorMessage}>
          <Link2 size={15} strokeWidth={1.25} />
        </button>
      )}
      {enableQuoteReply && (
        <button type="button" className="dshc-action" title="引用追问" aria-label="引用追问" onClick={quoteReply}>
          <Quote size={14} strokeWidth={1.4} />
        </button>
      )}
    </>
  );
}

export function apply(ctx: Context): void {
  ctx.contributions.registerMessageAction({
    id: "message-actions:assistant",
    role: "assistant",
    order: 20,
    render: ({ message, contentText }) => (
      <AssistantMessageTools messageId={message.id} contentText={contentText} />
    ),
  });
}

export default {
  name,
  inject,
  apply,
};
