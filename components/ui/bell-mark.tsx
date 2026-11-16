import Image from "next/image";

export function BellMark({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center ${className}`}
      aria-hidden="true"
    >
      <Image
        src="/bell.png"
        width={512}
        height={512}
        alt=""
        unoptimized
        className="block h-full w-full object-contain [image-rendering:pixelated]"
      />
    </span>
  );
}
