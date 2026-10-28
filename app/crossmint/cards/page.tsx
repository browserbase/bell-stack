import { routeAuth } from "eve/channels/auth";
import { headers } from "next/headers";
import { CrossmintSetupError } from "../../../server/crossmint/client";
import { cardConfig } from "../../../server/crossmint/cards";
import { operatorJwt } from "../../../server/crossmint/operator-jwt";
import { operatorAuth } from "../../../server/operator-auth";
import CardSetup from "./card-setup";

export const dynamic = "force-dynamic";

// Operator only. proxy.ts asks for the credentials; this checks again before signing a token.
export default async function CrossmintCardsPage() {
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") ?? incoming.get("host") ?? "localhost";
  const protocol = incoming.get("x-forwarded-proto") ?? "http";
  const auth = await routeAuth(new Request(`${protocol}://${host}/crossmint/cards`, { headers: incoming }), [operatorAuth]);
  if (auth instanceof Response) {
    return <main><p role="alert">Sign in as the Bell operator to set up a Crossmint agent card.</p></main>;
  }

  let setup: { apiKey: string; jwt: string } | { error: string };
  try {
    const config = cardConfig();
    setup = { apiKey: config.clientApiKey, jwt: operatorJwt(config) };
  } catch (error) {
    if (!(error instanceof CrossmintSetupError)) throw error;
    setup = { error: `${error.message} See docs/crossmint.md.` };
  }

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">Crossmint</p>
          <h1>Agent card setup</h1>
        </div>
      </header>
      <p className="muted">
        Save your card, register it, approve an order intent for one merchant, and verify the card rail. Then paste
        the order intent id into .env.local and restart Bell. This page signs you in to Crossmint for ten minutes;
        reload it to continue after that.
      </p>
      {"error" in setup ? <p role="alert">{setup.error}</p> : <CardSetup apiKey={setup.apiKey} jwt={setup.jwt} />}
    </main>
  );
}
