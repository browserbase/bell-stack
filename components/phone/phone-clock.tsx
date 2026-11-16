"use client";

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  const timer = window.setInterval(onChange, 1000);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onChange);
  };
}

const currentMinute = () => Math.floor(Date.now() / 60_000);
const serverMinute = () => null;

export function PhoneClock() {
  const minute = useSyncExternalStore<number | null>(
    subscribe,
    currentMinute,
    serverMinute,
  );
  const date = minute === null ? null : new Date(minute * 60_000);
  const time = date
    ? `${date.getHours() % 12 || 12}:${String(date.getMinutes()).padStart(2, "0")}`
    : "--:--";

  return <span className="tabular-nums">{time}</span>;
}
