# Poppy integration

Bell uses published SDKs to consume a company's `/.well-known/poppy.json` and call
its explicitly read-only MCP tools. The Poppy SDK handles discovery, protocol
versions, Session proofs, device authorization, resource-bound tokens, refresh and
revocation. The official MCP SDK handles MCP transport, negotiation and schemas.
Bell supplies its tools, authenticated user identity, approvals and encrypted storage.

## Dependencies and compatibility

- `@datalayer/personal-agent-protocol`: Poppy client and safe Node transport.
- `@modelcontextprotocol/client`: MCP client and schema validation.
- `@datalayer/reactor`: the Poppy SDK's host contribution interface.
- `jose`: loading and validating Bell's configured signing key.

Protocol support follows the installed SDK's published default. Version 0.35.0
supports Poppy 0.4 by default; Bell does not opt into draft 1.0 or translate older
versions. Providers still serving 0.3, including PrijsProfeet and PlanMyVisit, are
unsupported. Upgrading the dependency is how Bell gains protocol support; do not
add local wire formats, signing rules, OAuth flows or compatibility patches.

Bell exposes MCP reads only. Other advertised APIs can appear in discovery with
`supported: false`; OpenAPI execution, writes, purchases, browser handoff and
Conversations are outside this integration. The SDK implements more capabilities
than Bell exposes.

## Configure an identity

Configure these values through your deployment's secret manager:

| Variable | Purpose |
| --- | --- |
| `BELL_POPPY_CLIENT_ID` | Public HTTPS metadata URL, normally `https://your-bell.example/poppy/agent.json` |
| `BELL_POPPY_PRIVATE_JWK` | Private P-256 ES256 JWK for signing |
| `BELL_POPPY_ENCRYPTION_KEY` | Independent random 32-byte key, base64 encoded |
| `BELL_POPPY_STORE_PATH` | Durable encrypted local file; defaults to `.bell/poppy.enc.json` |
| `BELL_POPPY_JWKS_URI` | Optional public JWKS URL; defaults to `jwks.json` beside the metadata URL |

Generate an ES256 key using `jose`'s `generateKeyPair` and `exportJWK`; generate the
storage key using Node's `randomBytes(32).toString("base64")`. Import both privately
into the secret manager without printing them in logs or writing repository env
files. Keep the identity and encryption keys stable across restarts.

Bell serves public metadata at `/poppy/agent.json` and public keys at
`/poppy/jwks.json`; both must be reachable over HTTPS. These routes return 503 when
configuration is missing or invalid. Alternatively, host the matching metadata and
public JWKS elsewhere. Some providers require registration of the exact client ID.
Bell does not publish a company `poppy.json`: it consumes company APIs.

## Use

1. `poppy_discover` finds a company's APIs, scopes and sign-in options through the SDK.
2. `poppy_api` lists the supported read operations of an advertised MCP API.
3. `poppy_read` invokes a listed operation with parameters validated by the MCP SDK.
4. If account access is needed, explain the scopes and use `poppy_connect`, which
   requires approval. The user follows the provider's verification URL and consents
   themselves; Bell never automates the sign-in page.
5. After the user's reply, `poppy_status` polls through the SDK and reports the result.
6. `poppy_disconnect` requires approval and revokes all stored refresh grants.

Disconnect before requesting different scopes. Pending authorization is not account
access. Protocol errors remain explicit; Bell does not fall back to an older
protocol or silently retry an account request as an anonymous read.

## Application boundaries

Credentials belong to the authenticated Bell principal and company. SDK token and
authorization-state references are private, encrypted at rest, and absent from model
messages. Interrupted credential mutations block reads until disconnect/reconnect.
The file store supports **one agent process with durable storage**, not concurrent
replicas or serverless deployment. Back up the encrypted file and key together.

The Poppy SDK supplies DNS-pinned public HTTPS networking. Bell adds request deadlines,
size limits and output redaction. MCP tools must explicitly advertise
`readOnlyHint: true` without `destructiveHint: true`; this is the provider's assertion,
not an independent guarantee about its implementation. Bell excludes credential-named
tools and credential parameters. Provider content remains untrusted data. Results are bounded and mark truncated previews explicitly.

## Verification

Run `pnpm exec vitest run tests/poppy-*.test.ts`, then `pnpm check`. Tests target Bell's
ownership isolation, encrypted SDK-state persistence, approval boundaries, read-only
policy and redaction rather than reimplementing SDK protocol tests.

See [provider tests](provider-tests.md) for the production model/tool smoke. Live
provider compatibility and authenticated reads must be rechecked after SDK upgrades;
a successful discovery or synthetic test alone does not establish interoperability.
