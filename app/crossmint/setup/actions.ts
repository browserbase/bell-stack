"use server";

import { routeAuth } from "eve/channels/auth";
import { headers } from "next/headers";
import { z } from "zod";
import { isCrossmintCardsConfigured } from "../../../server/crossmint/cards";
import { AMOUNT, createBuyerProfile, CrossmintRequestError, CrossmintSetupError } from "../../../server/crossmint/client";
import {
  cancelOrderIntent,
  createOrderIntent,
  CrossmintOperatorError,
  getRegistration,
  operatorConfig,
  registerCard,
} from "../../../server/crossmint/operator";
import { operatorJwt } from "../../../server/crossmint/operator-jwt";
import { operatorAuth } from "../../../server/operator-auth";
import { budgetView, type Budget, type ProfileView, profileView } from "./view";

export type ActionResult<T> = ({ ok: true } & T) | { ok: false; message: string };

/**
 * The proxy already asked for the operator's credentials; every action checks them again, as the
 * POST it is, so the same-origin guard for writes runs here too.
 */
async function requireOperator(): Promise<void> {
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") ?? incoming.get("host") ?? "localhost";
  const protocol = incoming.get("x-forwarded-proto") ?? "http";
  const request = new Request(`${protocol}://${host}/crossmint/setup`, { method: "POST", headers: incoming });
  const auth = await routeAuth(request, [operatorAuth]);
  if (auth instanceof Response) throw new Error("Sign in as the Bell operator.");
}

/** Operator-facing messages. Crossmint's own message is kept when it names the fix. */
function failure(error: unknown): { ok: false; message: string } {
  if (error instanceof CrossmintOperatorError) {
    return { ok: false, message: error.detail ? `${error.message} Crossmint says: ${error.detail}` : error.message };
  }
  if (error instanceof CrossmintSetupError || error instanceof CrossmintRequestError) return { ok: false, message: error.message };
  if (error instanceof z.ZodError) return { ok: false, message: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
  throw error;
}

/** A fresh ten-minute operator token for Crossmint's card form. */
export async function refreshToken(): Promise<ActionResult<{ jwt: string }>> {
  await requireOperator();
  try {
    return { ok: true, jwt: operatorJwt(operatorConfig()) };
  } catch (error) {
    return failure(error);
  }
}

const country = z.string().trim().regex(/^[A-Za-z]{2}$/, "two-letter country code").transform((value) => value.toUpperCase());

const profileInput = z.object({
  first: z.string().trim().min(1).max(100),
  last: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().min(5).max(40),
  street: z.string().trim().min(1).max(200),
  street2: z.string().trim().max(200).optional(),
  postalCode: z.string().trim().min(1).max(40),
  locality: z.string().trim().min(1).max(120),
  region: z.string().trim().max(10).optional(),
  countryCode: country,
});

/** Save the delivery details checkouts use instead of asking. No payment data is stored. */
export async function saveBuyerProfile(input: z.input<typeof profileInput>): Promise<ActionResult<{ id: string; profile: ProfileView }>> {
  await requireOperator();
  try {
    const value = profileInput.parse(input);
    const saved = await createBuyerProfile({
      label: "Bell",
      name: { first: value.first, last: value.last },
      contact: { email: value.email, phone: value.phone },
      shipping: {
        addressLines: [value.street, value.street2].filter((line): line is string => Boolean(line)),
        locality: value.locality,
        countryCode: value.countryCode,
        administrativeAreaCode: value.region ? value.region.toUpperCase() : null,
        postalCode: value.postalCode,
      },
    });
    return { ok: true, id: saved.id, profile: profileView(saved) };
  } catch (error) {
    return failure(error);
  }
}

const budgetInput = z.object({
  paymentMethodId: z.string().min(1).max(200),
  /** One per draft, so a repeated or retried approval never creates a second budget. */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9-]{16,64}$/),
  amount: z.string().regex(AMOUNT, "decimal amount such as 30.00"),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/, "three-letter currency code").transform((value) => value.toUpperCase()),
  days: z.coerce.number().int().min(1).max(365),
  description: z.string().trim().min(1).max(200),
  merchant: z.object({
    name: z.string().trim().min(1).max(200),
    url: z.string().trim().url().refine((value) => value.startsWith("https://"), "an HTTPS URL"),
    countryCode: country,
  }),
  consumer: z.object({ email: z.string().trim().email(), countryCode: country, languageCode: z.string().trim().min(2).max(35) }),
});

/**
 * Register the saved card with the person's email, then approve the budget. Crossmint refuses an
 * empty registration, and Crossmint's card component sends one, so Bell registers first.
 */
export async function approveBudget(input: z.input<typeof budgetInput>): Promise<ActionResult<{ budget: Budget }>> {
  await requireOperator();
  try {
    const value = budgetInput.parse(input);
    const registration = await getRegistration(value.paymentMethodId);
    if (!registration || !registration.rails.some((rail) => rail.status === "enabled")) {
      await registerCard(value.paymentMethodId, value.consumer);
    }
    const intent = await createOrderIntent({
      paymentMethodId: value.paymentMethodId,
      amount: { value: value.amount, currency: value.currency },
      merchant: value.merchant,
      description: value.description,
      expiresAt: new Date(Date.now() + value.days * 86_400_000).toISOString(),
    }, { idempotencyKey: `bell-budget-${value.idempotencyKey}` });
    return { ok: true, budget: budgetView(intent, process.env.CROSSMINT_ORDER_INTENT_ID?.trim(), undefined, isCrossmintCardsConfigured()) };
  } catch (error) {
    return failure(error);
  }
}

/** Cancel a budget. Nothing more can be spent from it. */
export async function cancelBudget(orderIntentId: string): Promise<ActionResult<object>> {
  await requireOperator();
  try {
    await cancelOrderIntent(z.string().min(1).max(200).parse(orderIntentId));
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}
