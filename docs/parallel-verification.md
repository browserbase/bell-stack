# Parallel verification record

Checkout: `bell-stack-parallel-89954b6`, branch `shriyatheunicorn/parallel-public-web`,
base `89954b6429ce65dbb0a15646f08a993427d732f4`. Changes are local and uncommitted.
No deployment, push, or pull request was created.

## October 29 rerun

The fresh production build and authenticated UI E2E passed, including both concurrent
conversations, interrupted-stream recovery, citations, browser handoff, and confirmed cleanup.
The runner now rejects configured credentials in conversation snapshots and rendered HTML.
The same-session restart regression passed in two separate processes with confirmed cleanup.
The full local fixture suite again passed 437 tests; typecheck, lint, and build passed.

The unused-code review found active callers for all new named exports and confirmed both
research tools in the compiled Eve manifest. The 667-file scan of tracked/non-ignored source,
client assets, and bundled server code found none of the three configured service keys in raw,
URL-encoded, or base64 form. Two private-key-pattern matches were dependency parser markers,
not key material. The fresh dependency audit reported zero known advisories. `.env.local`
remains ignored and mode 600. No production code changed during this rerun.

Initial sandbox runs were unable to access local sockets, Chrome, or Browserbase; the enabled
runs passed. The first new credential assertion falsely classified `ONEPASSWORD_ENABLED=false`
as a secret. Credential-variable selection was corrected before the final successful UI run.

## Failure coverage

The new regressions reproduced and fixed two production issues: cancellation could leave a
stalled Parallel response reader pending, and canceled browser startup could continue launching,
initializing Stagehand, or retrying. Reader cancellation now releases the lock; startup checks
cancellation after asynchronous boundaries and releases late sessions before settling.

The normal suite covers disconnected/truncated JSON, stalled reads, timeout/abort propagation,
401/403/429/500/502/503/504 responses without automatic research retries, response/input budgets,
isolated concurrent research, and cancellation during Context allocation or browser launch.
Existing cleanup regressions retain the hosted session ID when release fails so cleanup can retry.

The automated production-build browser run passed on October 29
in San Francisco. Both concurrent UI conversations returned cited research and completed the
browser handoff. A synthetic interruption of one live response stream recovered within six
stream requests without repeated tool calls. Missing/invalid operator credentials returned 401;
an authenticated cross-origin write returned 403. UI retirement released both hosted sessions
before fallback cleanup, and deletion of both disposable Contexts was confirmed. Evidence is in
`.bell/parallel-e2e/8df88b57-f5f9-4aa9-8136-8ca22cabd9d0/` in this checkout, rerun after the
restart patch and fresh production build.

The security review reproduced Playwright route overrides forwarding synthetic authorization
across redirects. The runner now pauses every request and redirect through CDP, authenticates
only the exact configured origin, blocks other origins, and disables service workers. A Chrome
regression confirms the intended server receives the credentials and the redirect target is never
contacted. This change affects the test runner, not Bell's production authentication.

## The original 60 skips

| Test file | Original skips | Executed result |
| --- | ---: | --- |
| `tests/browser-privacy-lock.test.ts` | 3 | Passed with disposable PostgreSQL |
| `tests/link-oauth.test.ts` | 24 | Passed with disposable PostgreSQL |
| `tests/onepassword-integration.test.ts` | 16 | Passed with disposable PostgreSQL |
| `tests/link-checkout-browser.test.ts` | 7 | Passed with Chrome and synthetic checkout |
| `tests/onepassword-browser.test.ts` | 3 | Passed with Chrome and synthetic extension |
| `tests/browser/captcha-live.test.ts` | 1 | Passed with hosted synthetic CAPTCHA events |
| `tests/browser/context-save-real.test.ts` | 1 | Passed with hosted synthetic cookie persistence |
| `tests/browser/proxy-location-real.test.ts` | 1 | Passed with hosted proxy configuration |
| `tests/browser/browser-restart-real.test.ts` | 2 | Prepare and cross-process resume passed after the pinned SDK patch |
| `tests/browser/onepassword-login-real.test.ts` | 1 | Not run: dedicated vault credentials/fixture unavailable |
| `tests/browser/recaptcha-real.test.ts` | 1 | Not run: real Google CAPTCHA solving is outside this research integration |
| **Total** | **60** | **58 passed, 0 failed, 2 not run** |

The final combined normal/fixture run passed **437 tests**, with **7 opt-in hosted tests skipped**.
Those seven are accounted for separately above. Across all distinct
Vitest cases: **442 passed, 0 failed, 2 not run (444 total)**. This aggregate includes the Context,
CAPTCHA-marker, and proxy hosted fixtures last run October 28; those three were not repeated on
October 29. Type checking, unused-local/parameter
checks, lint, and the production build pass. Live UI E2E is a separate script, not a Vitest case.
`pnpm audit --json` reports zero known advisories in the locked dependency tree. Dependency
versions are unchanged. The manifest and lockfile pin a small Stagehand recovery patch; no packages
were added. The three configured
service-key values were absent from the changed source and client build assets, and the Parallel
endpoint/key name was absent from client assets. These scans do not detect arbitrary unknown secrets.

## Restart failure resolved

Three live attempts reproduced the original cross-process restart failure.
The original session was still running before resume. Stagehand 4.3.0 rejected creation against
the retained initialized extension with `A Stagehand instance is already initialized`; Bell then
released it and created a replacement, losing the prepared page. Bell now uses a version-pinned,
opt-in SDK patch to dispose only the stale Stagehand instance before initialization. The existing
runtime operation preserves the browser and shares the initialization deadline. Default SDK
behavior remains unchanged. See the [patch contract and maintenance requirements](../patches/README.md).

Three cross-process runs now pass. The strengthened regression confirms the original session ID,
prepared page, and successful OTP submission without closing Stagehand in the first process.
The final run additionally checks the default SDK guard and rejects the recovery option on a
fresh launch. Session release and deletion of the test-owned extension are confirmed. Evidence:
`.bell/restart-e2e/8a014c46-e779-45b0-b695-c9c43b941e46/result.json`.

## Outstanding release gate

**Hosted staging is not certified.** A designated staging URL/project remains unconfirmed.
The authenticated production build was tested locally against real Parallel and Browserbase;
this does not verify deployed Eve routing, deployment protection, or the staging environment.
The staging-capable runner and required configuration are documented in [provider tests](provider-tests.md).

These checks do not establish zero defects or zero vulnerabilities. The CAPTCHA fixture is not
a real solve, synthetic checkout is not a payment, and the two-conversation test uses one trusted
operator rather than proving multi-tenant isolation. Research citations are checked for source
provenance, not independently fact-checked for semantic correctness.
