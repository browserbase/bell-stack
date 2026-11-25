BEGIN;

CREATE TABLE IF NOT EXISTS bell_price_watches (
  id uuid PRIMARY KEY,
  issuer text NOT NULL,
  owner_id text NOT NULL,
  destination jsonb NOT NULL,
  terms jsonb NOT NULL,
  equivalent text NOT NULL,
  identity text NOT NULL,
  credential_fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','degraded','reserved','uncertain','accepted','stopped','expired','opted_out','failed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 days',
  alert jsonb,
  alert_body text,
  dispatch_at timestamptz,
  message_id text UNIQUE,
  delivery_status text
);

-- Earlier draft installations kept completed, unconfirmed sends open.
UPDATE bell_price_watches SET status='failed', delivery_status='unresolved'
WHERE status='uncertain' AND delivery_status IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS bell_price_watches_equivalent_open
  ON bell_price_watches (issuer, owner_id, equivalent)
  WHERE status IN ('active','degraded','reserved','uncertain');
CREATE INDEX IF NOT EXISTS bell_price_watches_owner ON bell_price_watches (issuer, owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bell_price_watches_expiration ON bell_price_watches (expires_at)
  WHERE status IN ('active','degraded','reserved','uncertain');

CREATE TABLE IF NOT EXISTS bell_price_actions (
  issuer text NOT NULL,
  owner_id text NOT NULL,
  chat text NOT NULL,
  line text NOT NULL,
  message_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('enroll','stop')),
  request jsonb NOT NULL,
  outcome jsonb,
  PRIMARY KEY (issuer, owner_id, chat, line, message_id, action)
);

CREATE TABLE IF NOT EXISTS bell_price_offers (
  id text PRIMARY KEY,
  observation jsonb NOT NULL,
  next_at timestamptz NOT NULL,
  verified_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS bell_price_offers_due ON bell_price_offers (next_at);

CREATE TABLE IF NOT EXISTS bell_price_subscriptions (
  watch_id uuid NOT NULL REFERENCES bell_price_watches(id),
  offer_id text NOT NULL REFERENCES bell_price_offers(id),
  PRIMARY KEY (watch_id, offer_id)
);
CREATE INDEX IF NOT EXISTS bell_price_subscriptions_offer ON bell_price_subscriptions (offer_id, watch_id);

-- Keep price jobs out of the legacy queue so a previous application revision cannot claim them.
CREATE TABLE IF NOT EXISTS bell_price_jobs (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('observe','send')),
  target text NOT NULL,
  next_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until timestamptz,
  lease_token uuid,
  attempts integer NOT NULL DEFAULT 0,
  failed boolean NOT NULL DEFAULT false,
  last_error text
);
CREATE INDEX IF NOT EXISTS bell_price_jobs_due ON bell_price_jobs (next_at) WHERE NOT failed;

COMMIT;
