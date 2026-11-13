# Poppy client

Bell consumes a company's `/.well-known/poppy.json` to find its structured APIs.
For example, a grocery comparison service can expose a product search through MCP;
Bell discovers the schema and calls the read operation with the user's query.
Account reads use the company's device authorization flow: the user signs in on
its website, and Bell stores the resulting grant outside the conversation.

This is a client integration. Bell does not publish a company `poppy.json` because
it does not offer a company API or company OAuth issuer.

## Configure an identity

Poppy requests identify the agent with an HTTPS client metadata URL and signed
Session proofs. Even public reads need this identity. Configure:

| Variable | Purpose |
| --- | --- |
| `BELL_POPPY_CLIENT_ID` | Public HTTPS metadata URL, normally `https://your-bell.example/poppy/agent.json` |
| `BELL_POPPY_PRIVATE_JWK` | Private P-256 ES256 JWK for signing; inject from a secret manager |
| `BELL_POPPY_ENCRYPTION_KEY` | Independent random 32-byte key, base64 encoded; inject from a secret manager |
| `BELL_POPPY_STORE_PATH` | Durable encrypted local file; defaults to `.bell/poppy.enc.json` |
| `BELL_POPPY_JWKS_URI` | Optional public JWKS URL; defaults to `jwks.json` beside the metadata URL |

Generate the signing key with Node's `generateKeyPairSync("ec", { namedCurve:
"prime256v1" })` and export the private key with `{ format: "jwk" }`. Generate
the independent storage key with `randomBytes(32).toString("base64")`. Import both
values into your deployment's secret manager without printing them in logs or
saving them in repository environment files. Keep these values stable across restarts.

Bell serves public client metadata at `/poppy/agent.json` and public keys at
`/poppy/jwks.json`. These two routes must be publicly reachable over HTTPS; only
public key material is returned. They return 503 when the signing identity is
unconfigured. You can instead host the same metadata and JWKS on another HTTPS
domain; its advertised `client_id` and keys must match Bell's configuration.
Some companies require registering that exact client ID before accepting requests.

Use application authentication for deployed Bell. Poppy account state belongs to
the authenticated Bell principal, not a model-supplied user ID. The local file store
supports **one agent process on durable storage**; it does not coordinate replicas
or serverless instances. Back up the encrypted file and its encryption key together.
Changing the client ID or losing the keys requires reconnecting accounts. Disconnect
accounts before retiring an identity so the provider can revoke outstanding grants.

## Use the tools

1. `poppy_discover`: validate a company's manifest and discover its issuer and APIs.
2. `poppy_api`: list supported read operations, parameters, and required scopes.
3. `poppy_read`: call a listed operation with named parameters.
4. If access is required, explain the scopes and use `poppy_connect`. It requires
   tool approval and returns a verification URL, user code, and expiry.
5. The user opens that URL, signs in, and consents themselves. After their reply,
   `poppy_status` checks authorization while respecting the provider's polling interval.
6. `poppy_disconnect` requires tool approval and revokes access. Failed revocation
   blocks local use and remains retryable.

Example task: "Use Poppy at https://www.prijsprofeet.nl to find current Oatly Barista
prices. Show product sizes, retailers, offer dates, and source links."

Never put credentials into tool parameters or messages. Discovery and schemas are
untrusted descriptions. A provider's read-only annotation is its assertion, not an
independent guarantee that its implementation has no side effects.

## Supported scope

The implementation follows the [Poppy specification](https://personalagentprotocol.org/docs/spec),
including the deployed 0.3 and 0.4 formats and the 1.x discovery format. This is a
limited client, not a claim of complete protocol conformance. For deployed 0.3
servers, Session proofs include both the current `poppy_dlg` delegation and the
older `pap_dlg` form, each signed for the same delegated key. Later versions use
only the current form:

- HTTPS discovery, issuer/resource validation, private-key client assertions, and
  fresh delegated Session proofs bound to the method, URL, company, and token.
- JSON OpenAPI 3.0/3.1 GET operations with supported schemas and parameter types.
- MCP discovery/initialization and tools explicitly annotated `readOnlyHint: true`
  without `destructiveHint: true`, using JSON or SSE responses.
- Device authorization, resource-bound Bearer tokens, optional refresh-token
  rotation, and revocation. Replacement sign-ins preserve the previous grant
  until the new grant succeeds.

Unsupported operations are excluded or fail explicitly. Poppy writes, purchases,
Operations, browser handoff/join, direct and browser OAuth grants, DPoP, arbitrary
headers, external schema references, and streaming subscriptions are not supported.
Tokens, private keys, device codes, and signed proofs stay server-side. Public
network validation rejects private destinations and credentials are not forwarded
through redirects. Token state is encrypted at rest, with restrictive file permissions.

## Verification

Run `pnpm exec vitest run tests/poppy-*.test.ts` for discovery/transport, signature,
isolation, encrypted storage, consent, token lifecycle, API validation, and recovery
checks, then `pnpm check` for repository tests and the production build.
Live checks require a reachable identity and real provider access. A passing mock
test or successful discovery alone does not prove that a provider accepts Bell's
identity, authorizes the user, or performs a useful account read.
