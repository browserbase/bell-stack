-- OAuth clients, grants, and PKCE attempts are encrypted together and bound to their owner.
CREATE TABLE IF NOT EXISTS bell_notion_connections (
  owner text PRIMARY KEY,
  encrypted_state text NOT NULL,
  state_hash text UNIQUE,
  updated_at timestamptz NOT NULL DEFAULT now()
);
