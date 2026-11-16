"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useEveAgent } from "eve/react";
import { Client, parseInputResponses, type InputResponse } from "eve/client";
import { browserPreview } from "../app/projection";

export function useBellConversation(sessionId?: string) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [retiring, setRetiring] = useState(false);
  const sending = useRef(false);
  const agent = useEveAgent({
    initialSession: sessionId ? { sessionId, streamIndex: 0 } : undefined,
    resume: Boolean(sessionId),
    onSessionChange(session) {
      if (session && !sessionId)
        window.history.replaceState(
          null,
          "",
          `/s/${encodeURIComponent(session.sessionId)}`,
        );
    },
  });
  const busy = agent.status === "submitted" || agent.status === "streaming";
  const waiting = busy || agent.status === "resuming" || retiring;
  const pending = agent.data.messages
    .flatMap((message) => message.parts)
    .flatMap((part) => {
      if (part.type !== "dynamic-tool" || part.state !== "approval-requested")
        return [];
      const request = part.toolMetadata?.eve?.inputRequest;
      return request ? [request] : [];
    });

  async function send(text: string) {
    const message = text.trim();
    if (!message || waiting || sending.current) return;
    sending.current = true;
    setError("");
    setInput("");
    try {
      await agent.send(message);
    } catch {
      setInput((draft) => draft || text);
      setError(
        "Your message couldn't be sent. Check your connection and try again.",
      );
    } finally {
      sending.current = false;
    }
  }

  async function newConversation() {
    if (waiting || sending.current) return;
    setRetiring(true);
    setError("");
    try {
      if (agent.session)
        await new Client({ host: "" }).sessions
          .attach(agent.session.sessionId)
          .reset();
      agent.reset();
      setInput("");
      router.push("/");
    } catch {
      setError("Couldn't close this conversation. Please try again.");
    } finally {
      setRetiring(false);
    }
  }

  async function respond(response: InputResponse) {
    await agent.respond(parseInputResponses([response]));
  }

  async function stop() {
    try {
      await agent.cancel();
    } catch {
      setError("Couldn't stop this request. Please try again.");
    }
  }

  return {
    input,
    setInput,
    busy,
    waiting,
    pending,
    messages: agent.data.messages,
    preview: browserPreview(agent.events),
    status: retiring
      ? "Closing conversation"
      : agent.status === "resuming"
        ? "Reconnecting"
        : busy
          ? "Working…"
          : "",
    error:
      error ||
      (agent.error
        ? "Bell couldn't finish this request. Please try again."
        : ""),
    send,
    respond,
    stop,
    newConversation,
  };
}
