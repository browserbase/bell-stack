# Photon iMessage channel capabilities

Bell's iMessage transport runs on Photon Advanced gRPC (`@photon-ai/advanced-imessage`,
Stable Cloud). This document is the operator-facing reference for what the
channel can do, how it is secured and how it is operated. All names below are
grounded in `server/photon/contracts.ts` and the SDK surface; nothing is
invented.

## Architecture

Three components cooperate:

- **Worker** (`server/photon/worker.ts`, `server/photon/events.ts`,
  `server/photon/normalize.ts`): holds the authenticated Advanced gRPC event
  subscription, normalises provider events into the frozen
  `PhotonNormalizedEvent` contract and durably captures them in the inbox
  tables (`migrations/004_photon.sql`) before any Eve work begins.
- **Channel** (`agent/channels/photon.ts`): the Eve channel adapter. It
  receives admitted events through the private internal dispatch route and
  exposes Bell's agent loop, tools and fixed-session policy.
- **Outbox** (`server/photon/outbox.ts` + command ledger): every outbound
  provider call is queued as a durable command row with an idempotency key,
  claimed by a worker, executed against the SDK and reconciled to a terminal
  or retryable state. Nothing reaches the provider without a ledger row.

The worker never runs a model loop, browser automation or a parallel memory:
Bell remains the only agent runtime. The worker maintains connections,
persists events, executes queued operations and recovers failures.

Internal routes, all bound to `BELL_PHOTON_INTERNAL_ORIGIN` and authenticated
with `BELL_PHOTON_INTERNAL_SECRET` (≥ 32 bytes, never public):

| Route | Purpose |
| --- | --- |
| `POST /internal/photon/dispatch` | Deliver an admitted event to its fixed Eve session |
| `POST /internal/photon/events` | Provider/event-plane ingress hook |
| `GET /internal/photon/health` | Worker and lease liveness |
| `POST /internal/photon/retire` | Retire a conversation on its absolute deadline |

## Command catalog

The durable command path exposes **44 enqueueable operations**
(`commandArgsSchemas`), grouped by SDK resource. The broader SDK surface also
includes streaming and lifecycle methods (subscriptions, attachment download
streams, catch-up replays) that the worker consumes directly; they are never
queued as commands. Argument validation is the authoritative
`validateCommandArgs` schema set.

Keyed operations (`KEYED_OPERATIONS`) carry `providerKeyFor` as the provider
`clientMessageId` and must never be blind-retried after a transport failure:
the outbox marks them `ambiguous` for reconciliation instead. Read operations
(`READ_OPERATIONS`, marked **R**) are side-effect-free and may retry freely.
`locations.watch` is a Bell-scoped subscription control, not a raw RPC
passthrough.

### Messages (14)

`messages.sendText`, `messages.sendAttachment`, `messages.sendMultipart`,
`messages.sendCustomizedMiniApp`, `messages.updateCustomizedMiniApp`,
`messages.edit`, `messages.unsend`, `messages.setReaction`,
`messages.placeSticker`, `messages.notifySilenced` (all keyed) plus
`messages.get`, `messages.listInChat`, `messages.listRecent`,
`messages.getEmbeddedMedia` (all **R**).

### Attachments (2)

`attachments.upload` (artifact-backed, optional Live Photo companion) and
`attachments.get` (**R**). Downloads are bounded by
`BELL_PHOTON_MAX_ARTIFACT_BYTES` and always fail closed before producing a
partial artifact.

### Chats (9)

`chats.create` (keyed), `chats.get` (**R**), `chats.count` (**R**),
`chats.markRead`, `chats.setTyping`, `chats.shareContactInfo`,
`chats.hasBackground` (**R**), `chats.setBackground` (exactly one of `preset`
or `artifactId`), `chats.removeBackground`.

### Groups (7)

`groups.setDisplayName`, `groups.addParticipants`, `groups.removeParticipants`,
`groups.leave`, `groups.setIcon`, `groups.removeIcon` (all keyed),
`groups.getIcon` (**R**).

### Polls (5)

`polls.create` (2–100 choices), `polls.vote` (non-empty `optionIdentifier`),
`polls.unvote`, `polls.addOption` (all keyed), `polls.get` (**R**).

### Addresses (3)

`addresses.get`, `addresses.isIMessageAvailable`, `addresses.isFocusSilenced`
(all **R**).

### Locations (4)

`locations.request` (keyed), `locations.list` (**R**), `locations.get` (**R**),
`locations.watch` (`start`/`stop` subscription control).

## Inbound event catalog

The worker normalises all **24 event variants** of
`PhotonNormalizedEvent`:

| Family | Variants |
| --- | --- |
| `message` (7) | `received`, `edited`, `read`, `unsent`, `reactionAdded`, `reactionRemoved`, `stickerPlaced` |
| `chat` (5) | `backgroundChanged`, `backgroundRemoved`, `markedRead`, `archived`, `unarchived` |
| `group` (6) | `displayNameChanged`, `participantAdded`, `participantRemoved`, `participantLeft`, `iconChanged`, `iconRemoved` |
| `poll` (4) | `created`, `optionAdded`, `voted`, `unvoted` |
| `location` (1) | `updated` |
| `catchup` (1) | `complete` |

Every event carries an envelope (`PhotonEventEnvelope`) with a durable
`(sourceId, logEpoch, sequence)` cursor, the actor (when known), the chat
target and a `live`/`catchup` source kind. Replays preserve metadata so cold
restarts resume from `maxSequenceNum` without re-dispatching deduplicated
events.

## Audience and security model

- **Private conversations**: only handles on
  `BELL_PHOTON_ALLOWED_SENDERS`/`BELL_PHOTON_ALLOWED_EMAIL_SENDERS` (normalised
  E.164/lowercase email) are admitted. Anything else is denied before Eve sees
  it.
- **Group conversations**: the group guid must be on
  `BELL_PHOTON_ALLOWED_GROUPS`. Actor membership is enforced when known;
  non-member actors degrade to state-only events that update projection
  without authorization. The initiating principal is immutable for the
  lifetime of the conversation.
- **Private continuation**: every sensitive capability (Link checkout, personal
  1Password, operator vault, reusable browser context) requires a direct-scope
  audience. Group-scoped principals can never reach them; the verified
  `photon:` principal (`photon-imessage` authenticator, `photon` issuer,
  `photon:audience` attribute) is the only identity Bell trusts.
- **Self-origin echoes** are admitted as state-only so the outbox reconciles
  its own sends rather than triggering a second dispatch.
- **Missing actors** can never authorize tools or pending interactions; a
  replayed or unattributed vote resolves nothing.

## Environment reference

Required when `BELL_PHOTON_ENABLED` is set:

| Variable | Contract |
| --- | --- |
| `BELL_PHOTON_ENABLED` | Feature flag; absent/`0`/`false` returns `null` config with no provider dependency |
| `IMESSAGE_PROJECT_ID` | Stable Cloud project id |
| `IMESSAGE_PROJECT_SECRET` | Project credential, server-only |
| `BELL_PHOTON_PHONE_NUMBER` | Dedicated receiving line in strict E.164 |
| `BELL_PHOTON_ALLOWED_SENDERS` | Non-empty E.164 sender allowlist |
| `BELL_PHOTON_INTERNAL_SECRET` | ≥ 32 byte secret authenticating internal routes |
| `BELL_PHOTON_INTERNAL_ORIGIN` | Bare `http(s)://` origin: no path, query, hash or credentials |
| `DATABASE_URL` | Postgres for the durable tables |

Optional: `BELL_PHOTON_ALLOWED_EMAIL_SENDERS`,
`BELL_PHOTON_ALLOWED_GROUPS` (empty keeps group ingress closed) and
`BELL_PUBLIC_URL`.

Worker tuning (all bounded with safe defaults): `BELL_PHOTON_LEASE_MS`,
`BELL_PHOTON_HEARTBEAT_STALE_MS`, `BELL_PHOTON_COMMAND_BATCH`,
`BELL_PHOTON_DISPATCH_BATCH`, `BELL_PHOTON_COMMAND_POLL_MS`,
`BELL_PHOTON_DISPATCH_POLL_MS`, `BELL_PHOTON_PROJECTION_POLL_MS`,
`BELL_PHOTON_RECONCILIATION_MS`, `BELL_PHOTON_SHUTDOWN_MS`,
`BELL_PHOTON_MAX_ARTIFACT_BYTES`.

The token URL is derived as
`https://spectrum.photon.codes/projects/{projectId}/imessage/tokens`.

## Deployment, rollout and cutover

1. Apply `migrations/004_photon.sql`; the Photon tables are independent of the
   Linq path.
2. Deploy with `BELL_PHOTON_ENABLED` unset: the channel is inert and no LINQ\_\*
   variable is consulted. The flags are independent, so source and cutover can
   roll separately.
3. Set the Photon environment, start the worker and confirm
   `/internal/photon/health` shows a held lease and a live stream.
4. Drain Linq traffic, then disable the Linq webhook. Keep
   `BELL_PHOTON_INTERNAL_ORIGIN` and secret unchanged across the cutover so
   durable deadlines, outbox commands and inbox cursors survive the restart.
5. Rollback: unset `BELL_PHOTON_ENABLED`, re-enable the Linq webhook. Queued
   Photon commands remain durable and retryable; nothing is lost by pausing
   the worker.

## Limitations

- **Provider acceptance is not device rendering.** A `clientMessageId`
  acknowledgement proves Photon accepted the send; observed recipient-device
  rendering is a separate verification state that requires a live device.
- **Effects, stickers, mini-app cards and backgrounds** degrade by recipient
  capability; `backwardCompatText` on `messages.edit` is the only fallback
  Bell controls.
- **Group membership is observed state**: until the stream reports members,
  unknown actors are treated conservatively as non-members.
- **Poll and location fidelity** depends on Photon's Stable surface; votes
  from unsupported clients arrive as state, not resolvable interactions.

## Recovery runbook

- **Inbox integrity conflict**: identical `(sourceId, logEpoch, sequence)`
  with a different payload hash is an integrity conflict, never an overwrite.
  Quarantine and inspect the source log before replaying.
- **Ambiguous command**: a transport failure on a keyed operation leaves the
  command `ambiguous`. Reconcile by reading provider state
  (`messages.get`/`polls.get`) before deciding to retry; do not re-enqueue
  blindly.
- **Cold restart**: the worker resumes from the per-chat `maxSequenceNum`
  cursor and replays catch-up events with `sourceKind: "catchup"` before
  activating live dispatch.
- **Retired session**: late events for a retired binding follow the rejected
  path; absolute deadlines survive restart and are retired only through
  `/internal/photon/retire`, never by idle cancellation.
- **Interaction expiry**: `expireInteractions` sweeps stale pending rows;
  one-time resolution is durable, so replayed votes cannot re-fire.

## Live verification TODO

Recorded prerequisites that need real credentials or devices (not part of the
automated suite):

- TODO(live): authenticate against Stable Cloud with the production
  `IMESSAGE_PROJECT_ID`/`SECRET` and confirm stream attach.
- TODO(live): send a keyed `messages.sendText` to a real device and observe
  rendering plus the self-echo reconciliation.
- TODO(live): exercise `chats.setBackground`, `polls.*` and
  `locations.request` against a real group to confirm fidelity.
- TODO(live): confirm `attachments.upload` with a Live Photo companion pair
  renders on device.
