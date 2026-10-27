# Text Bell through Photon

Configure Bell with a dedicated iMessage line from a Photon Stable cloud project.
Photon carries native iMessage — text, attachments, reactions, edits, unsends, stickers,
effects, groups, polls, mini-app cards, and shared locations — over a persistent Advanced
gRPC channel. [Link by Stripe wallet OAuth and checkout](link.md) use this channel's
verified sender identity and require separate configuration.

```text
Your phone -> Photon Stable cloud -> photon-worker (gRPC streams)
                                        | inbox + policy
                            POST /internal/photon/dispatch (Eve server, loopback only)
                                        |
                              Bell browser tools + Browserbase browser
                                        | Eve session event projection
Your phone <- Photon <- photon-worker outbox <- durable commands
```

One provider chat GUID keeps one Eve conversation and browser across follow-up messages.
The worker process owns provider connectivity; the Eve agent never talks to Photon and
never sees provider credentials. Browser, vault, and handoff tools run in the same agent
process as before. Baselayer credentials are not required for ordinary browsing.

## Components

- **`agent/channels/photon.ts`** — the Eve channel. Mounts `/internal/photon/*` routes on
  the Eve server only; the public Next surface never sees them (withEve proxies only
  `/eve/v1/**`). Routes authenticate every call with `BELL_PHOTON_INTERNAL_SECRET`.
- **`server/photon/worker.ts` + `scripts/photon-worker.ts`** — the transport worker.
  Maintains four unfiltered subscription streams (messages, chats, groups, polls),
  separate location watches, heartbeat/reconnect supervision, periodic catch-up replay,
  durable inbox/outbox, dispatch intents, projection, and the session-deadline sweep.
- **`scripts/run-bell.mjs`** — the supervisor (`pnpm start:bell`) that runs Next and the
  worker together and propagates signals.
- **PostgreSQL** — sources/leases, inbox, conversation bindings, dispatch intents,
  command outbox, resources, artifacts, pending interactions, projector offsets, and
  absolute session deadlines. Apply `migrations/004_photon.sql`.

## Configure the channel

Use a Photon Stable cloud project with a dedicated iMessage line (Advanced plan, gRPC).
Shared-line projects are rejected at startup.

1. In Bell's ignored `.env.local`, set these server-only values:

   ```dotenv
   BELL_PHOTON_ENABLED=true
   IMESSAGE_PROJECT_ID=<Stable cloud project id>
   IMESSAGE_PROJECT_SECRET=<Stable cloud project secret>
   BELL_PHOTON_PHONE_NUMBER=<dedicated line in E.164, e.g. +14155550123>
   BELL_PHOTON_ALLOWED_SENDERS=<your personal E.164 numbers, comma separated>
   BELL_PHOTON_INTERNAL_SECRET=<random secret, at least 32 bytes>
   BELL_PHOTON_INTERNAL_ORIGIN=<loopback Eve server origin, e.g. http://127.0.0.1:8787>
   DATABASE_URL=<PostgreSQL connection string>
   ```

   Optional: `BELL_PHOTON_ALLOWED_EMAIL_SENDERS` (iMessage email handles, empty = denied),
   `BELL_PHOTON_ALLOWED_GROUPS` (provider group chat GUIDs, empty = groups closed),
   `BELL_PUBLIC_URL` (handoff/OAuth callbacks), and the bounded worker tuning knobs in
   `.env.example`. Keep the existing OpenAI and Browserbase settings.

   Sender, email, and group allowlists are fail-closed: an empty list admits nobody.
   A dedicated number is verified against the project's managed instances at startup;
   the configured line is never silently substituted.

2. The gRPC address is derived from the token endpoint's per-instance map and used
   verbatim (`host:port`, TLS). Bell mints short-lived per-instance credentials from
   `POST {endpoint}/projects/{projectId}/imessage/tokens`; the project secret stays in
   the worker process and never reaches Eve, tools, or model context.

3. Internal origin: point `BELL_PHOTON_INTERNAL_ORIGIN` at the Eve server's direct
   address, not the Next app. `pnpm start:bell` binds the Eve build on loopback; the
   worker POSTs `/internal/photon/dispatch`, `/events`, and `/retire` there with the
   shared secret. A public proxy must never expose `/internal/*`.

4. For optional human handoff, set `BELL_PUBLIC_URL` and `BELL_HANDOFF_SECRET` as
   before. Handoff links still grant browser control; keep them private.

5. Apply the schema and start everything:

   ```sh
   psql "$DATABASE_URL" -f migrations/004_photon.sql
   pnpm build && pnpm start:bell
   ```

   The worker re-applies the migration idempotently on boot, so a fresh database works
   without the manual step.

## Identity and audience

Every inbound event maps to a verified principal:
`photon:` + sha256 of the canonical `["v1", project, handle kind, handle]` tuple.
Phone handles must normalize to E.164; email handles are lowercased. The receiving line
is excluded from the hash, so the same verified handle keeps one wallet owner across
line changes. Conversations bind to `(source, provider chat GUID, generation)` — never
derived from sender numbers.

Direct chats admit only `BELL_PHOTON_ALLOWED_SENDERS`/`BELL_PHOTON_ALLOWED_EMAIL_SENDERS`
handles. Group chats admit only allowlisted chat GUIDs; the first verified speaker owns
the session's browser and approvals for the life of the task. Group sessions never reach
personal Link wallets, 1Password vaults, reusable browser Contexts, or private handoff
links — sensitive work redirects to the private conversation. Link and 1Password approval
flows remain authoritative; reactions, polls, and messages cannot impersonate them.

## Demo from your phone

Text your configured Photon line from an allowed personal number:

1. "Open https://www.bestbuy.com and tell me the homepage title."
2. "Take a screenshot of that page."
3. "Tell me the current page URL without navigating again."

Bell replies in the same iMessage conversation and reuses its browser. Provider
acknowledgement means the cloud accepted the command; it is not proof a device rendered
the message — Bell reports receipts, failures, and ambiguous outcomes exactly.

## Rollout and rollback

Independent switches keep the rollout reversible:

- `BELL_PHOTON_ENABLED` — intake + worker + channel (off = channel absent, worker exits).
- Worker flags gate model dispatch and outbound mutations separately in code paths
  (`dispatchAction: "none"` is state-only; the outbox can be drained before pausing).
- Safe intake stays durable while dispatch/mutations are disabled: captured events and
  queued commands persist in PostgreSQL and resume after re-enable.

## Verification boundary

`pnpm test` exercises normalization, admission policy, dispatch/outbox state machines,
media bounds, interactions, group isolation, lifecycle deadlines, and recovery against
fixtures and stubbed seams — no provider traffic, no model, no browser. Live delivery
requires real Photon credentials, the enrolled line, and designated test devices; see
[provider regression checks](provider-tests.md). For wallet access, follow
[the Link guide](link.md).
