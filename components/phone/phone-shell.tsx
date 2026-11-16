import type { ReactNode } from "react";
import { BellMark } from "../ui/bell-mark";
import { Icon } from "../ui/icon";
import { PhoneClock } from "./phone-clock";
import "./phone.css";

export function PhoneShell({ children }: { children: ReactNode }) {
  return (
    <section aria-label="Messages with Bell" className="phone-frame">
      <div className="phone-hardware" aria-hidden="true">
        <span className="phone-action-button" />
        <span className="phone-volume-up" />
        <span className="phone-volume-down" />
        <span className="phone-power-button" />
      </div>
      <div className="phone-screen">
        <div className="phone-status-bar" aria-hidden="true">
          <PhoneClock />
          <span className="phone-island">
            <span className="phone-camera" />
          </span>
          <span className="flex items-center gap-1">
            <Icon name="signal" className="size-3.5" strokeWidth="2.5" />
            <Icon name="wifi" className="size-3.5" strokeWidth="2.5" />
            <span className="relative ml-0.5 h-[10px] w-[19px] rounded-[3px] border border-black/50 p-px after:absolute after:-right-[3px] after:top-[2px] after:h-1 after:w-px after:bg-black/50">
              <span className="block h-full rounded-[1px] bg-black" />
            </span>
          </span>
        </div>
        <div className="phone-contact">
          <span
            className="absolute left-4 top-5 text-[#007aff]"
            aria-hidden="true"
          >
            <Icon name="chevronLeft" className="size-7" />
          </span>
          <BellMark className="mb-1.5 size-10 rounded-full!" />
          <h2 className="flex items-center gap-0.5 text-[13px] font-medium">
            Bell
            <Icon name="chevronRight" className="size-3 text-[#85858b]" />
          </h2>
        </div>
        {children}
        <div className="phone-home-indicator" aria-hidden="true">
          <span />
        </div>
      </div>
    </section>
  );
}
