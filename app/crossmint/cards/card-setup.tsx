"use client";

import { CrossmintAgentCardAuthorization, CrossmintProvider, type AgentCardAuthorizationResult } from "@crossmint/client-sdk-react-ui";
import { useState, type FormEvent } from "react";

interface Budget {
  amount: { value: string; currency: string };
  merchant: { name: string; url: string; countryCode: string };
  description: string;
  expiresAt: string;
}

// Crossmint's component selects or saves the card, registers it, creates the order intent, and
// runs the card network's verification. Card details never reach this page.
export default function CardSetup({ apiKey, jwt }: { apiKey: string; jwt: string }) {
  const [budget, setBudget] = useState<Budget>();
  const [result, setResult] = useState<AgentCardAuthorizationResult>();
  const [error, setError] = useState("");

  function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    setError("");
    setBudget({
      amount: { value: text("amount"), currency: text("currency").toUpperCase() },
      merchant: { name: text("merchantName"), url: text("merchantUrl"), countryCode: text("merchantCountry").toUpperCase() },
      description: text("description"),
      expiresAt: new Date(Date.now() + Number(text("days")) * 86_400_000).toISOString(),
    });
  }

  if (result) {
    const network = result.rail.rail === "agentic-token";
    return (
      <section>
        <h2>Order intent approved</h2>
        <p>
          {result.paymentMethod.brand} ending {result.paymentMethod.last4}, {result.amount.available} {result.amount.currency} available
          until {new Date(result.expiresAt).toLocaleString()}.
        </p>
        {network ? (
          <p className="muted">Rail: {result.rail.rail} ({result.rail.provider}). crossmint_card_checkout can pay with it.</p>
        ) : (
          <p role="alert">
            This card has no Visa Intelligent Commerce or Mastercard Agent Pay rail, so crossmint_card_checkout cannot pay with it.
            Agent Checkouts can.
          </p>
        )}
        <p>Add this line to .env.local and restart Bell:</p>
        <pre>CROSSMINT_ORDER_INTENT_ID={result.orderIntentId}</pre>
      </section>
    );
  }

  if (budget) {
    return (
      <CrossmintProvider apiKey={apiKey} consoleLogLevel="error">
        <CrossmintAgentCardAuthorization
          jwt={jwt}
          {...budget}
          displayName="Bell"
          onAuthorized={setResult}
          onError={(failure) => {
            setError(`${failure.code}: ${failure.message}`);
            setBudget(undefined);
          }}
        />
      </CrossmintProvider>
    );
  }

  return (
    <form onSubmit={approve}>
      {error ? <p role="alert">{error}</p> : null}
      <fieldset>
        <legend>Budget</legend>
        <label>
          Amount
          <input name="amount" required inputMode="decimal" pattern="(?:[1-9]\d{0,14}(?:\.\d{1,2})?|0\.\d{1,2})" placeholder="50.00" />
        </label>
        <label>
          Currency
          <input name="currency" required pattern="[A-Za-z]{3}" defaultValue="USD" />
        </label>
        <label>
          Valid for days
          <input name="days" type="number" required min={1} max={365} defaultValue={30} />
        </label>
        <label>
          Description
          <input name="description" required maxLength={200} placeholder="Groceries" />
        </label>
      </fieldset>
      <fieldset>
        <legend>Merchant</legend>
        <label>
          Name
          <input name="merchantName" required maxLength={200} placeholder="Example Shop" />
        </label>
        <label>
          Checkout URL, on the host Bell will pay at
          <input name="merchantUrl" type="url" required pattern="https://.+" placeholder="https://shop.example" />
        </label>
        <label>
          Country
          <input name="merchantCountry" required pattern="[A-Za-z]{2}" defaultValue="US" />
        </label>
      </fieldset>
      <button type="submit">Continue to card</button>
    </form>
  );
}
