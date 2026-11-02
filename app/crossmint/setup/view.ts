import type { BuyerProfile } from "../../../server/crossmint/client";
import { describeRail, type OrderIntentSummary } from "../../../server/crossmint/operator";

/** What the setup page shows about a budget (an order intent). */
export interface Budget {
  id: string;
  status: string;
  available: string;
  total?: string;
  currency: string;
  merchantName?: string;
  merchantHost?: string;
  expiresAt: string;
  rails: string[];
  /** A Visa or Mastercard agent rail is active, so Bell's own browser can pay with it too. */
  networkRail: boolean;
  /** CROSSMINT_ORDER_INTENT_ID names this budget. */
  inUse: boolean;
  /** Active and not yet expired when the page was rendered. */
  live: boolean;
}

export function budgetView(intent: OrderIntentSummary, configuredId?: string, now = Date.now()): Budget {
  const host = intent.merchant?.url ? URL.parse(intent.merchant.url)?.hostname : undefined;
  return {
    id: intent.orderIntentId,
    status: intent.status,
    available: intent.amount.available,
    ...(intent.amount.total ? { total: intent.amount.total } : {}),
    currency: intent.amount.currency.toUpperCase(),
    ...(intent.merchant?.name ? { merchantName: intent.merchant.name } : {}),
    ...(host ? { merchantHost: host } : {}),
    expiresAt: intent.expiresAt,
    rails: intent.rails.map(describeRail),
    networkRail: intent.rails.some((rail) => rail.rail === "agentic-token" && rail.status === "active"),
    inUse: Boolean(configuredId) && intent.orderIntentId === configuredId,
    live: intent.status === "active" && Date.parse(intent.expiresAt) > now,
  };
}

/** What the setup page shows about the saved delivery details. */
export interface ProfileView {
  name?: string;
  place: string;
  email?: string;
  countryCode: string;
}

export function profileView(profile: BuyerProfile): ProfileView {
  return {
    ...(profile.name ? { name: `${profile.name.first} ${profile.name.last}` } : {}),
    place: [profile.shipping.postalCode, profile.shipping.locality].filter(Boolean).join(" "),
    ...(profile.contact?.email ? { email: profile.contact.email } : {}),
    countryCode: profile.shipping.countryCode,
  };
}
