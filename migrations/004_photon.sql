BEGIN;

-- Bell <-> Photon Advanced gRPC channel durability.
-- Provider sequences are stored losslessly as text; never as a JS-unsafe number.

-- One row per enrolled provider source: (project, provider instance/account, line).
-- The lease columns elect a single active subscription owner per source.
CREATE TABLE IF NOT EXISTS bell_photon_sources (
  source_id text PRIMARY KEY,
  project_id text NOT NULL,
  instance_id text NOT NULL,
  account_scope text NOT NULL,
  phone_number text NOT NULL,
  endpoint text NOT NULL,
  log_epoch text NOT NULL,
  activation_boundary text,
  capture_cursor text,
  coverage jsonb NOT NULL DEFAULT '{}',
  owner_token text,
  lease_epoch bigint NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  credential_expires_at timestamptz,
  health jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'suspended', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every captured provider event, or a minimal tombstone for denied/non-triggering input.
CREATE TABLE IF NOT EXISTS bell_photon_inbox (
  source_id text NOT NULL REFERENCES bell_photon_sources (source_id),
  log_epoch text NOT NULL,
  sequence text NOT NULL,
  sequence_num numeric(40, 0) NOT NULL,
  payload_hash text NOT NULL,
  envelope jsonb,
  tombstone boolean NOT NULL DEFAULT false,
  event_family text,
  event_type text,
  chat_guid text,
  actor text,
  target_guid text,
  is_from_me boolean,
  occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  source_kind text NOT NULL CHECK (source_kind IN ('live', 'catchup')),
  disposition text NOT NULL DEFAULT 'pending'
    CHECK (disposition IN ('pending', 'admitted', 'state_only', 'denied', 'quarantined', 'tombstone')),
  processing_state text NOT NULL DEFAULT 'captured'
    CHECK (processing_state IN ('captured', 'dispatched', 'settled', 'failed', 'quarantined')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  PRIMARY KEY (source_id, log_epoch, sequence)
);
CREATE INDEX IF NOT EXISTS bell_photon_inbox_pending
  ON bell_photon_inbox (source_id, disposition, processing_state, sequence_num);
CREATE INDEX IF NOT EXISTS bell_photon_inbox_chat
  ON bell_photon_inbox (source_id, chat_guid, sequence_num);

-- Canonical conversation binding: (source, provider chat GUID, generation) -> Eve session.
CREATE TABLE IF NOT EXISTS bell_photon_conversations (
  binding_id text PRIMARY KEY,
  source_id text NOT NULL REFERENCES bell_photon_sources (source_id),
  chat_guid text NOT NULL,
  generation integer NOT NULL DEFAULT 1,
  scope text NOT NULL CHECK (scope IN ('direct', 'group')),
  eve_address text NOT NULL,
  eve_session_id text,
  initiating_principal text,
  membership_version integer NOT NULL DEFAULT 0,
  membership jsonb NOT NULL DEFAULT '[]',
  last_turn_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, chat_guid, generation)
);

-- Dispatch intents: one inbox action -> one durable Eve delivery attempt ledger row.
CREATE TABLE IF NOT EXISTS bell_photon_dispatch_intents (
  intent_id text PRIMARY KEY,
  source_id text NOT NULL,
  log_epoch text NOT NULL,
  sequence text NOT NULL,
  action text NOT NULL CHECK (action IN ('send', 'respond', 'state_apply')),
  eve_session_id text,
  dispatch_key text NOT NULL,
  input_digest text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'ambiguous', 'rejected', 'quarantined')),
  delivery_id text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dispatch_key),
  FOREIGN KEY (source_id, log_epoch, sequence)
    REFERENCES bell_photon_inbox (source_id, log_epoch, sequence)
);

-- Durable outbound command queue: replies, notices, rich tools, proactive sends.
CREATE TABLE IF NOT EXISTS bell_photon_commands (
  command_id text PRIMARY KEY,
  operation text NOT NULL,
  args jsonb NOT NULL,
  args_digest text NOT NULL,
  initiator_principal text,
  audience text CHECK (audience IN ('direct', 'group', 'system')),
  source_id text NOT NULL,
  chat_guid text NOT NULL,
  target jsonb,
  provider_key text,
  semantic_key text NOT NULL UNIQUE,
  depends_on text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'in_flight', 'acknowledged', 'ambiguous', 'failed', 'cancelled', 'expired')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text,
  claim_expires_at timestamptz,
  result jsonb,
  provider_receipt jsonb,
  error_code text,
  error_detail text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bell_photon_commands_queue
  ON bell_photon_commands (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS bell_photon_commands_chat
  ON bell_photon_commands (source_id, chat_guid, created_at);

-- Durable provider resources: messages, attachments, polls, card sessions, artifacts.
CREATE TABLE IF NOT EXISTS bell_photon_resources (
  source_id text NOT NULL REFERENCES bell_photon_sources (source_id),
  kind text NOT NULL
    CHECK (kind IN ('message', 'attachment', 'poll', 'miniapp_session', 'artifact', 'chat')),
  resource_id text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 1,
  tombstone boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, kind, resource_id)
);

-- Bounded downloaded/uploaded artifact bytes for model staging and sends.
CREATE TABLE IF NOT EXISTS bell_photon_artifacts (
  artifact_id text PRIMARY KEY,
  source_id text NOT NULL REFERENCES bell_photon_sources (source_id),
  chat_guid text NOT NULL,
  attachment_guid text,
  file_name text,
  media_type text NOT NULL,
  byte_size bigint NOT NULL,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Pending interactions: Eve input requests / auth attempts that an inbound event may resolve.
CREATE TABLE IF NOT EXISTS bell_photon_pending_interactions (
  interaction_id text PRIMARY KEY,
  source_id text NOT NULL REFERENCES bell_photon_sources (source_id),
  binding_id text,
  chat_guid text NOT NULL,
  generation integer NOT NULL DEFAULT 1,
  kind text NOT NULL CHECK (kind IN ('prompt', 'authorization', 'poll', 'reaction_contract')),
  request_ref text NOT NULL,
  permitted_actor text,
  target jsonb NOT NULL DEFAULT '{}',
  response_mapping jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'resolved', 'expired', 'cancelled')),
  expires_at timestamptz,
  resolved_actor text,
  resolved_at timestamptz,
  resolution jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bell_photon_pending_open
  ON bell_photon_pending_interactions (source_id, chat_guid, status);

-- Output projector offsets: per bound Eve session, durable stream position + materialized keys.
CREATE TABLE IF NOT EXISTS bell_photon_projector_offsets (
  source_id text NOT NULL REFERENCES bell_photon_sources (source_id),
  eve_session_id text NOT NULL,
  stream_position bigint NOT NULL DEFAULT 0,
  materialized_keys jsonb NOT NULL DEFAULT '[]',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, eve_session_id)
);

-- Absolute session deadlines preserving Bell's 24-hour maximum conversation lifetime.
CREATE TABLE IF NOT EXISTS bell_photon_session_deadlines (
  eve_session_id text PRIMARY KEY,
  binding_id text,
  deadline_at timestamptz NOT NULL,
  retired_at timestamptz,
  retirement_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bell_photon_deadlines_due
  ON bell_photon_session_deadlines (deadline_at) WHERE retired_at IS NULL;

COMMIT;
