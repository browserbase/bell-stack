# Crossmint Agent Commerce Toolkit

Bell's `crossmint_checkout` and `crossmint_pay` tools buy through
[Crossmint Agent Checkouts](https://docs.crossmint.com/agents/checkouts/overview), part of the
Agent Commerce Toolkit. It works at any store. One call carries a product URL, a sentence, and a
spending cap. Crossmint picks the fastest path for that store, the merchant API, an agent protocol,
or its own checkout browser, and returns a run with status snapshots. The person pays with their own
card, at stores worldwide. The card number never reaches Bell or the model.

```text
Bell -> create run (URL, task, cap) -> Crossmint works through the store's checkout
     -> awaiting_input (form)       -> Bell answers from the conversation
     -> awaiting_input (payment)    -> Eve asks the person to approve the exact total
                                    -> server checks total, currency, merchant, cap -> pays
     -> succeeded (receipt)         -> Bell reports the order
```

The checkout runs in Crossmint's service, not in this conversation's browser. With the Crossmint
variables unset, both tools answer `not_configured`. To keep the checkout in this conversation's
browser and pay with a one-time card instead, see
[Agent Cards in Bell's browser](#agent-cards-in-bells-browser).

## Configure

Set these server-only values in Bell's ignored `.env.local`:

```dotenv
CROSSMINT_SERVER_API_KEY=<production server key, sk_production_...>
CROSSMINT_USER_ID=<stable id for the single trusted operator>
# Needed only to pay. The operator's approved order intent id.
CROSSMINT_ORDER_INTENT_ID=
# Optional. Saved buyer profile (name, email, shipping) so checkouts ask fewer questions.
CROSSMINT_BUYER_PROFILE_ID=
# Optional. Ceiling for any single checkout's cap, "amount currency".
CROSSMINT_MAX_COST=50.00 EUR
# Optional. Exact HTTPS origins a checkout may start from. Empty allows any store.
CROSSMINT_ALLOWED_MERCHANTS=https://shop.example
```

Create the key in the [Crossmint console](https://www.crossmint.com/console) with the
`agent-checkouts.create`, `agent-checkouts.read`, `agent-checkouts.update`, and
`agent-checkouts.cancel` scopes. Agent Checkouts runs in production only, so a staging key answers
`unauthorized`. A client key (`ck_`) is rejected at startup.

`CROSSMINT_USER_ID` identifies the buyer to Crossmint. Bell serves one trusted operator, so a fixed
value is enough. Every run, order intent, and receipt is scoped to it. The order intent must belong
to the user that `CROSSMINT_USER_ID` names, or minting fails.

`CROSSMINT_ORDER_INTENT_ID` is the budget the person approved in Crossmint beforehand. It names a
saved card, an amount, a merchant scope, and an expiry. The card can be a Crossmint agent card, a card
on file, or an agent card from another provider. The
[cards quickstart](https://docs.crossmint.com/agents/cards-quickstart) walks through saving a card
and approving an order intent. Only the pay path on the server reads this id. Without it, checkouts
run up to the payment step and `crossmint_pay` answers `payment_not_configured`.

`CROSSMINT_MAX_COST` and `CROSSMINT_ALLOWED_MERCHANTS` are checked before a run exists, so a refused
request is never billed. They bound what a prompt can ask for. The order intent bounds what can be
paid.

Restart Bell after changing these values. Agent Checkouts needs no database, migration, or browser
setting.

## Try it in five minutes

This run needs only `CROSSMINT_SERVER_API_KEY` and `CROSSMINT_USER_ID`. It reaches the payment step
and stops there, so nothing is bought. Pick a product under a few dollars at a store that ships to
you.

1. Start Bell with `pnpm dev` and open `http://127.0.0.1:4320`. Local development auth signs the web
   conversation in, which the payment step requires.
2. Send "Buy one of https://shop.example/products/sticker-pack with standard delivery, max 20 USD".
   Bell starts the run and waits up to ninety seconds for the next step.
3. Answer the questions Bell relays, such as a size or an email. With a buyer profile configured
   most of them do not come up.
4. At the payment step Bell calls `crossmint_pay`. Eve pauses and shows "Pay 12.49 USD to
   shop.example with your Crossmint order intent?". Approve it. The server fetches the live request,
   checks it, finds no order intent, and answers `payment_not_configured`.
5. Say "Cancel it". Bell cancels the run and the status becomes `cancelled`.

Crossmint bills each run that starts, including runs that end `blocked`. The first thousand runs a
month are free. The run appears in the Crossmint console under Agent Checkouts with the same id Bell
reports. To buy for real, set `CROSSMINT_ORDER_INTENT_ID` and repeat the steps. The approval is the
same. The server then pays, and `succeeded` with `purchase.kind` `receipt_captured` carries
`receipt.total` and `receipt.merchantOrderId`.

## Use

With `pnpm dev` running, in a web conversation or a Linq chat, give Bell the product URL, what to
buy, and the cap. Bell starts the run with `crossmint_checkout` and follows `requiredAction`.

When Crossmint asks a form question, Bell answers from what you said or asks you, then calls
`answer` with one value per field key. A choice field lists its option values. Fields marked
`protected`, such as one-time codes, passwords, and card data, cannot be answered through the model.
Bell declines or asks you to finish in Crossmint's hosted flow.

At the payment step Bell calls `crossmint_pay` with the amount, currency, and merchant copied from
the request. Eve pauses and asks you to approve. Approving runs the tool and cancelling does not.
Only the authenticated sender who asked for the purchase can approve. A payment request for a method
other than a card, such as Klarna, is refused, because an order intent cannot pay it.

`succeeded` with `purchase.kind` `receipt_captured` is the only result Bell reports as a placed order.
`confirmed_without_receipt` and `nothing_placed` are reported as what they are. `blocked` carries a
code such as `merchant.payment_declined`, `policy.max_cost_exceeded`, or `product.item_unavailable`.
`failed` carries a reason such as `cost_limit` or `input_expired`. Bell reports these and does not
retry on its own. `cancel` stops a run that is still in progress. Keep the cap tight and do not start
a second run for the same request while one is unresolved.

## How payment is guarded

Approval in chat is not the control. Eve's tool approval is. `crossmint_pay` is declared with
`approval: always()`, so the runtime stops before executing it and shows the person the amount,
currency, and merchant the model put in the call. After approval the server fetches the live payment
request from Crossmint and compares it with those three values and with the cap the run started
with. Any difference, an expired or replaced request, a method other than a card, a `maximum` instead
of an `exact` amount, or a run this conversation did not start refuses the payment and answers the
reason. The approval dialog shows the model's numbers. The cross-check makes sure they are
Crossmint's numbers.

Payments need an authenticated sender, which is a verified Linq number, the HTTP Basic operator, or
local development auth. The anonymous web demo can start and inspect runs but cannot pay, and the
approval response policy rejects anyone other than the principal who requested the call.

## Transcript boundary

Only a projection of each snapshot reaches the model. That is the run id, status, revision, the open
question with its form fields or payment amount and merchant, and the result summary with receipt
metadata. Browser embed URLs, payment authorization links, the echoed input, provider error bodies,
and any unexpected field are dropped before Eve can persist them. The API key, buyer id, buyer
profile, and order intent id are read from the server environment inside the tools and never appear
in tool arguments or output.

Runs are registered per conversation in process memory. After a restart or worker change an
unfinished run cannot be resumed from chat. Reconcile it in the Crossmint console before starting
another.

Crossmint's and the store's own records are outside Bell's control. Transcripts still contain the
store, items, totals, and form answers, so apply your host's retention policy.

## Verify

`pnpm check` runs mock provider tests. They pin request bodies and headers to the documented API,
prove no provider body leaks, exercise the merchant allowlist and the ceiling, project form fields
with their option values and protected handling, run the payment cross-check through every refusal
reason, cover polling with an answered request skipped, the timeout and cancellation paths,
per-conversation run isolation, and both tools up to `payment_not_configured`. No test calls
Crossmint.

For a live smoke test without Bell, start one run from the command line:

```sh
node scripts/demo-crossmint.mjs https://shop.example/products/sticker-pack 20.00 USD
```

The command loads `.env`, then `.env.local` when present. It starts the checkout with the key and
buyer id, prints the run id and each status change, and stops at the first question or the first
terminal state. It answers nothing, so nothing is bought, and it prints no secrets. Cancel the run in
the Crossmint console afterwards. Crossmint bills the run.

For the full flow, follow [Try it in five minutes](#try-it-in-five-minutes). Watch the run in the
Crossmint console and compare the receipt with the store's confirmation before trusting the flow for
anything larger.

References: [Agent Checkouts overview](https://docs.crossmint.com/agents/checkouts/overview),
[quickstart](https://docs.crossmint.com/agents/agent-checkouts-quickstart),
[pay for a checkout](https://docs.crossmint.com/agents/checkouts/payments),
[statuses and codes](https://docs.crossmint.com/agents/checkouts/statuses),
[API reference](https://docs.crossmint.com/api-reference/agent-checkouts).

## Agent Cards in Bell's browser

`crossmint_card_checkout` keeps the checkout in this conversation's Browserbase browser and pays with
a [Crossmint agent card](https://docs.crossmint.com/agents/cards/overview). Bell drives the merchant
page with its usual tools and maps the card inputs with exact CSS selectors. The tool mints a
one-time card from the order intent the person approved beforehand and fills it on the server. The
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

Agent Cards uses the Agent Checkouts settings above and adds these to `.env.local`:

```dotenv
# Client key (ck_) with the payment-methods.* and order-intents.* scopes. BELL_PUBLIC_URL must be an allowed origin.
CROSSMINT_CLIENT_API_KEY=
# The Crossmint project id. Bell's operator token carries it as the issuer.
CROSSMINT_PROJECT_ID=
# Base64-encoded PEM RSA private key, 2048 bits or more, that signs the operator token.
CROSSMINT_JWT_PRIVATE_KEY=
# Optional. Exact payment-frame origins per merchant origin, as a JSON object.
CROSSMINT_CHECKOUT_ORIGINS={}
DATABASE_URL=
```

Order intents accept a client key together with the user's JWT, not a server key. Bell serves one
operator, so it signs that JWT itself: RS256, issuer the project id, subject `CROSSMINT_USER_ID`,
audience `crossmint.com`, valid ten minutes. Crossmint checks the signature against the public key
Bell serves at `/api/crossmint/jwks`. Keep that path reachable over HTTPS without a login wall. It
serves only the public key. Every call carries the origin of `BELL_PUBLIC_URL`, which must be an
allowed origin of the client key.

Generate the private key once and keep it stable across restarts:

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 | base64 | tr -d '\n'
```

Register Bell as the project's custom JWT provider, with the
[Crossmint CLI](https://docs.crossmint.com/cli/projects/auth-provider) or the console's JWT
authentication settings:

```sh
crossmint projects auth-provider set --provider custom --jwks-uri https://<bell host>/api/crossmint/jwks --issuer <project id>
```

A project has one auth provider, so give Bell a Crossmint project of its own.

The card path needs PostgreSQL. With `DATABASE_URL` exported, apply the browser privacy table:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/003_link_checkout.sql
```

Once card numbers have been typed into a browser, Bell records that conversation's browser there
and refuses every later browser tool on it. With the card settings present, every browser tool
needs the database.

`CROSSMINT_CHECKOUT_ORIGINS` maps a merchant origin to the origins of its payment frames, such as a
payment provider's card iframe, for example `{"https://shop.example":["https://pay.example"]}`. Bell
fills inputs only on the merchant origin and on those frames.

### Set up the card

The person saves the card, registers it, and approves an order intent in Crossmint's card
components, signed in with Bell's operator token. Crossmint's
[Agent Cards reference app](https://github.com/Crossmint/card-permissions-quickstart) does this once
its sign-in is replaced with a token from:

```sh
pnpm crossmint:operator-jwt
```

The command prints a token valid for ten minutes. Treat it like a password until it expires. The
reference app's origin must also be an allowed origin of the client key.

Bell also serves the setup at `/crossmint/cards`, for the operator only: it asks for
`BELL_OPERATOR_USERNAME` and `BELL_OPERATOR_PASSWORD`, also when Bell runs locally. The page renders
Crossmint's `CrossmintAgentCardAuthorization` component, which selects or saves the card, registers
it, creates the order intent, and runs the rail verification, then shows the line to paste into
`.env.local`. The page pulls in Crossmint's React SDK, which carries wallet and chain dependencies
the card page does not use.

1. Save the card.
2. Register it for agent payments. Registration finds the card's network rail and grants nothing.
3. Create an order intent with an amount, an expiry, and the merchant's name, HTTPS URL, and
   country. Bell refuses an order intent that names no merchant.
4. Verify the card rail. Visa sends a one-time code and asks for a passkey. Mastercard opens a
   hosted page. Wait until the `agentic-token` rail reads `active`.
5. Set `CROSSMINT_ORDER_INTENT_ID` in `.env.local` to the order intent id and restart Bell.

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

The `network-token` format and the `encrypted-card` rail are out of scope: a network token needs a
payment processor integration, and the encrypted card returns the real card number.

### Transcript boundary

The model sees its own tool input, which is the total, currency, merchant, and selectors, the fill
status, and refusal reasons. The order intent id, the operator token, the client key, Crossmint's
error messages, and the card are read on the server and never appear in tool arguments or output.

### Verify

`pnpm check` runs mock tests for the card path. They pin the order intent read, the mint request,
its headers, and its idempotency key to the documented API. They refuse with each pre-mint reason,
map Crossmint's error codes including the two 409 responses an operator must act on, project the
card into Bell's field mapping, verify the operator token against the JWKS, and check that no card
value or Crossmint message reaches tool output. No test calls Crossmint.

The staging smoke below has not been run for this change. It needs a staging project with Bell's
JWKS reachable over HTTPS, through a tunnel when Bell runs locally, `CROSSMINT_API_BASE_URL` set to
`https://staging.crossmint.com/api/unstable`, and a `ck_staging_` client key.

1. Save the [test card](https://docs.crossmint.com/agents/payment-methods/cards/test-agent-cards)
   `4242 4242 4242 4242`, register it, approve a 10.00 USD order intent for
   `https://merchant.invalid`, and verify its Visa rail.
2. Export a token with `export TOKEN=$(pnpm -s crossmint:operator-jwt)` and the values from
   `.env.local`, then read the order intent. Expect the `agentic-token` rail `active` and
   `available` `10.00`:

   ```sh
   curl -s https://staging.crossmint.com/api/unstable/order-intents/$CROSSMINT_ORDER_INTENT_ID \
     -H "X-API-KEY: $CROSSMINT_CLIENT_API_KEY" -H "Authorization: Bearer $TOKEN" -H "Origin: $BELL_PUBLIC_URL" \
     | jq '{status, amount, rails}'
   ```

   The same call with `X-API-KEY: $CROSSMINT_SERVER_API_KEY` and no token should answer 401 or 403.
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
[custom JWT authentication](https://docs.crossmint.com/introduction/platform/api-keys/custom-jwt-auth-guide).
