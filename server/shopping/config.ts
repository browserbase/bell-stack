import { createHash } from "node:crypto";
import { configuredLinq, required } from "../monitors/config";

export const priceWatchesEnabled = () => process.env.BELL_PRICE_WATCHES_ENABLED === "true";
export const priceCheckHours = 1;
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const linqFingerprint = () => {
  const key = process.env.LINQ_API_KEY?.trim();
  return key ? digest(key) : undefined;
};

export function requirePriceEnrollment() {
  if (!priceWatchesEnabled()) throw new Error("Watches for product prices are currently unavailable.");
  for (const name of ["DATABASE_URL", "CRON_SECRET", "LINQ_API_KEY", "LINQ_WEBHOOK_SECRET"]) required(name);
}

export function configuredPriceLine() {
  try { requirePriceEnrollment(); } catch { return undefined; }
  return configuredLinq()?.line;
}
