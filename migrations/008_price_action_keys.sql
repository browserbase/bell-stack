BEGIN;

-- Enrollment requests are already validated and normalized by watchTerms.
-- JSONB gives them canonical field order, and equal amounts may differ in scale.
CREATE OR REPLACE FUNCTION bell_price_operation_key(action_name text, action_request jsonb)
RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE WHEN action_name = 'stop' THEN (action_request->>'id')::uuid::text
    ELSE encode(sha256(convert_to(jsonb_set(action_request, '{amount}',
      to_jsonb(trim_scale((action_request->>'amount')::numeric)::text))::text, 'UTF8')), 'hex')
  END
$$;

-- A generated key also fills in existing requests without changing their outcomes.
ALTER TABLE bell_price_actions ADD COLUMN IF NOT EXISTS operation_key text
  GENERATED ALWAYS AS (bell_price_operation_key(action, request)) STORED;

ALTER TABLE bell_price_actions
  DROP CONSTRAINT bell_price_actions_pkey,
  ADD PRIMARY KEY (issuer, owner_id, chat, line, message_id, action, operation_key);

COMMIT;
