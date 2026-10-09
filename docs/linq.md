# Text Bell through Linq

Bell's assigned demo line is **+1 628-298-8686** (`+16282988686` in configuration).
Linq carries iMessage and SMS. Stripe Link checkout is a separate future integration.

```text
Your phone -> Linq -> Bell /eve/v1/linq -> Eve conversation
                                              |
                           shared Browsie tools + Browserbase browser
                                              |
Your phone <- Linq <- Bell's reply in the original chat
```

One Linq chat keeps one Eve conversation and browser across follow-up messages. It does not
automatically join an existing web chat. Browser, vault, and handoff tools run in the same agent
process. Baselayer credentials are not required for ordinary browsing.

## Configure the line

1. In Bell's ignored `.env.local`, set these server-only values:

   ```dotenv
   LINQ_API_KEY=<API token for the Linq account that owns the line>
   LINQ_WEBHOOK_SECRET=<signing secret from the webhook subscription>
   BELL_LINQ_PHONE_NUMBER=+16282988686
   BELL_LINQ_ALLOWED_SENDERS=<your personal phone number, starting with + and country code>
   ```

   Keep the existing OpenAI and Browserbase settings. The receiving line and your personal
   sending number are different settings. An empty or invalid sender list accepts nobody.
   For this single-operator demo, allow only the operator's numbers because saved vault and
   browser Context data are shared. Group chats and iMessage email handles are not supported
   by this phone-only policy. `BROWSIE_LINQ_ALLOWED_USER_IDS` configures Browsie, not Bell.

2. Run Bell on port **4320**, with a reachable HTTPS address for its webhook. Keep the web UI
   and other agent routes behind authentication. Allow direct Linq delivery to the exact webhook
   path, where Eve verifies the signing secret. A local relay should forward only this path;
   do not expose the entire development server. Browsie's `dev:linq` command starts Browsie on
   4318, so it does not launch this Bell app.

3. In the [Linq dashboard](https://dashboard.linqapp.com/api-tooling), create a webhook subscription:

   | Setting | Value |
   | --- | --- |
   | Target URL | `https://<your reachable Bell host>/eve/v1/linq?version=2026-02-03` |
   | Event | `message.received` |
   | Phone-number filter | `+16282988686` |

   Save the subscription's signing secret as `LINQ_WEBHOOK_SECRET`, then restart Bell. The target
   is the Bell application. Best Buy is the website Bell visits, so do not enter it as the webhook
   URL. The payload version supplies the receiving line and direct/group-chat fields Bell checks.
   Bell verifies these fields again even when the subscription has a phone-number filter.
   Replies use the inbound Linq chat and therefore the same receiving line.

   See Linq's [subscription API](https://docs.linqapp.com/channel/imessage/api/resources/webhook_subscriptions/methods/create/)
   and [signed webhook guide](https://docs.linqapp.com/channel/imessage/guides/webhooks/).

4. For optional human handoff, set `BROWSIE_PUBLIC_URL` to Bell's reachable origin and
   `BROWSIE_HANDOFF_SECRET` to a random secret of at least 32 characters. A localhost handoff
   link works only on the computer running Bell; a phone needs a reachable, authenticated host.

## Demo from your phone

Text the assigned line from an allowed personal number:

1. "Open https://www.bestbuy.com and tell me the homepage title."
2. "Take a screenshot of that page."
3. "Tell me the current page URL without navigating again."

Bell should visit the site in Browserbase and reply in the same Linq chat. Follow-ups reuse
that chat's browser. Report what the browser actually sees; merchant pages can vary by region
or present a challenge. This demo does not log in, add items to a cart, or purchase anything.

For a saved login, configure 1Password and ask Bell to use the vault tools for the saved website.
For an OTP or passkey, complete the step through the human handoff link, then text Bell to continue.
Do not send passwords or OTPs as chat messages. Desktop 1Password access requires Bell to run
on the same computer as the desktop app.

## Verification boundary

`pnpm test` sends signed HTTP requests through the installed Eve/Linq adapter and checks dispatch
to the agent. Provider calls and Eve dispatch are mocked, so the suite sends no texts and starts
no model or browser. It covers valid direct messages, same-chat routing, missing/tampered/stale
signatures, wrong lines or senders, groups, bot echoes, outbound messages, and invalid settings.

A live phone round trip also needs the actual Linq credentials, reachable webhook, allowed sender,
and Browserbase/OpenAI credentials. A local relay lasts only while its process and Bell are running.
Baselayer-protected merchant access and payment integrations are outside this PR.
