# Notion personal memory

Notion stores Bell's personal memory, notes, and activity history across conversations.
Eve runs the agent, discovers Notion's MCP tools, and delivers OAuth consent through the
web or Linq conversation. The integration uses [Notion MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp)
with direct OAuth and supports Notion Free.

## Configure Notion

1. Provide PostgreSQL and set these server-only environment variables in Bell's ignored
   `.env.local` or deployment environment:

   ```dotenv
   DATABASE_URL=postgresql://<user>:<password>@<host>/<database>
   BELL_PUBLIC_URL=https://<bell-host>
   NOTION_ENABLED=true
   NOTION_TOKEN_ENCRYPTION_KEY=<base64 encryption key>
   ```

   Use a direct or session-pooled database connection. Transaction-mode poolers do not
   preserve the session advisory locks used for rotating refresh tokens. For local web
   development, `BELL_PUBLIC_URL` can be `http://127.0.0.1:4320`; a phone needs Bell's
   reachable HTTPS origin. Do not include a trailing slash.

   Generate the encryption key once with `openssl rand -base64 32`. Keep it stable across
   restarts and identical on every instance. Back it up separately from PostgreSQL.
2. From the repository root, with `DATABASE_URL` exported in your shell, apply the migration:

   ```sh
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/004_notion.sql
   ```

   Apply before connecting Notion. It is safe to rerun. PostgreSQL stores encrypted OAuth
   state; personal memories and notes remain in Notion.
3. Keep `<BELL_PUBLIC_URL>/api/notion/oauth/callback` and Eve's
   `/eve/v1/connections/.../callback/...` routes reachable without an interactive login wall.
   OAuth state and the framework callback capability protect these routes. Keep the existing
   web/session-control access restrictions, and exclude callback query strings from proxy logs.
4. Restart Bell and start a new conversation. Ask **"Connect my Notion account."** Open the
   private consent link, select your personal workspace, and return to the conversation.
   Bell registers the OAuth client automatically; no manually created Notion API token or
   client credentials are required.

Configuration and database connections load only when Notion is used. Keep
`NOTION_ENABLED=false` to leave the integration disabled.

## Use personal memory

Bell uses the [personal memory skill](../agent/skills/notion-memory/SKILL.md) to recall
preferences, routines, plans, decisions, notes, and prior activity before relevant tasks.
When connected to the chosen private destination, it saves useful context and verified
outcomes by default, updates existing records, and reads back writes before reporting success.

- **"Remember that I prefer aisle seats."** Save a preference in the existing memory destination.
- **"Which airline seat do I prefer?"** Recall it in a new conversation.
- **"I prefer window seats now."** Update the existing preference.
- **"Forget my seat preference."** Remove accessible copies within that scope and report any limits.

Bell reads Notion's MCP memory guidance and reuses the existing personal destinations and
schemas. If a destination is missing, it asks where to save. Creating a new database,
reorganizing content, sharing information, or scheduling work requires approval.

Detailed notes and activity records use the chosen Notion locations, with concise references
in memory when useful. Plans, attempted actions, and confirmed outcomes stay distinct.
Purchase records may include products, merchant, actual amount/currency, dates and status;
[Link's purchase guide](link.md#personal-purchase-history) covers that workflow.

The current request, corrections, exclusions, and forget requests take priority over old
notes. Credentials, payment tokens, private checkout fields, and raw transcripts are not
saved. Sensitive personal information needs an explicit memory request or consent.
Free-plan restrictions are reported rather than interpreted as empty results.

## Persistence and recovery

Bell is for one person. Limit the Linq sender allowlist to the operator's own phone numbers.
The web operator and each verified Linq identity authorize separately, as with Link. Choose
the same Notion account and destination to share personal memory across those conversations.
A grant cannot be selected through a model-supplied identity.

OAuth clients, tokens, PKCE verifiers, and pending callbacks are encrypted with AES-256-GCM
and bound to their owner. PostgreSQL session locks serialize refresh, reconnect, and disconnect
across workers. Lost single-use exchange/refresh responses require fresh consent rather than
retrying a possibly consumed credential. Old grants are revoked before replacement consent;
a changed public origin registers a client for the new callback.

Use `notion_status` to inspect the stored grant. A connected status does not verify remote
access or a saved memory. Use `notion_disconnect` to block access and revoke the grant.
If revocation fails, encrypted tokens remain for retry and access stays blocked. Retry
disconnect to finish. Notion content is unaffected.

Disabling the integration does not revoke or erase a stored grant. Disconnect before
disabling to revoke access too. If the encryption key is lost, revoke Bell in Notion and
remove the unreadable connection row before reconnecting.

Bell checks the stored grant before each remote tool call, including when Eve caches a
bearer within a step. Already dispatched requests may finish after disconnect. Schema changes
and deletions have runtime approval gates; ordinary writes use the user's Notion permissions
and memory instructions. If a write fails, Bell reports the unsaved record separately from
the original task outcome and does not repeat the action.

Memory is saved during conversations. There is no background account sync or guaranteed
logging after a process crash, and a saved deadline is not a scheduled reminder.

## Verify

`pnpm check` runs tests, TypeScript, lint, and the production build. Set
`TEST_NOTION_DATABASE_URL` to a disposable PostgreSQL database to include storage tests.
CI's `TEST_LINK_DATABASE_URL` is also supported. The suite creates and drops a unique
schema and never calls Notion or uses application credentials.

For a live check, connect Notion, save a test preference, and open its returned Notion link
to inspect the content. Start a new conversation and recall the preference, then correct
and forget it. Confirm each write by reading the result. This requires the configured
database, model credentials, and Notion consent; offline checks do not establish live recall.
