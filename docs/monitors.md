# Persistent public-web watches

Ask Bell through an allowlisted, direct Linq conversation to watch a public topic. Bell creates a daily Parallel `event_stream` monitor using `lite`, without historical backfill. `watch_list` shows the newest 50 watches and recent updates; `watch_stop` cancels a watch permanently. Use a precise query describing the material changes you care about. Do not include private browser content or secrets.

Parallel schedules the research. Bell stores ownership, events, and pending messages in PostgreSQL, then sends cited updates directly through Linq. Alerts do not use a model, Browserbase, or an Eve session, so the 24-hour session timeout does not end a watch. Existing search, browsing, and messaging still work without monitor configuration.

## Setup

Configure the existing `DATABASE_URL`, `PARALLEL_API_KEY`, `LINQ_API_KEY`, `LINQ_WEBHOOK_SECRET`, `BELL_LINQ_PHONE_NUMBER`, and `BELL_LINQ_ALLOWED_SENDERS`. Set `BELL_PUBLIC_URL` to your exact public HTTPS origin, with no trailing slash. The callback is `/api/parallel/monitors/webhook` and must be reachable by Parallel without interactive deployment authentication.

Copy `PARALLEL_WEBHOOK_SECRET` from **Settings > Webhooks** in the Parallel organization associated with your API key. Do not generate a different secret locally. Set `CRON_SECRET` to an independent random secret of at least 32 bytes. Keep all credentials server-side.

Apply the additive migration before deploying:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/004_parallel_monitors.sql
```

Monitor tables are independent of Link OAuth and can use the same database. Use a session-pooled connection. The worker uses bounded connection pools; delivery holds a watch row lock through the bounded Linq request to serialize with stopping. Other transactions are short; this does not make the rest of Bell's Eve workflow storage durable or multi-instance safe.

Configure a scheduler to call `/api/parallel/monitors/process` every minute. Both GET and POST require `Authorization: Bearer <CRON_SECRET>`. For Vercel, add this to your deployment's `vercel.json` and configure `CRON_SECRET` in the environment:

```json
{"crons":[{"path":"/api/parallel/monitors/process","schedule":"* * * * *"}]}
```

Vercel supplies the bearer header on its GET request. Hobby only supports daily cron jobs; minute-level delivery requires a suitable plan or an external scheduler making authenticated POST requests. Deploying the code alone does not activate processing. Verify successful scheduler invocations before creating a watch. The worker processes at most 30 jobs per invocation with a 20-second work-start budget, 8-second provider timeouts, and 60-second leases. The route allows 60 seconds for the final request and database cleanup.

The webhook verifies Standard Webhooks signatures and timestamp freshness, then commits the callback before acknowledging. The worker fetches the actual events from Parallel. The saved sender and receiving line must still match Bell's allowlist before each outgoing send. Recipients cannot be supplied through tool arguments or callback metadata.

## Status and recovery

`active` means Parallel creation was confirmed. `dispatched` or `uncertain` means a create request may have succeeded. Bell never resends an uncertain create request. It searches the account's monitors for the exact opaque watch ID in metadata, including cancelled monitors. A crash just before sending can also leave an uncertain operation; inspect it instead of automatically creating a replacement.

`watch_stop` records local suppression and queues remote cancellation. It can wait for an in-flight send; once stopping succeeds, no new alert is dispatched. If a lock wait times out, retry stopping. `cancel_pending` means remote cancellation is not yet confirmed, so billing may continue. Missing messaging/webhook configuration does not block stopping. Missing provider credentials leave cancellation pending until repaired. A message already being sent cannot be recalled. Removing a sender from the allowlist prevents sends but does not cancel their monitors; the operator must cancel them through Parallel or repair the local cancellation job.

Linq retries reuse a frozen message body and idempotency key. `accepted` records provider acceptance, not device delivery or human receipt. Never generate a new key to work around a send error, including a 404 for an expired/deleted idempotent message. Repeated event IDs are deduplicated; similar events with different IDs can still appear.

Callbacks are the primary delivery path. Hourly fallback scans recover missed events and health observations. Each scan starts at the newest page and deduplicates saved IDs. The inspected Parallel API returns a finite window of recent runs when completions are included. `recovery_gap` remains true when prior coverage cannot be found or the work budget is exceeded. It does not claim that all missed history can be recovered. Completion/error records update health without sending routine status messages. Event dates are detection/run dates, not necessarily the dates the underlying news occurred.

Inspect `watch_list` for health, last scan, recovery gaps, and failed jobs. On the server, inspect queue age and failures:

```sql
SELECT kind, count(*), min(created_at) AS oldest, bool_or(failed) AS has_failed
FROM bell_monitor_jobs GROUP BY kind;
SELECT id, watch_id, kind, attempts, last_error, failed
FROM bell_monitor_jobs WHERE last_error IS NOT NULL;
SELECT id, status, health, health_at, last_scan_at, recovery_gap
FROM bell_monitors WHERE status <> 'cancelled';
```

Transient jobs back off with jitter and stop after eight attempts. Provider authentication, validation, and other permanent failures stop sooner. Repair the underlying configuration or provider problem, then requeue only the inspected job, preserving its payload and key:

```sql
UPDATE bell_monitor_jobs SET failed=false, attempts=0, next_at=now(),
  lease_until=NULL, lease_token=NULL, last_error=NULL
WHERE id = '<inspected-job-id>' AND (lease_until IS NULL OR lease_until < now());
```

This retries reconciliation, event fetching, cancellation, or the same idempotent message. It never resets the watch's creation state. Resolve an uncertain watch by locating its `bell_watch_id` in Parallel; do not edit `remote_id` from unverified metadata. A failed cancellation remains pending until repaired. Keep the database backed up: deleting watch rows can orphan billed monitors, while deleting event records can allow duplicate alerts.

Provision alerts for failed/aging jobs and missing scheduler invocations in your deployment. `bell_monitor_job_failed` logs contain job kind and retry state without secrets or message contents. No Bell-specific hosted alert is provisioned by this sample. Retained events and callbacks grow over time; this version does not automatically prune deduplication history. Restrict database access and account for storage usage.

Before rollback, stop creating watches, suppress delivery, cancel owned monitors through Parallel, and confirm cancellation. Keep the database until uncertain creations and pending deliveries are resolved. Disabling the scheduler alone does not stop upstream billing.

Parallel account settings may save public monitor inputs/outputs to personal memory when enabled. This integration does not opt into application memory or retrieve memories. Review that account setting for your deployment.

## Local verification

Point `TEST_MONITOR_DATABASE_URL` at a disposable PostgreSQL database, then run:

```sh
pnpm exec vitest run tests/monitors.test.ts tests/monitor-http.test.ts tests/linq.test.ts
pnpm check
```

Database tests create isolated schemas and exercise concurrency, restart, uncertain creation, cancellation, and delivery retries. HTTP tests use signed fixtures and stub provider transports. These checks do not establish live Parallel or Linq delivery. Live delivery was intentionally not tested for this contribution.

[Parallel Monitor API](https://docs.parallel.ai/api-reference/monitor/create-monitor) · [Monitor events](https://docs.parallel.ai/monitor-api/monitor-events) · [Webhook setup](https://docs.parallel.ai/resources/webhook-setup) · [Vercel Cron](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
