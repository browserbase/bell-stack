import type { SVGProps } from "react";

const paths = {
  arrowUp: "M12 19V5m-6 6 6-6 6 6",
  arrowUpRight: "M6 18 18 6M6 6h12v12",
  chevronLeft: "m15 18-6-6 6-6",
  chevronRight: "m9 5 7 7-7 7",
  plus: "M12 5v14M5 12h14",
  globe:
    "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z",
  lock: "M6 10h12v10H6zM8 10V7a4 4 0 0 1 8 0v3",
  monitor: "M3 4h18v13H3zM12 17v4M8 21h8",
  message: "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H3l2.2-4A8.5 8.5 0 1 1 21 11.5Z",
  check: "m5 12 4 4L19 6",
  stop: "M6 6h12v12H6z",
  signal: "M4 17v3M9 13v7M14 8v12M19 4v16",
  wifi: "M3 8a15 15 0 0 1 18 0M6 12a10 10 0 0 1 12 0M9 16a5 5 0 0 1 6 0M12 20h.01",
} satisfies Record<string, string>;

export function Icon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & { name: keyof typeof paths }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  );
}
