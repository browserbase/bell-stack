"use client";

import { CrossmintPaymentMethodManagement, CrossmintProvider, OrderIntentVerification } from "@crossmint/client-sdk-react-ui";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type FormEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { approveBudget, cancelBudget, refreshToken, saveBuyerProfile } from "./actions";
import logo from "./crossmint-logo.svg";
import styles from "./setup.module.css";
import type { Budget, ProfileView } from "./view";

export interface Check {
  state: "ok" | "todo" | "error";
  text: string;
}

export interface SetupProps {
  checks: { server: Check; operator: Check; token: Check };
  jwks?: { url: string; issuer: string; loopback: boolean };
  /** Only when Crossmint accepted Bell's token. The card form asks for a ten-minute token itself. */
  apiKey?: string;
  profile?: ProfileView;
  profileError?: string;
  budgets: Budget[];
  defaults: { email?: string; countryCode?: string };
  configured: { profile: boolean; orderIntent: boolean };
}

// Crossmint's card form in Crossmint's colors, with the page's font stack. No web font is fetched.
const cardAppearance = {
  variables: {
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    borderRadius: "8px",
    colors: {
      accent: "#00C768",
      textPrimary: "#0A1825",
      textSecondary: "#6B7280",
      borderPrimary: "#E5E7EB",
      backgroundPrimary: "#FFFFFF",
      danger: "#DC2626",
    },
  },
};

const language = () => (typeof navigator !== "undefined" && navigator.language) || "en-US";
const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

function Pill({ check }: { check: Check }) {
  const label = check.state === "ok" ? "Ready" : check.state === "error" ? "Needs attention" : "To do";
  return <span className={`${styles.pill} ${styles[check.state]}`}>{label}</span>;
}

function CopyLine({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={styles.copyLine}>
      {label ? <span className={styles.copyLabel}>{label}</span> : null}
      <code className={styles.code}>{value}</code>
      <button
        type="button"
        className={styles.ghostButton}
        onClick={() => void navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function Step({ number, title, aside, children }: { number: number; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.number}>{number}</span>
        <h2 className={styles.h2}>{title}</h2>
        <span className={styles.spacer} />
        {aside}
      </div>
      <div className={styles.cardBody}>{children}</div>
    </section>
  );
}

function CheckRow({ name, check }: { name: string; check: Check }) {
  return (
    <li className={styles.checkRow}>
      <span className={`${styles.dot} ${styles[check.state]}`} aria-hidden />
      <span className={styles.checkName}>{name}</span>
      <span className={styles.muted}>{check.text}</span>
    </li>
  );
}

function Connect({ checks, jwks }: Pick<SetupProps, "checks" | "jwks">) {
  const state: Check = Object.values(checks).every((check) => check.state === "ok")
    ? { state: "ok", text: "" }
    : Object.values(checks).some((check) => check.state === "error") ? { state: "error", text: "" } : { state: "todo", text: "" };
  return (
    <Step number={1} title="Connect Bell to Crossmint" aside={<Pill check={state} />}>
      <ul className={styles.checks}>
        <CheckRow name="Checkouts" check={checks.server} />
        <CheckRow name="Card setup keys" check={checks.operator} />
        <CheckRow name="Bell's operator token" check={checks.token} />
      </ul>
      {jwks && checks.token.state !== "ok" ? (
        <div className={styles.callout}>
          <p className={styles.calloutTitle}>Let Crossmint verify Bell&apos;s token</p>
          <ol className={styles.ordered}>
            <li>In the Crossmint console, open the project, then Integrate, API Keys, JWT authentication.</li>
            <li>
              Choose <strong>Custom tokens</strong> and set the JWKS endpoint.
              <CopyLine label="JWKS endpoint" value={jwks.url} />
              {jwks.loopback ? (
                <span className={styles.muted}>
                  Crossmint cannot reach this address. Expose only this path over HTTPS, for example with a Cloudflare quick
                  tunnel, and paste the tunnel URL followed by /api/crossmint/jwks. A tunnel URL changes on every start, so
                  for a stable setup <a className={styles.link} href="/api/crossmint/jwks" download="jwks.json">download the public key
                  file</a> and host it at any HTTPS address you control. It holds only the public key.
                </span>
              ) : null}
            </li>
            <li>
              Set the issuer to the project id and the verifier id to sub.
              <CopyLine label="Issuer" value={jwks.issuer} />
            </li>
            <li>Save, reload the console page to confirm Custom tokens stayed selected, then reload this page.</li>
          </ol>
          <p className={styles.muted}>A project has one sign-in method, so give Bell a Crossmint project of its own.</p>
        </div>
      ) : null}
    </Step>
  );
}

function DeliveryDetails({ profile, profileError, configured, countryCode }: { profile?: ProfileView; profileError?: string; configured: boolean; countryCode?: string }) {
  const [saved, setSaved] = useState<{ id: string; profile: ProfileView }>();
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const shown = saved?.profile ?? profile;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError("");
    start(async () => {
      const result = await saveBuyerProfile({
        first: field(form, "first"),
        last: field(form, "last"),
        email: field(form, "email"),
        phone: field(form, "phone"),
        street: field(form, "street"),
        street2: field(form, "street2") || undefined,
        postalCode: field(form, "postalCode"),
        locality: field(form, "locality"),
        region: field(form, "region") || undefined,
        countryCode: field(form, "countryCode"),
      });
      if (result.ok) setSaved({ id: result.id, profile: result.profile });
      else setError(result.message);
    });
  }

  const pill: Check = shown ? { state: "ok", text: "" } : { state: "todo", text: "" };
  return (
    <Step number={2} title="Delivery details" aside={<Pill check={pill} />}>
      <p className={styles.lead}>
        Checkouts fill these in instead of asking you in chat, so names and addresses stay out of the conversation. No
        payment data is stored here.
      </p>
      {profileError ? <p className={styles.error}>{profileError}</p> : null}
      {shown ? (
        <div className={styles.summary}>
          <div>
            <p className={styles.summaryTitle}>{shown.name ?? "Saved delivery details"}</p>
            <p className={styles.muted}>
              {shown.place}, {shown.countryCode}
              {shown.email ? ` · ${shown.email}` : ""}
            </p>
          </div>
          {configured && !saved ? <span className={`${styles.pill} ${styles.ok}`}>In use</span> : null}
        </div>
      ) : null}
      {saved ? (
        <div className={styles.next}>
          <p>Add this line to .env.local and restart Bell:</p>
          <CopyLine value={`CROSSMINT_BUYER_PROFILE_ID=${saved.id}`} />
        </div>
      ) : null}
      {!shown ? (
        <form className={styles.form} onSubmit={submit}>
          <div className={styles.grid2}>
            <Input name="first" label="First name" autoComplete="given-name" required />
            <Input name="last" label="Last name" autoComplete="family-name" required />
            <Input name="email" label="Email" type="email" autoComplete="email" required />
            <Input name="phone" label="Phone, with country code" type="tel" autoComplete="tel" placeholder="+34 600 000 000" required />
          </div>
          <Input name="street" label="Street and number" autoComplete="address-line1" required />
          <Input name="street2" label="Floor, door (optional)" autoComplete="address-line2" />
          <div className={styles.grid4}>
            <Input name="postalCode" label="Postcode" autoComplete="postal-code" required />
            <Input name="locality" label="Town or city" autoComplete="address-level2" required />
            <Input name="region" label="Region code (optional)" placeholder="ES-M" />
            <Input name="countryCode" label="Country" defaultValue={countryCode ?? "US"} maxLength={2} required />
          </div>
          {error ? <p className={styles.error}>{error}</p> : null}
          <div className={styles.actions}>
            <button className={styles.primaryButton} disabled={pending}>{pending ? "Saving…" : "Save delivery details"}</button>
          </div>
        </form>
      ) : null}
    </Step>
  );
}

function Input({ label, name, ...rest }: { label: string; name: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={styles.label}>
      <span>{label}</span>
      <input className={styles.input} name={name} {...rest} />
    </label>
  );
}

// The card network's verification window, in Crossmint's colors.
const verificationAppearance = {
  variables: { borderRadius: "8px", colors: { accent: "#00C768", textPrimary: "#0A1825", textSecondary: "#6B7280", border: "#E5E7EB", success: "#00A846" } },
};

function BudgetRow({ budget, apiKey, onCancel }: { budget: Budget; apiKey?: string; onCancel: (id: string) => void }) {
  const router = useRouter();
  const [show, setShow] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState("");
  const live = budget.live;
  return (
    <>
      <tr className={styles.row}>
        <td>
          <span className={styles.strong}>{budget.merchantName ?? "Any merchant"}</span>
          {budget.merchantHost ? <span className={styles.muted}> · {budget.merchantHost}</span> : null}
        </td>
        <td className={styles.num}>
          {budget.available}
          {budget.total ? ` of ${budget.total}` : ""} {budget.currency}
        </td>
        <td>{new Date(budget.expiresAt).toLocaleDateString()}</td>
        <td>
          <div className={styles.chips}>
            {budget.rails.map((rail) => <span key={rail} className={styles.chip}>{rail}</span>)}
          </div>
        </td>
        <td className={styles.rowActions}>
          {budget.inUse ? <span className={`${styles.pill} ${styles.ok}`}>In use</span> : null}
          {!live ? <span className={`${styles.pill} ${styles.todo}`}>{budget.status}</span> : null}
          {live && budget.verify && apiKey ? (
            <button type="button" className={styles.ghostButton} onClick={() => { setVerifyError(""); setVerifying(true); }}>Verify card</button>
          ) : null}
          {live && !budget.inUse ? <button type="button" className={styles.ghostButton} onClick={() => setShow(!show)}>Use</button> : null}
          {live ? <button type="button" className={styles.dangerButton} onClick={() => onCancel(budget.id)}>Cancel</button> : null}
        </td>
      </tr>
      {verifying && budget.verify && apiKey ? (
        <tr>
          <td colSpan={5} className={styles.useRow}>
            Your card network asks you to confirm this budget, by code or passkey, before Bell can pay in its own browser.
            <CrossmintProvider apiKey={apiKey} consoleLogLevel="error">
              <OrderIntentVerification
                orderIntent={budget.verify as unknown as Parameters<typeof OrderIntentVerification>[0]["orderIntent"]}
                displayName="Bell"
                appearance={verificationAppearance}
                onVerificationComplete={() => { setVerifying(false); router.refresh(); }}
                onVerificationError={() => { setVerifying(false); setVerifyError("The card network did not confirm the budget. Try again."); }}
              />
            </CrossmintProvider>
          </td>
        </tr>
      ) : null}
      {verifyError ? (
        <tr>
          <td colSpan={5} className={styles.useRow}><span className={styles.errorText}>{verifyError}</span></td>
        </tr>
      ) : null}
      {show ? (
        <tr>
          <td colSpan={5} className={styles.useRow}>
            Add this line to .env.local and restart Bell:
            <CopyLine value={`CROSSMINT_ORDER_INTENT_ID=${budget.id}`} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

type Draft = Parameters<typeof approveBudget>[0];

function CardAndBudget({ apiKey, budgets, defaults, ready }: { apiKey?: string; budgets: Budget[]; defaults: SetupProps["defaults"]; ready: boolean }) {
  const router = useRouter();
  const [stage, setStage] = useState<"list" | "form" | "card" | "done">("list");
  const [draft, setDraft] = useState<Omit<Draft, "paymentMethodId">>();
  const [card, setCard] = useState<{ id: string; label: string }>();
  // One approval at a time; the draft's idempotency key covers retries that reach Crossmint.
  const approving = useRef(false);
  const [jwt, setJwt] = useState<string>();
  const [result, setResult] = useState<Budget>();
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  function toCard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError("");
    setDraft({
      amount: field(form, "amount"),
      currency: field(form, "currency"),
      days: Number(field(form, "days")),
      description: field(form, "description"),
      merchant: { name: field(form, "merchantName"), url: field(form, "merchantUrl"), countryCode: field(form, "merchantCountry") },
      consumer: { email: field(form, "email"), countryCode: field(form, "consumerCountry"), languageCode: language() },
      idempotencyKey: crypto.randomUUID(),
    });
    setCard(undefined);
    start(async () => {
      const token = await refreshToken();
      if (!token.ok) return setError(token.message);
      setJwt(token.jwt);
      setStage("card");
    });
  }

  function approve() {
    if (!draft || !card || approving.current) return;
    approving.current = true;
    setError("");
    start(async () => {
      try {
        const outcome = await approveBudget({ ...draft, paymentMethodId: card.id });
        if (!outcome.ok) return setError(outcome.message);
        setResult(outcome.budget);
        setStage("done");
        router.refresh();
      } finally {
        approving.current = false;
      }
    });
  }

  function cancel(id: string) {
    if (!window.confirm("Cancel this budget? Nothing more can be spent from it.")) return;
    start(async () => {
      const outcome = await cancelBudget(id);
      if (!outcome.ok) setError(outcome.message);
      router.refresh();
    });
  }

  const pill: Check = budgets.some((budget) => budget.inUse && budget.live)
    ? { state: "ok", text: "" }
    : { state: ready ? "todo" : "error", text: "" };
  return (
    <Step number={3} title="Card and budget" aside={<Pill check={pill} />}>
      <p className={styles.lead}>
        Approve how much Bell may spend, at which store, and until when. You still approve every payment in chat, and Bell
        checks it against this budget before paying.
      </p>
      {!ready ? <p className={styles.muted}>Connect Bell to Crossmint first.</p> : null}
      {ready && budgets.length ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr><th>Store</th><th>Left</th><th>Expires</th><th>Card rails</th><th /></tr>
            </thead>
            <tbody>{budgets.map((budget) => <BudgetRow key={budget.id} budget={budget} apiKey={apiKey} onCancel={cancel} />)}</tbody>
          </table>
        </div>
      ) : null}
      {error ? <p className={styles.error}>{error}</p> : null}

      {ready && stage === "list" ? (
        <div className={styles.actions}>
          <button type="button" className={styles.primaryButton} onClick={() => setStage("form")}>Approve a new budget</button>
        </div>
      ) : null}

      {stage === "form" ? (
        <form className={styles.form} onSubmit={toCard}>
          <div className={styles.grid3}>
            <Input name="amount" label="Amount" inputMode="decimal" placeholder="30.00" required />
            <Input name="currency" label="Currency" defaultValue="EUR" maxLength={3} required />
            <Input name="days" label="Valid for days" type="number" min={1} max={365} defaultValue={7} required />
          </div>
          <div className={styles.grid3}>
            <Input name="merchantName" label="Store" placeholder="Zara" required />
            <Input name="merchantUrl" label="Store URL" type="url" placeholder="https://www.zara.com" required />
            <Input name="merchantCountry" label="Store country" defaultValue={defaults.countryCode ?? "US"} maxLength={2} required />
          </div>
          <Input name="description" label="What it is for" placeholder="Accessories for the demo" required />
          <div className={styles.grid2}>
            <Input name="email" label="Your email, for the card network" type="email" defaultValue={defaults.email} required />
            <Input name="consumerCountry" label="Your country" defaultValue={defaults.countryCode ?? "US"} maxLength={2} required />
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.secondaryButton} onClick={() => setStage("list")}>Back</button>
            <button className={styles.primaryButton} disabled={pending}>{pending ? "Opening…" : "Continue to card"}</button>
          </div>
        </form>
      ) : null}

      {stage === "card" && apiKey && jwt && draft ? (
        <div className={styles.cardForm}>
          {!card ? (
            <>
              <p className={styles.muted}>
                Pick a saved card or add one. Card details go straight to Crossmint&apos;s vault and never reach Bell.
              </p>
              <CrossmintProvider apiKey={apiKey} consoleLogLevel="error">
                <CrossmintPaymentMethodManagement
                  jwt={jwt}
                  allowedModes={["existing", "new"]}
                  appearance={cardAppearance}
                  onPaymentMethodSelected={(method) => {
                    if ("paymentMethodId" in method && method.type === "card") {
                      setError("");
                      setCard({ id: method.paymentMethodId, label: `${method.card.brand} ending ${method.card.last4}` });
                    } else setError("Choose a card. Bank accounts cannot back a budget.");
                  }}
                />
              </CrossmintProvider>
            </>
          ) : (
            <div className={styles.summary}>
              <div>
                <p className={styles.summaryTitle}>
                  Approve {draft.amount} {draft.currency.toUpperCase()} at {draft.merchant.name} for {String(draft.days)} days?
                </p>
                <p className={styles.muted}>On your {card.label}. You still approve every payment in chat.</p>
              </div>
              <button type="button" className={styles.primaryButton} disabled={pending} onClick={approve}>
                {pending ? "Approving…" : "Approve budget"}
              </button>
            </div>
          )}
          <div className={styles.actions}>
            <button type="button" className={styles.secondaryButton} disabled={pending} onClick={() => (card ? setCard(undefined) : setStage("form"))}>
              {card ? "Choose another card" : "Back"}
            </button>
          </div>
        </div>
      ) : null}

      {stage === "done" && result ? (
        <div className={styles.success}>
          <p className={styles.summaryTitle}>
            Budget approved: {result.available} {result.currency}
            {result.merchantName ? ` at ${result.merchantName}` : ""} until {new Date(result.expiresAt).toLocaleDateString()}
          </p>
          <p className={styles.muted}>
            {result.networkRail
              ? "The card has a Visa or Mastercard agent rail, so Bell can also pay in its own browser."
              : result.verify
                ? "Crossmint checkouts can pay with it now. To let Bell also pay in its own browser, use Verify card in the list above."
                : "Crossmint checkouts pay this card through Crossmint's encrypted card, so no network rail is needed."}
          </p>
          <p>Add this line to .env.local and restart Bell:</p>
          <CopyLine value={`CROSSMINT_ORDER_INTENT_ID=${result.id}`} />
          <div className={styles.actions}>
            <button type="button" className={styles.secondaryButton} onClick={() => setStage("list")}>Done</button>
          </div>
        </div>
      ) : null}
    </Step>
  );
}

export default function Setup(props: SetupProps) {
  const ready = props.checks.token.state === "ok" && Boolean(props.apiKey);
  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.top}>
          <Image src={logo} alt="Crossmint" height={22} priority />
          <span className={styles.divider} />
          <span className={styles.product}>Bell</span>
          <span className={styles.spacer} />
          <span className={styles.operator}>Operator</span>
        </header>
        <div className={styles.hero}>
          <h1 className={styles.h1}>Payments setup</h1>
          <p className={styles.heroText}>
            Let Bell buy at any store with your own card. Crossmint runs the checkout, and you approve every payment in chat.
          </p>
        </div>
        <Connect checks={props.checks} jwks={props.jwks} />
        <DeliveryDetails profile={props.profile} profileError={props.profileError} configured={props.configured.profile} countryCode={props.defaults.countryCode} />
        <CardAndBudget apiKey={props.apiKey} budgets={props.budgets} defaults={props.defaults} ready={ready} />
        <p className={styles.footer}>Restart Bell after changing .env.local. This page signs in to Crossmint for ten minutes; reload it to continue.</p>
      </div>
    </div>
  );
}
