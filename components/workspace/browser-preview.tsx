import Image from "next/image";
import type { browserPreview } from "../../app/projection";
import { Icon } from "../ui/icon";
import { Button } from "@ui-sdk/react/button";

export function BrowserPreview({
  preview,
  busy,
  waiting,
  onOpenDemo,
}: {
  preview: ReturnType<typeof browserPreview>;
  busy: boolean;
  waiting: boolean;
  onOpenDemo: () => Promise<void>;
}) {
  return (
    <section
      aria-labelledby="browser-heading"
      className="flex min-w-0 flex-col"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2
          id="browser-heading"
          className="flex items-center gap-2 text-sm font-medium"
        >
          <Icon name="monitor" className="size-4 text-text-secondary" />
          Browser
        </h2>
        <span className="flex items-center gap-1.5 text-xs text-text-secondary">
          <span
            className={`size-1.5 rounded-full ${busy ? "bg-primary" : "bg-[#6a6a70]"}`}
          />
          {busy ? "Working" : preview.url ? "Session open" : "Idle"}
        </span>
      </div>
      <div className="flex h-[430px] flex-col overflow-hidden rounded-xl border border-border-medium bg-white shadow-[0_5px_20px_-12px_#260f1720] lg:h-[550px]">
        <div className="flex h-12 shrink-0 items-center gap-4 border-b border-border-solid bg-[#fafafa] px-4">
          <span className="flex gap-1.5" aria-hidden="true">
            <span className="size-2.5 rounded-full border border-[#d45950] bg-[#ff6058]" />
            <span className="size-2.5 rounded-full border border-[#dba02e] bg-[#ffbd2d]" />
            <span className="size-2.5 rounded-full border border-[#2aab45] bg-[#28c840]" />
          </span>
          <div className="mx-auto flex min-w-0 flex-1 items-center justify-center gap-2 rounded-md border border-border-solid bg-white px-3 py-1.5 text-xs text-text-secondary sm:max-w-[380px]">
            <Icon
              name={preview.url ? "globe" : "lock"}
              className="size-3 shrink-0"
            />
            <span className="truncate" title={preview.url}>
              {preview.url ?? "about:blank"}
            </span>
          </div>
          <span className="hidden w-8 sm:block" aria-hidden="true" />
        </div>
        {preview.screenshot ? (
          <div
            tabIndex={0}
            role="region"
            aria-label="Browser screenshot"
            className="min-h-0 flex-1 overflow-auto bg-bg-subtle"
          >
            <Image
              src={preview.screenshot}
              width={1360}
              height={900}
              unoptimized
              alt="Latest browser screenshot"
              className="block h-auto w-full"
            />
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
            <Icon name="monitor" className="mb-4 size-7 text-text-tertiary" />
            <h3 className="text-lg font-medium tracking-tight">
              See what Bell sees.
            </h3>
            <p className="mt-2 max-w-[290px] text-sm leading-6 text-text-secondary">
              {preview.url
                ? "Ask Bell to take a screenshot of this page."
                : "Ask Bell to open a page and take a screenshot."}
            </p>
            {!preview.url && (
              <Button
                className="secondary-button mt-4"
                disabled={waiting}
                onClick={onOpenDemo}
                data-agent-confirm="Opens the demo site with Bell"
              >
                Open demo
              </Button>
            )}
          </div>
        )}
        <div className="flex min-h-10 shrink-0 items-center justify-between gap-2 border-t border-border-solid px-4 py-2 text-[11px] text-text-secondary">
          <span className="flex items-center gap-1.5">Screenshots only</span>
          <span>{preview.httpStatus ? `HTTP ${preview.httpStatus}` : ""}</span>
        </div>
      </div>
    </section>
  );
}
