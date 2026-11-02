# Crossmint Agent Checkouts

Bell's `crossmint_checkout` and `crossmint_pay` tools buy through
[Crossmint Agent Checkouts](https://docs.crossmint.com/agents/checkouts/overview), part of the
Agent Commerce Toolkit. It works at any store. One call carries a product URL, a sentence, and a
spending cap. Crossmint picks the fastest path for that store, the merchant API, an agent protocol,
or its own checkout browser, and returns a run with status snapshots. The person pays with their own
card, at stores worldwide. The card number never reaches Bell or the model.

```text
Bell -> create run (URL, task, cap) -> Crossmint works through the store's checkout
     -> running (progress)          -> Bell tells the person what Crossmint is doing
     -> awaiting_input (form)       -> Bell answers from the conversation
     -> awaiting_input (payment)    -> Eve asks the person to approve the exact total
                                    -> server checks total, currency, merchant, cap -> pays
     -> succeeded (receipt)         -> Bell reports the order
```

The checkout runs in Crossmint's service, not in this conversation's browser, so it needs no
Browserbase plan and works the same with Bell's local browser. Nothing in the Link integration, the
browser runtime, or the hooks changes. With the Crossmint variables unset, both tools answer
`not_configured`. To keep the checkout in this conversation's browser and pay with a one-time card
instead, see [Agent Cards in Bell's browser](#agent-cards-in-bells-browser).

## Configure

Set these server-only values in Bell's ignored `.env.local`:

```dotenv
CROSSMINT_SERVER_API_KEY=<production server key, sk_production_...>
CROSSMINT_USER_ID=<stable id for the single trusted operator>
# Optional. Ceiling for any single checkout's cap, "amount currency".
CROSSMINT_MAX_COST=50.00 EUR
# Optional. Exact HTTPS origins a checkout may start from. Empty allows any store.
CROSSMINT_ALLOWED_MERCHANTS=https://shop.example
# Written by the setup page below.
CROSSMINT_BUYER_PROFILE_ID=
CROSSMINT_ORDER_INTENT_ID=
```

Create the key in the [Crossmint console](https://www.crossmint.com/console) with the
`agent-checkouts.create`, `agent-checkouts.read`, `agent-checkouts.update`, and
`agent-checkouts.cancel` scopes, plus `agent-checkouts.buyer-profiles.create` and
`agent-checkouts.buyer-profiles.read` for the setup page. Agent Checkouts runs in production only,
so a staging key answers `unauthorized`. A client key (`ck_`) is rejected at startup.

`CROSSMINT_USER_ID` identifies the buyer to Crossmint. Bell serves one trusted operator, so a fixed
value is enough. Every run, buyer profile, order intent, and receipt is scoped to it.

`CROSSMINT_MAX_COST` and `CROSSMINT_ALLOWED_MERCHANTS` are checked before a run exists, so a refused
request is never billed. They bound what a prompt can ask for. The order intent bounds what can be
paid.

Restart Bell after changing these values. No database or migration is involved.

## Set up payments in Bell

Two things make checkouts pay without questions: saved delivery details (a buyer profile) and an
approved budget on the person's card (an order intent). Bell's operator page at
`/crossmint/setup` sets up both. It asks for `BELL_OPERATOR_USERNAME` and `BELL_OPERATOR_PASSWORD`,
also when Bell runs locally.

Approving a budget is a call Crossmint accepts only for a signed-in user: a client key together with
that user's JWT, never a server key. Bell serves one operator, so it signs that JWT itself: RS256,
issuer the project id, subject `CROSSMINT_USER_ID`, audience `crossmint.com`, valid ten minutes.
Crossmint checks it against the public key Bell serves at `/api/crossmint/jwks`. Add to `.env.local`:

```dotenv
# Client key (ck_) with the payment-methods.* and order-intents.* scopes. BELL_PUBLIC_URL must be an allowed origin.
CROSSMINT_CLIENT_API_KEY=
# The Crossmint project id. Bell's operator token carries it as the issuer.
CROSSMINT_PROJECT_ID=
# Base64-encoded PEM RSA private key, 2048 bits or more, that signs the operator token.
CROSSMINT_JWT_PRIVATE_KEY=
```

Generate the private key once and keep it stable across restarts:

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 | base64 | tr -d '\n'
```

Then open `/crossmint/setup`. It checks each step live and says what is missing:

1. **Connect Bell to Crossmint.** The page lists Crossmint's budgets with Bell's token, which proves
   the whole chain. If Crossmint rejects the token, the page shows the two values to paste in the
   console under Integrate, API Keys, JWT authentication: choose Custom tokens, set the JWKS endpoint
   and the issuer, keep the verifier id `sub`, save, and reload the console page to confirm Custom
   tokens stayed selected. Crossmint fetches the JWKS endpoint over HTTPS. A deployed Bell serves it
   at `<BELL_PUBLIC_URL>/api/crossmint/jwks`. A Bell on your laptop needs that one path exposed, for
   example through a Cloudflare quick tunnel, whose URL changes on every start. For a stable setup,
   download the public key file from the page and host it at any HTTPS address you control; it holds
   only the public key. A project has one sign-in method, so give Bell a Crossmint project of its own.
2. **Delivery details.** Save the name, email, phone, and shipping address checkouts use instead of
   asking in chat. No payment data is stored. The page shows the `CROSSMINT_BUYER_PROFILE_ID` line
   to add.
3. **Card and budget.** Enter the amount, currency, how many days it lasts, and the store's name,
   HTTPS URL, and country. Then pick a saved card or add one in Crossmint's card form, whose fields
   go straight to Crossmint's vault, and confirm the budget on that card. Bell registers the card for
   order intents with your email, country, and language, which Crossmint requires and its card
   component does not send, and then approves the budget once: each draft carries its own
   idempotency key. The page lists every budget with what is left, its expiry, and its card
   rails, marks the one `CROSSMINT_ORDER_INTENT_ID` names, and cancels budgets you no longer need.

Agent Checkouts pays with any card Crossmint can save. A card without a Visa Intelligent Commerce or
Mastercard Agent Pay rail, such as a Visa issued outside the United States, is paid through
Crossmint's encrypted card inside its vault, so the budget's rail list can show no active card rail
and the checkout still pays.

Add both lines the page shows to `.env.local` and restart Bell.

## Try it in five minutes

This run needs only `CROSSMINT_SERVER_API_KEY` and `CROSSMINT_USER_ID`. Without a budget it reaches
the payment step and stops there, so nothing is bought. Pick a product under a few dollars at a store
that ships to you.

1. Start Bell with `pnpm dev` and open `http://127.0.0.1:4320`. Local development auth signs the web
   conversation in, which the payment step requires.
2. Send "Buy one of https://shop.example/products/sticker-pack with standard delivery, max 20 USD".
   Bell starts the run and, within seconds, says what Crossmint is doing. It posts a short line at
   each new stage, such as finding the product or filling in the delivery details.
3. Answer the questions Bell relays, such as a size or an email. With delivery details saved, most of
   them do not come up.
4. At the payment step Bell calls `crossmint_pay`. Eve pauses and shows "Pay 12.49 USD at Example
   Shop (shop.example) with your saved card?". Approve it. The server fetches the live request,
   checks it, finds no budget, and answers `payment_not_configured`.
5. Say "Cancel it". Bell cancels the run and the status becomes `cancelled`.

Crossmint bills each run that starts, including runs that end `blocked`. The first thousand runs a
month are free. The run appears in the Crossmint console under Agent Checkouts with the same id Bell
reports. To buy for real, approve a budget on the setup page, set `CROSSMINT_ORDER_INTENT_ID`, and
repeat the steps. The approval is the same. The server then pays, and `succeeded` with
`purchase.kind` `receipt_captured` carries `receipt.total` and `receipt.merchantOrderId`.

## Use

With `pnpm dev` running, in a web conversation or a Linq chat, give Bell the product URL, what to
buy, and the cap. Bell starts the run with `crossmint_checkout` and follows `requiredAction`.

While the run works, `start` returns within about twenty-five seconds and each `status` call returns
at the next new stage, at least fifteen seconds and at most a minute later. Bell tells you each new
stage in one short sentence and calls `status` again, so the conversation never sits on "Working"
for minutes.

When Crossmint asks a form question, Bell answers from what you said or asks you, then calls
`answer` with one value per field key. A choice field lists its option values. Fields marked
`protected`, such as one-time codes, passwords, and card data, cannot be answered through the model.
Bell declines or asks you to finish in Crossmint's hosted flow.

At the payment step Bell calls `crossmint_pay` with the amount, currency, merchant, and merchant name
copied from the request. Eve pauses and asks you to approve. Approving runs the tool and cancelling
does not. Only the authenticated sender who asked for the purchase can approve. A payment request for
a method other than a card, such as Klarna, is refused, because an order intent cannot pay it.

`succeeded` with `purchase.kind` `receipt_captured` is the only result Bell reports as a placed order.
`confirmed_without_receipt` and `nothing_placed` are reported as what they are. `blocked` carries a
code such as `merchant.payment_declined`, `policy.max_cost_exceeded`, or `product.item_unavailable`.
`failed` carries a reason such as `cost_limit` or `input_expired`. Bell reports these and does not
retry on its own. `cancel` stops a run that is still in progress. Keep the cap tight and do not start
a second run for the same request while one is unresolved.

## How payment is guarded

Approval in chat is not the control. Eve's tool approval is. `crossmint_pay` is declared with
`approval: always()`, so the runtime stops before executing it and shows the person the amount,
currency, and payee the model put in the call, in plain words such as "Pay 16.90 EUR at Zara
(payments.zara.com) with your saved card?". After approval the server fetches the live payment
request from Crossmint and compares it with the amount, currency, merchant, and store name and with
the cap the run started with. Any difference, an expired or replaced request, a method other than a card, a
`maximum` instead of an `exact` amount, or a run this conversation did not start refuses the payment
and answers the reason. The approval dialog shows the model's numbers. The cross-check makes sure
they are Crossmint's numbers.

Payments need an authenticated sender, which is a verified Linq number, the HTTP Basic operator, or
local development auth. The anonymous web demo can start and inspect runs but cannot pay, and the
approval response policy rejects anyone other than the principal who requested the call.

The setup page is for the operator only. A root proxy asks for the HTTP Basic credentials, refuses
cross-origin writes, and forbids other sites to frame the page. The page and every action check the
credentials and the origin again before signing a token or calling Crossmint. The browser receives
only the client key, and a ten-minute operator token when it opens Crossmint's card form.

## Transcript boundary

Only a projection of each snapshot reaches the model. That is the run id, status, revision, the open
question with its form fields or payment amount and merchant, the result summary with receipt
metadata, and, while the run works, its progress as a fixed stage phrase chosen from Crossmint's
activity kinds. Crossmint's own progress text is never passed on: it can name the buyer while the
delivery details are applied, and it is written while reading merchant pages. Browser
embed URLs, payment authorization links, the echoed input, provider error bodies, and any unexpected
field are dropped before Eve can persist them. The API key, buyer id, buyer profile, and order intent
id are read from the server environment inside the tools and never appear in tool arguments or
output. Nothing the setup page reads or saves reaches the model.

Runs are registered per conversation in process memory. After a restart or worker change an
unfinished run cannot be resumed from chat. Reconcile it in the Crossmint console before starting
another.

Crossmint's and the store's own records are outside Bell's control. Transcripts still contain the
store, items, totals, and form answers, so apply your host's retention policy.

## Verify

`pnpm check` runs mock provider tests. They pin request bodies and headers to the documented API,
prove no provider body leaks, exercise the merchant allowlist and the ceiling, project form fields
with their option values and protected handling, run the payment cross-check through every refusal
reason, including a store name that is not Crossmint's, cover polling with an answered request
skipped, the timeout and cancellation paths, progress stages without Crossmint's free text, the
minimum wait between updates and a cancellation during a progress read, per-conversation run
isolation, the approval wording, buyer profiles, and both tools up to `payment_not_configured`. The
setup tests cover the operator-only proxy with its framing headers, the page and actions refusing
missing credentials and other origins, the token the card form receives, the state when Crossmint
rejects the token, a missing setting, and a budget approval that registers the card with an email
and sends one idempotency key before creating the order intent. No test calls Crossmint.

For a live smoke test without Bell, start one run from the command line:

```sh
node scripts/demo-crossmint.mjs https://shop.example/products/sticker-pack 20.00 USD
```

The command loads `.env`, then `.env.local` when present. It starts the checkout with the key, buyer
id, and buyer profile, prints the run id, each status change and each new progress stage, and stops at
the first question or the first terminal state. It answers nothing, so nothing is bought, and it
prints no secrets. Cancel the run in the Crossmint console afterwards. Crossmint bills the run.

For the full flow, follow [Try it in five minutes](#try-it-in-five-minutes). Watch the run in the
Crossmint console and compare the receipt with the store's confirmation before trusting the flow for
anything larger.

References: [Agent Checkouts overview](https://docs.crossmint.com/agents/checkouts/overview),
[quickstart](https://docs.crossmint.com/agents/agent-checkouts-quickstart),
[follow a checkout](https://docs.crossmint.com/agents/checkouts/follow-run),
[pay for a checkout](https://docs.crossmint.com/agents/checkouts/payments),
[buyer profiles](https://docs.crossmint.com/agents/checkouts/configure),
[register a card](https://docs.crossmint.com/agents/payment-methods/cards/register-card),
[custom JWT authentication](https://docs.crossmint.com/introduction/platform/api-keys/custom-jwt-auth-guide),
[statuses and codes](https://docs.crossmint.com/agents/checkouts/statuses),
[API reference](https://docs.crossmint.com/api-reference/agent-checkouts).

## Agent Cards in Bell's browser

`crossmint_card_checkout` keeps the checkout in this conversation's browser and pays with a
[Crossmint agent card](https://docs.crossmint.com/agents/cards/overview). Bell drives the merchant
page with its usual tools and maps the card inputs with exact CSS selectors. The tool mints a
one-time card from the budget the person approved on the setup page and fills it on the server. The
card is the person's own, enrolled in Visa Intelligent Commerce or Mastercard Agent Pay, so rewards,
refunds, and chargeback rights work as for any purchase on it.

```text
Bell -> merchant checkout in Bell's browser -> card inputs mapped by CSS selector
     -> crossmint_card_checkout              -> Eve asks the person to approve the exact total
     -> server reads the order intent        -> status, merchant, currency, balance, expiry, rail
     -> one-time card, minted once           -> filled, pay pressed once, browser goes private
```

Mastercard credit and debit cards from any country work through Mastercard Agent Pay. U.S.-issued
Visa credit and debit cards work through Visa Intelligent Commerce, except business, prepaid, Chase,
and Fidelity cards. Any other card is refused with `no_card_rail`; Agent Checkouts above takes it.

### Configure

Agent Cards uses the Agent Checkouts settings and the setup keys above, and is off until you turn it
on: until then `crossmint_card_checkout` answers `not_configured`, and the database requirement below
does not apply. The setup keys alone only approve budgets for Agent Checkouts. The browser lock that
makes card entry safe needs `LINK_SANDBOX=0` and `DATABASE_URL`; without the lock, Bell refuses before
any card is issued.

```dotenv
# Turn on paying in Bell's own browser with a one-time card.
CROSSMINT_CARD_CHECKOUT=1
# Optional. Exact payment-frame origins per merchant origin, as a JSON object.
CROSSMINT_CHECKOUT_ORIGINS={}
DATABASE_URL=
```

The card path needs PostgreSQL. With `DATABASE_URL` exported, apply the browser privacy table:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/003_link_checkout.sql
```

Once card numbers have been typed into a browser, Bell records that conversation's browser there
and refuses every later browser tool on it. With Agent Cards on, every browser tool needs the
database.

`CROSSMINT_CHECKOUT_ORIGINS` maps a merchant origin to the origins of its payment frames, such as a
payment provider's card iframe, for example `{"https://shop.example":["https://pay.example"]}`. Bell
fills inputs only on the merchant origin and on those frames.

### Set up the card

Approve a budget on `/crossmint/setup` as described in
[Set up payments in Bell](#set-up-payments-in-bell). For this path the budget must name the merchant,
and its Visa Intelligent Commerce or Mastercard Agent Pay rail must be verified. With
`CROSSMINT_CARD_CHECKOUT=1`, a budget whose rail is still pending shows a Verify card button: Visa
sends a one-time code and asks for a passkey, and Mastercard opens a hosted page. The page reloads
once the network confirms, and the rail reads `active`.

See [saving a card](https://docs.crossmint.com/agents/payment-methods/cards/save-card),
[registering it](https://docs.crossmint.com/agents/payment-methods/cards/register-card), and
[creating an order intent](https://docs.crossmint.com/agents/payment-methods/cards/create-agent-card).

### Use

At the merchant's payment step Bell calls `crossmint_card_checkout` with the total, the currency,
the checkout page's URL or host, and exact CSS selectors for the card number, the CVC, and the
expiry, either as `expiry` (MM/YY) or as `exp_month` (MM) and `exp_year` (YYYY), plus the pay
button. A target inside an iframe adds a `frame` selector. Billing address inputs are not accepted.
Bell fills those with its usual tools before the call, because the one-time card carries no
address.

Eve pauses and shows "Pay 12.49 EUR at shop.example with your Crossmint agent card?". Approving
runs the tool once. Only the authenticated sender who asked can approve.

The tool answers `submission_attempted`, `merchant_confirmation_observed`, or `outcome_unknown`.
None of them proves payment. The browser is private after the card is entered, so the person checks
the order through human handoff. Bell does not retry an uncertain purchase. A refusal answers
`error` with a reason, such as `merchant_mismatch`, `insufficient_allowance`,
`rail_pending_verification`, or `cvc_recollection_required`, and says what the person has to do.

### How payment is guarded

`crossmint_card_checkout` is declared with `approval: always()`, so the runtime stops before
executing it and shows the person the amount, currency, and merchant the model put in the call.
After approval, and before anything is minted, the server checks:

- `CROSSMINT_ALLOWED_MERCHANTS` and `CROSSMINT_MAX_COST` from the Agent Checkouts settings.
- The order intent is active and expires more than a minute from now.
- It names this merchant, by host.
- Its currency is this payment's currency, and what is left on it covers the amount.
- Its Visa Intelligent Commerce or Mastercard Agent Pay rail is active for card numbers.
- On the merchant page, every mapped input and the pay button match exactly once, on the merchant
  origin or a configured payment frame.

Any difference refuses the payment with its own reason. Only then does the server mint. A mint
spends its amount at once, even if the card is never used. It carries an idempotency key derived
from the conversation and the tool call, so a repeat of the same call never issues a second card.
Crossmint answers `credential_already_issued` instead. The card network enforces the amount and the
merchant on the one-time card as well.

The card is read inside the fill and never returned. Bell types it into the mapped inputs, presses
pay once, clears the inputs it can still reach, and marks the browser private. Merchant scripts may
keep their own copy of what was typed.

The `network-token` format and the `encrypted-card` rail are out of scope here: a network token
needs a payment processor integration, and the encrypted card returns the real card number. Agent
Checkouts pays encrypted cards inside Crossmint's vault instead.

### Transcript boundary

The model sees its own tool input, which is the total, currency, merchant, and selectors, the fill
status, and refusal reasons. The order intent id, the operator token, the client key, Crossmint's
error messages, and the card are read on the server and never appear in tool arguments or output.

### Verify

`pnpm check` runs mock tests for the card path. They pin the order intent read, the mint request,
its headers, and its idempotency key to the documented API. They refuse with each pre-mint reason,
map Crossmint's error codes including the two 409 responses an operator must act on, project the
card into Bell's field mapping, prove the tool stays off without `CROSSMINT_CARD_CHECKOUT=1`, refuse
before any mint when the browser lock is not held, answer "do not retry" for any failure after a
mint, and check that no card value or Crossmint message reaches tool output. The setup tests prove the Verify
card step appears only with the card path on.

The staging smoke below needs a staging project with Bell's JWKS reachable over HTTPS,
`CROSSMINT_API_BASE_URL` set to `https://staging.crossmint.com/api/unstable`, and a `ck_staging_`
client key.

1. Save the [test card](https://docs.crossmint.com/agents/payment-methods/cards/test-agent-cards)
   `4242 4242 4242 4242` on the setup page, approve a 10.00 USD budget for
   `https://merchant.invalid`, and verify its Visa rail.
2. Export a token with `export TOKEN=$(pnpm -s crossmint:operator-jwt)` and the values from
   `.env.local`, then read the order intent. Expect the `agentic-token` rail `active` and
   `available` `10.00`:

   ```sh
   curl -s https://staging.crossmint.com/api/unstable/order-intents/$CROSSMINT_ORDER_INTENT_ID \
     -H "X-API-KEY: $CROSSMINT_CLIENT_API_KEY" -H "Authorization: Bearer $TOKEN" -H "Origin: $BELL_PUBLIC_URL" \
     | jq '{status, amount, rails}'
   ```

3. Mint 1.00 with an idempotency key, printing only metadata. Expect `agentic-token` and `1.00 USD`:

   ```sh
   curl -s -X POST https://staging.crossmint.com/api/unstable/order-intents/$CROSSMINT_ORDER_INTENT_ID/credentials \
     -H "X-API-KEY: $CROSSMINT_CLIENT_API_KEY" -H "Authorization: Bearer $TOKEN" -H "Origin: $BELL_PUBLIC_URL" \
     -H "Content-Type: application/json" -H "Idempotency-Key: bell-smoke-1" \
     -d '{"rail":"agentic-token","provider":"vic","amount":{"value":"1.00","currency":"USD"},"credential":{"format":"card"}}' \
     | jq '{rail, provider, amount, expiresAt}'
   ```

4. Repeat step 3 unchanged. Expect HTTP 409 with `ORDER_INTENT_CREDENTIAL_ALREADY_ISSUED`. Read the
   order intent again and expect `available` `9.00`, spent once.
5. Run the opt-in browser fill on the synthetic checkout page, which types a card of the same shape
   into a local Chrome and checks the safe status, the cleared inputs, and the quarantine:

   ```sh
   TEST_LINK_BROWSER=1 pnpm vitest run tests/link-checkout-browser.test.ts
   ```

Never run the smoke against a real merchant or with a production key.

References: [Agent Cards overview](https://docs.crossmint.com/agents/cards/overview),
[rails and PCI](https://docs.crossmint.com/agents/cards/rails-and-pci),
[Agent Cards quickstart](https://docs.crossmint.com/agents/cards-quickstart),
[get order intent](https://docs.crossmint.com/api-reference/agentic-commerce/order-intents/get-order-intent),
[create credentials](https://docs.crossmint.com/api-reference/agentic-commerce/order-intents/get-order-intent-credentials),
[verify the selected rail](https://docs.crossmint.com/agents/payment-methods/cards/create-agent-card).
