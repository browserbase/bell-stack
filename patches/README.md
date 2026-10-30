# Stagehand restart recovery

`@browserbasehq__stagehand@4.3.0.patch` adds a Bell-local, opt-in
`Stagehand.create({ replaceExistingInstance: true })` option. It is not an upstream SDK option.
Install with `pnpm install --frozen-lockfile`; pnpm verifies and applies the checked-in patch.

Stagehand 4.3.0 leaves its extension instance initialized when a worker exits without calling
`Stagehand.close()`. A new worker's initialization then fails, and Bell's existing fallback
replaces the browser, losing the page. Upstream previously supported reattachment in
[commit c0a2734](https://github.com/browserbase/stagehand/commit/c0a2734c46c1fb49e89705b186736cb11b5f78b7),
but the current runtime rejects a second initialization.

The patch uses the existing `stagehand.close` protocol operation to dispose the stale Stagehand
instance before initialization. That operation drains in-flight runtime requests and preserves
the browser connection, pages, and cookies. Both operations share the SDK's 60-second initialization
deadline. The option is removed before constructing protocol configuration and is rejected on
newly launched browser handles. Normal SDK creation is unchanged.

Bell enables this only when reconnecting its persisted browser. The previous controller must
have stopped; this does not implement leases or support overlapping owners of one browser.
No extension archive, dependency version, or additional package is changed. Review and remove
this patch when upstream provides supported equivalent behavior; do not carry it across an SDK
upgrade without rerunning the contract and cross-process tests.

```sh
BELL_LIVE_RESTART=1 pnpm test:browser:restart
```

The regression checks that default SDK initialization still rejects the existing instance,
explicit recovery retains the same hosted session and prepared page, the OTP action succeeds,
and the session and test-owned uploaded extension are removed afterward.
