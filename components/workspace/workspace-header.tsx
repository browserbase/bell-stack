import { Button } from "@ui-sdk/react/button";
import { BellMark } from "../ui/bell-mark";
import { Icon } from "../ui/icon";

export function WorkspaceHeader({
  waiting,
  onNewConversation,
}: {
  waiting: boolean;
  onNewConversation: () => Promise<void>;
}) {
  return (
    <header className="border-b border-border-solid bg-bg-main">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between gap-4 px-5 sm:h-20 sm:px-10 lg:px-14">
        <div className="flex items-center gap-3">
          <BellMark className="size-9" />
          <h1 className="font-sans text-[27px] leading-none tracking-tight">
            Bell
          </h1>
          <span className="hidden border-l border-border-solid pl-3 text-sm text-text-secondary sm:block">
            Personal assistant stack
          </span>
        </div>
        <Button
          onClick={onNewConversation}
          data-agent-confirm="Closes the current conversation and starts a new one"
          disabled={waiting}
          className="secondary-button"
        >
          <Icon name="plus" className="size-4" />
          New conversation
        </Button>
      </div>
    </header>
  );
}
