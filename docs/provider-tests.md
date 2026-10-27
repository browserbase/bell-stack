# Provider regression checks

Run `pnpm check` for the normal credential-free checks. Live provider tests are
opt-in and use real service resources. Keep credentials in ignored environment files.
Browserbase must use `verified: true` and managed proxies, including after launch retries.

## 1Password login and OTP

Use a dedicated test vault with a Login item titled exactly
`Bell integration test (authenticationtest.com)`. Give it the website
`https://authenticationtest.com` and the public test username, password, and OTP seed shown
on [the test site's TOTP challenge](https://authenticationtest.com/totpChallenge/).
Do not point the test at a personal or production login.

Configure `BROWSERBASE_API_KEY` and either `OP_SERVICE_ACCOUNT_TOKEN` or desktop integration
through `OP_ACCOUNT`. From the repository root:

```sh
BELL_LIVE_ONEPASSWORD=1 STAGEHAND_BROWSER=browserbase \
  node --env-file-if-exists=.env --env-file-if-exists=.env.local \
  node_modules/vitest/vitest.mjs run tests/browser/onepassword-login-real.test.ts
```

The test resolves the OTP after navigation, submits the dedicated test login, checks the
success page, and asserts that the returned result and traces omit the credentials.
Without the dedicated fixture, report this check as unverified even if vault listing works.

## Saved Browserbase Context

With the Browserbase environment loaded, run:

```sh
BELL_LIVE_CONTEXT=1 STAGEHAND_BROWSER=browserbase pnpm exec vitest run tests/browser/context-save-real.test.ts
```

This writes a synthetic example.com cookie, releases the writer, starts a reader with the
same Context, and checks the restored cookie. It then releases both browsers and deletes the
temporary Context. Cleanup failures must fail the check rather than silently leaving resources.

## Photon channel (live provider)

Live Photon checks need the real `IMESSAGE_PROJECT_ID`/`IMESSAGE_PROJECT_SECRET`, an
enrolled dedicated line matching `BELL_PHOTON_PHONE_NUMBER`, a sender on
`BELL_PHOTON_ALLOWED_SENDERS` with a designated test device, PostgreSQL, and the worker
running against an isolated test World. With the environment loaded:

1. Start `pnpm start:bell` and confirm `GET $BELL_PHOTON_INTERNAL_ORIGIN/internal/photon/health`
   reports the worker alive with fresh stream beats.
2. From the test device, text the line: the event lands in `bell_photon_inbox`, dispatches
   to a new Eve session, and the reply appears through the outbox.
3. Send an edit, unsend, reaction, and sticker; confirm they persist as `state_only`
   projections and never start turns.
4. Kill the worker mid-send, restart it, and confirm catch-up replays the gap and the
   outbox does not double-send (provider receipts reconcile via `clientMessageId`).
5. Run a live group check only against a GUID in `BELL_PHOTON_ALLOWED_GROUPS` with the
   test membership enrolled.

Provider acknowledgement is not device rendering — record observed device behavior in
the release evidence, not just worker logs.
