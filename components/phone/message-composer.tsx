"use client";

import { Button } from "@ui-sdk/react/button";
import { Textarea } from "@ui-sdk/react/textarea";
import { Icon } from "../ui/icon";

type Props = {
  value: string;
  onValueChange: (value: string) => void;
  onSend: (message: string) => Promise<void>;
  onStop: () => Promise<void>;
  waiting: boolean;
  busy: boolean;
};

export function MessageComposer({
  value,
  onValueChange,
  onSend,
  onStop,
  waiting,
  busy,
}: Props) {
  return (
    <form
      className="flex shrink-0 items-end gap-2 bg-white px-3 pt-3"
      aria-label="Write to Bell"
      onSubmit={(event) => {
        event.preventDefault();
        void onSend(value);
      }}
    >
      <div className="flex min-w-0 flex-1 items-end rounded-[23px] border border-[#b6b6bd] p-1 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[#007aff]">
        <Textarea
          id="message"
          aria-label="Message Bell"
          value={value}
          onValueChange={onValueChange}
          placeholder="iMessage"
          disabled={waiting}
          rows={1}
          autoResize
          submitShortcut="enter"
          className="min-h-8! w-full resize-none border-0! bg-transparent! px-3! py-1.5! text-[15px]! leading-5! shadow-none! outline-none! max-h-28"
        />
        {busy ? (
          <Button
            aria-label="Stop request"
            onClick={onStop}
            className="phone-send bg-[#646469]! text-white"
          >
            <Icon name="stop" className="size-4" fill="currentColor" />
          </Button>
        ) : (
          <Button
            type="submit"
            aria-label="Send message"
            data-agent-confirm="Sends this message to Bell"
            disabled={waiting || !value.trim()}
            className="phone-send bg-[#0071eb]! text-white"
          >
            <Icon name="arrowUp" className="size-5" strokeWidth="2.5" />
          </Button>
        )}
      </div>
    </form>
  );
}
