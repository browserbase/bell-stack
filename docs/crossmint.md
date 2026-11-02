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
`not_configured`.

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
