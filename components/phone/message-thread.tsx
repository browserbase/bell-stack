"use client";

import {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaViewport,
  ScrollAreaScrollToEnd,
} from "@ui-sdk/react/scroll-area";
import type { EveMessage, EveMessageInputRequest } from "eve/react";
import type { InputResponse } from "eve/client";
import { ApprovalRequest } from "./approval-request";

type Props = {
  messages: readonly EveMessage[];
  pending: readonly EveMessageInputRequest[];
  onRespond: (response: InputResponse) => Promise<void>;
  busy: boolean;
  error: string;
  status: string;
};

export function MessageThread({
  messages,
  pending,
  onRespond,
  busy,
  error,
  status,
}: Props) {
  const visible = messages.filter(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      message.parts.some((part) => part.type === "text" && part.text),
  );
  return (
    <ScrollArea
      stickToEnd
      className="relative min-h-0 flex-1 rounded-none border-0"
    >
      <ScrollAreaViewport
        role="log"
        aria-label="Conversation with Bell"
        className="h-full w-full overflow-x-hidden!"
      >
        <ScrollAreaContent className="px-3 pb-2 pt-5">
          <p className="mb-5 text-center text-[11px] leading-4 text-[#6b6b72]">
            iMessage
          </p>
          <div className="message-bubble message-incoming" data-tail>
            What can I help with?
          </div>
          {visible.map((message, messageIndex) => (
            <article
              key={message.id}
              aria-label={message.role === "user" ? "You" : "Bell"}
              data-tail={
                visible[messageIndex + 1]?.role !== message.role || undefined
              }
              className={`message-bubble mt-2 ${message.role === "user" ? "message-outgoing" : "message-incoming"}`}
            >
              {message.parts.flatMap((part, index) =>
                part.type === "text" && part.text
                  ? [
                      <p
                        key={index}
                        className="whitespace-pre-wrap wrap-anywhere not-first:mt-2"
                      >
                        {part.text}
                      </p>,
                    ]
                  : [],
              )}
            </article>
          ))}
          {busy && pending.length === 0 && (
            <div
              className="message-bubble message-incoming mt-3 flex w-fit gap-1 py-3.5!"
              aria-hidden="true"
            >
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </div>
          )}
          {pending.map((request) => (
            <ApprovalRequest
              key={request.requestId}
              request={request}
              onRespond={onRespond}
            />
          ))}
          {error && (
            <p
              role="alert"
              className="mt-3 rounded-xl bg-red-50 p-3 text-[12px] leading-5 text-error"
            >
              {error}
            </p>
          )}
          <p
            role="status"
            className="mt-4 text-center text-[11px] text-[#6b6b72] empty:mt-0"
          >
            {pending.length ? "Bell needs your reply" : status}
          </p>
        </ScrollAreaContent>
      </ScrollAreaViewport>
      <ScrollAreaScrollToEnd className="jump-to-latest">
        Latest messages
      </ScrollAreaScrollToEnd>
    </ScrollArea>
  );
}
