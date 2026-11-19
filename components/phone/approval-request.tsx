"use client";

import { useState } from "react";
import { Button } from "@ui-sdk/react/button";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import type { EveMessageInputRequest } from "eve/react";
import type { InputResponse } from "eve/client";

export function ApprovalRequest({
  request,
  onRespond,
}: {
  request: EveMessageInputRequest;
  onRespond: (response: InputResponse) => Promise<void>;
}) {
  const [reply, setReply] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function respond(response: InputResponse) {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await onRespond(response);
      setReply("");
    } catch {
      setError("Your reply couldn't be sent. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <fieldset
      className="my-3 min-w-0 rounded-2xl border border-[#c8c8ce] bg-[#fafafa] p-3"
      disabled={submitting}
    >
      <legend className="max-w-full px-1 text-[13px] font-semibold">
        {request.prompt}
      </legend>
      <div className="flex flex-wrap gap-2">
        {request.options?.map((option) => (
          <Button
            key={option.id}
            onClick={() =>
              respond({ requestId: request.requestId, optionId: option.id })
            }
            className="approval-option"
            data-danger={option.style === "danger" || undefined}
          >
            {option.label}
          </Button>
        ))}
      </div>
      {request.allowFreeform && (
        <form
          className="mt-3 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (reply.trim())
              void respond({
                requestId: request.requestId,
                text: reply.trim(),
              });
          }}
        >
          <Field>
            <FieldLabel className="text-xs">Your reply</FieldLabel>
            <Input
              value={reply}
              onValueChange={setReply}
              name="reply"
              required
              className="w-full! min-w-0! rounded-lg! bg-white!"
            />
          </Field>
          <Button
            type="submit"
            disabled={!reply.trim()}
            className="approval-option"
          >
            Reply
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-error">
          {error}
        </p>
      )}
    </fieldset>
  );
}
