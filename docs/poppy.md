# Poppy integration

Bell discovers a company's `/.well-known/poppy.json` and calls MCP tools the
provider explicitly marks read-only, excluding tools marked destructive. Protocol
support follows the installed
[Poppy SDK](https://github.com/datalayer/personal-agent-protocol).
Writes, purchases and OpenAPI execution are unsupported.

## Setup

Configure these values through your deployment's secret manager:

| Variable | Purpose |
| --- | --- |
| `BELL_POPPY_CLIENT_ID` | Public HTTPS metadata URL, normally `https://your-bell.example/poppy/agent.json` |
| `BELL_POPPY_PRIVATE_JWK` | Private P-256 ES256 JWK as JSON |
| `BELL_POPPY_ENCRYPTION_KEY` | Independent random 32-byte key, base64 encoded |
| `BELL_POPPY_STORE_PATH` | Durable, writable encrypted file; defaults to `.bell/poppy.enc.json` |
| `BELL_POPPY_JWKS_URI` | Optional public JWKS URL; defaults to `jwks.json` beside the metadata URL |

Generate an ES256 key using `jose`'s `generateKeyPair` and `exportJWK`; generate the
storage key using Node's `randomBytes(32).toString("base64")`. Import both privately
into the secret manager without printing them in logs or writing repository env
files. Keep the client ID, signing key and encryption key stable across restarts.

Bell serves public metadata at `/poppy/agent.json` and public keys at
`/poppy/jwks.json`. Make both reachable over HTTPS at the configured URLs, or host
matching metadata and public JWKS elsewhere. Missing or invalid identity configuration
returns 503. Some providers require registration of the exact client ID.

Run **one agent process with durable storage**; the encrypted file store does not
support concurrent replicas or ephemeral serverless storage. Back up the encrypted
file and its key together.

Connecting and disconnecting accounts require approval in Bell. Complete sign-in
on the provider's website, then return to the conversation. Disconnect before
changing scopes or reconnecting after interrupted credential updates.

## Limits

Use providers you trust with the requested data. Read-only annotations are provider
claims, not verified behavior. Authentication stays outside model context; Bell
filters literal echoes of credentials held for the current request, validates inputs
and advertised output schemas, and limits result size. Other provider data passes through,
including unknown or transformed secrets. Bell does not detect PII or prompt
injection.

## Verification

See [provider tests](provider-tests.md#poppy-demo-hotel-reads) for the live
conversation smoke test. Recheck provider compatibility after SDK upgrades.
