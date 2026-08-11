CREATE TABLE customer_profile_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_profile_id uuid NOT NULL REFERENCES customer_profiles(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  auth_tag bytea NOT NULL,
  key_id text NOT NULL,
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_profile_id, idempotency_key)
);
CREATE INDEX customer_profile_revisions_profile_created_idx
  ON customer_profile_revisions (customer_profile_id, created_at DESC);

CREATE TABLE customer_account_closures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_profile_id uuid NOT NULL REFERENCES customer_profiles(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key uuid NOT NULL,
  reason text,
  closed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_profile_id, idempotency_key)
);
CREATE INDEX customer_account_closures_profile_closed_idx
  ON customer_account_closures (customer_profile_id, closed_at DESC);

INSERT INTO permissions (key, name) VALUES
  ('customer.account.close', 'Close own customer account')
ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN applications a ON a.id = r.application_id AND a.key = 'customer-portal'
JOIN permissions p ON p.key = 'customer.account.close'
WHERE r.key = 'customer-self-service'
ON CONFLICT DO NOTHING;
