# Crossmint Agent Checkouts

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

The checkout runs in Crossmint's service, not in this conversation's browser. Nothing in the Link
integration, the browser runtime, or the hooks changes. With the Crossmint variables unset, both
tools answer `not_configured`.

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
value is enough. Every run, order intent, and receipt is scoped to it.

`CROSSMINT_ORDER_INTENT_ID` is the budget the person approved in Crossmint beforehand. It names a
saved card, an amount, a merchant scope, and an expiry. The card can be a Crossmint agent card, a card
on file, or an agent card from another provider. The
[cards quickstart](https://docs.crossmint.com/agents/cards-quickstart) walks through saving a card
and approving an order intent. Only the pay path on the server reads this id. Without it, checkouts
run up to the payment step and `crossmint_pay` answers `payment_not_configured`.

`CROSSMINT_MAX_COST` and `CROSSMINT_ALLOWED_MERCHANTS` are checked before a run exists, so a refused
request is never billed. They bound what a prompt can ask for. The order intent bounds what can be
paid.

Restart Bell after changing these values. No database, migration, or browser setting is involved.

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
