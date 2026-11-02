import { routeAuth } from "eve/channels/auth";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { crossmintConfig, CrossmintSetupError, getBuyerProfile, isCrossmintConfigured } from "../../../server/crossmint/client";
import { isCrossmintCardsConfigured } from "../../../server/crossmint/cards";
import { CrossmintOperatorError, listOrderIntents, operatorConfig, type OperatorConfig } from "../../../server/crossmint/operator";
import { operatorAuth } from "../../../server/operator-auth";
import Setup, { type Check, type SetupProps } from "./setup";
import { budgetView, profileView } from "./view";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Payments setup | Bell" };

const message = (error: unknown) => (error instanceof Error ? error.message : "Unexpected error.");

// Operator only. proxy.ts asks for the credentials; this checks again before signing a token.
export default async function CrossmintSetupPage() {
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") ?? incoming.get("host") ?? "localhost";
  const protocol = incoming.get("x-forwarded-proto") ?? "http";
  const auth = await routeAuth(new Request(`${protocol}://${host}/crossmint/setup`, { headers: incoming }), [operatorAuth]);
  if (auth instanceof Response) {
    return <main><p role="alert">Sign in as the Bell operator to set up payments.</p></main>;
  }

  const props: SetupProps = {
    checks: { server: { state: "todo", text: "" }, operator: { state: "todo", text: "" }, token: { state: "todo", text: "" } },
    budgets: [],
    defaults: {},
    configured: { profile: Boolean(process.env.CROSSMINT_BUYER_PROFILE_ID?.trim()), orderIntent: Boolean(process.env.CROSSMINT_ORDER_INTENT_ID?.trim()) },
  };

  // 1. The server key runs checkouts.
  let serverReady = false;
  try {
    if (!isCrossmintConfigured()) throw new CrossmintSetupError("missing_configuration", "CROSSMINT_SERVER_API_KEY and CROSSMINT_USER_ID");
    crossmintConfig();
    serverReady = true;
    props.checks.server = { state: "ok", text: "Server key and operator id are set." };
  } catch (error) {
    props.checks.server = { state: "error", text: message(error) } satisfies Check;
  }

  // 2. The client key and Bell's operator token approve budgets.
  let config: OperatorConfig | undefined;
  try {
    config = operatorConfig();
    props.checks.operator = { state: "ok", text: "Client key, project id, and signing key are set." };
    const loopback = new URL(config.origin).protocol === "http:";
    props.jwks = { url: `${config.origin}/api/crossmint/jwks`, issuer: config.projectId, loopback };
  } catch (error) {
    props.checks.operator = { state: serverReady ? "error" : "todo", text: message(error) };
  }

  // 3. Crossmint accepts Bell's token: listing budgets proves it.
  if (config) {
    try {
      const configured = process.env.CROSSMINT_ORDER_INTENT_ID?.trim();
      const cards = isCrossmintCardsConfigured();
      props.budgets = (await listOrderIntents({ config })).map((intent) => budgetView(intent, configured, undefined, cards));
      props.checks.token = { state: "ok", text: "Crossmint accepts Bell's operator token." };
      props.apiKey = config.clientApiKey;
    } catch (error) {
      props.checks.token =
        error instanceof CrossmintOperatorError && error.reason === "unauthorized"
          ? { state: "error", text: "Crossmint rejected Bell's operator token. Point the project's custom JWT settings at Bell below." }
          : { state: "error", text: message(error) };
    }
  }

  // Delivery details, read with the server key.
  const profileId = process.env.CROSSMINT_BUYER_PROFILE_ID?.trim();
  if (serverReady && profileId) {
    try {
      const profile = profileView(await getBuyerProfile(profileId));
      props.profile = profile;
      props.defaults = { email: profile.email, countryCode: profile.countryCode };
    } catch (error) {
      props.profileError = `CROSSMINT_BUYER_PROFILE_ID: ${message(error)}`;
    }
  }

  return <Setup {...props} />;
}
