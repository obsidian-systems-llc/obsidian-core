ALTER TABLE quotes DROP CONSTRAINT quotes_status_check;
ALTER TABLE quotes ADD CONSTRAINT quotes_status_check
  CHECK (status IN ('draft','issued','approved','accepted','expired','cancelled','superseded'));

ALTER TABLE quotes
  ADD COLUMN root_quote_id uuid REFERENCES quotes(id),
  ADD COLUMN revised_from_quote_id uuid REFERENCES quotes(id),
  ADD COLUMN revision_number integer NOT NULL DEFAULT 1 CHECK (revision_number > 0),
  ADD COLUMN issued_at timestamptz,
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN accepted_at timestamptz,
  ADD COLUMN cancelled_at timestamptz;

UPDATE quotes SET root_quote_id = id WHERE root_quote_id IS NULL;
ALTER TABLE quotes ALTER COLUMN root_quote_id SET NOT NULL;
CREATE UNIQUE INDEX quotes_root_revision_number_idx ON quotes(root_quote_id, revision_number);
CREATE INDEX quotes_customer_status_idx ON quotes(customer_profile_id, status, created_at DESC);

CREATE TABLE quote_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES quotes(id),
  actor_user_id uuid REFERENCES users(id),
  action text NOT NULL CHECK (action IN ('issued','approved','accepted','expired','cancelled','superseded','revised','price_overridden')),
  reason text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key uuid NOT NULL,
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_user_id, action, idempotency_key)
);
CREATE INDEX quote_lifecycle_events_quote_idx ON quote_lifecycle_events(quote_id, occurred_at DESC);

CREATE FUNCTION reject_quote_lifecycle_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Quote lifecycle history is immutable.'; END;
$$;
CREATE TRIGGER quote_lifecycle_events_immutable
  BEFORE UPDATE OR DELETE ON quote_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION reject_quote_lifecycle_mutation();

INSERT INTO permissions (key, name) VALUES
  ('quote.issue', 'Issue quotes to customers'),
  ('quote.approve', 'Approve quotes'),
  ('quote.revise', 'Create quote revisions'),
  ('quote.override', 'Create approved price override revisions'),
  ('quote.cancel', 'Cancel quotes'),
  ('quote.self.accept', 'Accept owned issued quotes')
ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, updated_at = now();

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN applications a ON a.id = r.application_id
JOIN permissions p ON p.key IN ('quote.issue','quote.approve','quote.revise','quote.override','quote.cancel')
WHERE a.key = 'core-admin' AND r.key = 'super-admin'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN applications a ON a.id = r.application_id
JOIN permissions p ON p.key = 'quote.self.accept'
WHERE a.key = 'customer-portal' AND r.key = 'customer-self-service'
ON CONFLICT DO NOTHING;
