"use client";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEveAgent } from "eve/react";
import { activeTurn, openInteractions, signInEnding } from "eve/events";
import { useState } from "react";
import { browserPreview } from "./projection";

export default function Chat({ sessionId, demoUrl }: { sessionId?: string; demoUrl: string }) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [retiring, setRetiring] = useState(false);
  const agent = useEveAgent({
    initialSession: sessionId ? { sessionId, streamIndex: 0 } : undefined,
    resume: Boolean(sessionId),
    onSessionChange(session) {
      if (session && !sessionId)
        window.history.replaceState(null, "", `/s/${encodeURIComponent(session.sessionId)}`);
    },
  });
  const busy = agent.status === "busy";
  const waiting = busy || agent.status === "resuming" || retiring;
  const canStop = activeTurn(agent.view) !== undefined;
  const preview = browserPreview(agent.events);
  const pending = openInteractions(agent.view).filter(({ request }) => request.kind !== "sign-in");
  async function send(text: string) {
    if (!text.trim() || waiting) return;
    setError("");
    setInput("");
    try {
      await agent.send(text.trim());
    } catch {
      setError("The request failed. If the development server restarted, start a fresh conversation.");
    }
  }
  async function newConversation() {
    if (waiting) return;
    setRetiring(true);
    setError("");
    try {
      if (agent.session || sessionId) await agent.end();
      agent.newSession();
      setInput("");
      router.push("/");
    } catch {
      setError("Could not close this conversation. Try again.");
    } finally {
      setRetiring(false);
    }
  }
  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">PERSONAL ASSISTANT STACK</p>
          <h1>
            Bell<span>.</span>
          </h1>
        </div>
        <button
          className="new-chat"
          disabled={waiting}
          onClick={() => void newConversation()}
        >
          New conversation
        </button>
      </header>
      <section className="workspace">
        <div className="conversation">
          <h2>Ask. Browse. Verify.</h2>
          <p className="muted">One conversation, one persistent browser.</p>
          <button
            className="starter"
            disabled={waiting}
            onClick={() =>
              void send(
                `Open ${demoUrl} with run, describe what the page shows, then take a screenshot.`,
              )
            }
          >
            Open demo site ↗
          </button>
          <div className="messages" aria-live="polite">
            {agent.messages
              .filter((message) => message.role === "user" || message.role === "assistant")
              .map((message) => (
                <article key={message.id} className={message.role}>
                  <strong>{message.role === "user" ? "You" : "Bell"}</strong>
                  {message.parts.map((part, index) => {
                    if (part.type === "text") return <p key={index}>{part.text}</p>;
                    const interaction = part.type === "interaction" ? part
                      : part.type === "tool" ? part.interaction : undefined;
                    if (!interaction || interaction.request.kind !== "sign-in") return null;
                    const { request, outcome } = interaction;
                    const name = request.signIn?.displayName ?? "Account";
                    const url = request.link?.url ?? request.signIn?.url;
                    return (
                      <section key={index}>
                        {outcome ? <p>{name} {signInEnding(outcome)}.</p> : (
                          <>
                            <p>{request.prompt}</p>
                            {url && <a href={url} target="_blank" rel="noopener noreferrer">{request.link?.label ?? `Connect ${name}`}</a>}
                          </>
                        )}
                      </section>
                    );
                  })}
                </article>
              ))}
          </div>
          <p role="status" className="muted">
            {waiting ? "Working…" : "Ready"}
          </p>
          {(error || agent.error) && (
            <p role="alert">
              {error || "The agent request failed. If the development server restarted, start a fresh conversation."}
              {" "}<button type="button" disabled={waiting} onClick={() => void newConversation()}>Start a fresh conversation</button>
            </p>
          )}
          {pending.map(({ interactionId, request }) => (
            <fieldset key={interactionId}>
              <legend>{request.prompt}</legend>
              {request.options?.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() =>
                    void agent
                      .respond([{ interactionId, optionId: option.id }])
                      .catch(() => setError("Reply failed. Please retry."))
                  }
                >
                  {option.label}
                </button>
              ))}
              {request.allowFreeform && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const text = String(
                      new FormData(event.currentTarget).get("reply") ?? "",
                    ).trim();
                    if (text)
                      void agent
                        .respond([{ interactionId, text }])
                        .catch(() => setError("Reply failed. Please retry."));
                  }}
                >
                  <label htmlFor={`reply-${interactionId}`}>Your reply</label>
                  <input id={`reply-${interactionId}`} name="reply" required />
                  <button>Reply</button>
                </form>
              )}
            </fieldset>
          ))}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send(input);
            }}
          >
            <label htmlFor="message">Message Bell</label>
            <textarea
              id="message"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="What would you like to do?"
              disabled={waiting}
            />
            <div className="actions">
              <button type="submit" disabled={waiting || !input.trim()}>
                Send
              </button>
              {canStop && (
                <button
                  type="button"
                  onClick={() =>
                    void agent.cancel().catch(() => setError("Stop failed. Please retry."))
                  }
                >
                  Stop
                </button>
              )}
            </div>
          </form>
        </div>
        <aside>
          <div className="browser-bar">
            <span>Browser capture</span>
            <span>
              {preview.httpStatus
                ? `HTTP ${preview.httpStatus}`
                : preview.url
                  ? "Status unavailable"
                  : "Waiting"}
            </span>
          </div>
          <p className="address">{preview.url ?? "Your browser will appear here"}</p>
          {preview.screenshot ? (
            <Image
              src={preview.screenshot}
              width={1360}
              height={900}
              unoptimized
              alt="Latest browser screenshot"
            />
          ) : (
            <div className="empty">
              <span>✦</span>
              <p>See what Bell sees.</p>
              <small>Ask for a screenshot after a browser action.</small>
            </div>
          )}
          <p className="footnote">
            Screenshots update on request. This panel is a capture, not an interactive browser.
          </p>
        </aside>
      </section>
    </main>
  );
}
