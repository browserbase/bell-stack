# Provider regression checks

Run `pnpm check` for the normal credential-free checks. Live provider tests are
opt-in and use real service resources. Keep credentials in ignored environment files.
Browserbase must use `verified: true` and managed proxies, including after launch retries.

## Parallel research to browser

Keep `OPENAI_API_KEY`, `PARALLEL_API_KEY`, and `BROWSERBASE_API_KEY` in an ignored
`.env.local`. Install Chrome locally, or set `TEST_CHROME_PATH` to its executable.
Build and test both production services with one command:

```sh
BELL_LIVE_PARALLEL=1 pnpm test:parallel:production
```

The launcher starts the compiled Eve agent and Next production server on loopback with
temporary operator credentials, an isolated Context metadata store, and 1Password disabled.
It requires the built Eve rewrite port to be free and stops both owned services afterward.
`next start` alone does not start the separate Eve service in this checkout.

The Playwright test submits two concurrent conversations through the UI. Each must call
Search, Extract, run, and snapshot exactly once, cite evidence from both research tools, and
observe example.com's title in its own hosted browser and disposable Context. One UI response
stream is deliberately interrupted; recovery must preserve the answer, reconnect within six
stream requests, and avoid duplicated tool calls. The other conversation must remain healthy.
Conversation snapshots and rendered HTML must not contain configured server credentials.

The authenticated run rejects missing/invalid credentials and cross-origin writes. Clicking
**New conversation** must retire the old Eve session and release the hosted browser before
test cleanup intervenes. Cleanup then confirms temporary Context deletion. Screenshots and a
sanitized JSON report are saved under ignored `.bell/parallel-e2e/<run-id>/`. Failures, including
cleanup failures, exit nonzero. Normal `pnpm check` does not make these paid live calls.

To test an already running development instance, use `BELL_LIVE_PARALLEL=1 pnpm test:parallel:live`.
The default origin is `http://127.0.0.1:4320`; override with `BELL_TEST_ORIGIN`.

### Hosted staging

Use an explicitly designated, isolated staging deployment. Set its server environment to the
three service keys above, `BELL_OPERATOR_USERNAME`, and a `BELL_OPERATOR_PASSWORD` of at least
32 bytes. The runner needs the same operator credentials and a Browserbase key for the same
test project. Supply an existing deployment-protection bypass as `BELL_TEST_PROTECTION_BYPASS`
when required. Keep these values in a secret store or ignored environment file, not shell history.

Set `BELL_TEST_ORIGIN` and `BELL_TEST_STAGING_ORIGIN` to the exact same HTTPS origin, then run:

```sh
BELL_LIVE_PARALLEL=1 pnpm test:parallel:live
```

Credentials are attached only to that exact origin; cross-origin UI requests are blocked.
This checks an existing deployment and does not deploy, edit its environment, or disable its
protection. A loopback production-build pass does not certify hosted routing or configuration.
Build from source on the deployment platform; the local build includes native macOS dependencies.
See [the verification record](parallel-verification.md) for current results and outstanding gates.

## Isolated database and browser fixtures

Set `TEST_LINK_DATABASE_URL` and `TEST_ONEPASSWORD_DATABASE_URL` to a disposable PostgreSQL
database, never a production database. The suites create and remove their own fixture schemas.
With Chrome installed, the following enables the original 53 database/browser skips and the
new synthetic cross-origin credential-redirect regression alongside the normal suite:

```sh
BELL_TEST_LOCAL_CHROME=1 TEST_LINK_BROWSER=1 pnpm test
pnpm typecheck
pnpm lint
```

The database variables must be exported before running this command. These fixtures exercise
OAuth/storage/privacy and synthetic checkout/autofill behavior; they do not charge a card or
access a real vault. Provider outages, interrupted JSON bodies, stalled-reader cancellation,
and cancellation during hosted-browser startup run without credentials in the normal suite.

## Browser worker restart

Load `BROWSERBASE_API_KEY` from ignored `.env.local`, then run:

```sh
BELL_LIVE_RESTART=1 pnpm test:browser:restart
```

This prepares a synthetic OTP page, exits the first process without closing Stagehand, and
resumes from its saved session ID in a second process. It verifies the same browser and page,
the OTP action, default SDK behavior, and confirmed session/extension cleanup. Reports are
saved under ignored `.bell/restart-e2e/<run-id>/`. It does not use a real login or vault.
The pinned [SDK patch](../patches/README.md) is applied by `pnpm install --frozen-lockfile`.

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
