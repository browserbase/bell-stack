"use client";

import { useBellConversation } from "../hooks/use-bell-conversation";
import { PhoneShell } from "./phone/phone-shell";
import { MessageThread } from "./phone/message-thread";
import { MessageComposer } from "./phone/message-composer";
import { WorkspaceHeader } from "./workspace/workspace-header";
import { BrowserPreview } from "./workspace/browser-preview";
import { WebMcpBridge } from "./webmcp-bridge";

export default function BellWorkspace({
  sessionId,
  demoUrl,
}: {
  sessionId?: string;
  demoUrl: string;
}) {
  const conversation = useBellConversation(sessionId);
  return (
    <>
      <WebMcpBridge />
      <a href="#message" className="skip-link">
        Skip to message
      </a>
      <WorkspaceHeader
        waiting={conversation.waiting}
        onNewConversation={conversation.newConversation}
      />
      <main className="mx-auto max-w-[1440px] px-5 pb-8 pt-6 sm:px-10 sm:pt-8 lg:px-14 lg:pt-10">
        <div className="grid items-start gap-10 lg:grid-cols-[390px_minmax(0,1fr)] lg:gap-12 xl:gap-16">
          <div>
            <PhoneShell>
              <MessageThread
                messages={conversation.messages}
                pending={conversation.pending}
                onRespond={conversation.respond}
                onNewConversation={conversation.newConversation}
                waiting={conversation.waiting}
                busy={conversation.busy}
                error={conversation.error}
                status={conversation.status}
              />
              <MessageComposer
                value={conversation.input}
                onValueChange={conversation.setInput}
                onSend={conversation.send}
                onStop={conversation.stop}
                waiting={conversation.waiting}
                busy={conversation.busy}
              />
            </PhoneShell>
          </div>
          <div className="min-w-0 lg:pt-1">
            <p className="mb-5 max-w-lg text-sm leading-6 text-text-secondary">
              Ask Bell to research a topic, plan a trip, or find a product.
            </p>
            <BrowserPreview
              preview={conversation.preview}
              busy={conversation.busy}
              waiting={conversation.waiting}
              onOpenDemo={() =>
                conversation.send(
                  `Open ${demoUrl} with run, describe what the page shows, then take a screenshot.`,
                )
              }
            />
          </div>
        </div>
      </main>
    </>
  );
}
