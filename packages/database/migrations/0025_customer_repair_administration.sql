CREATE TABLE customer_administration_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL,
  idempotency_key uuid NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_user_id, action, idempotency_key)
);

CREATE TABLE job_customer_association_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL CHECK (action IN ('linked','relinked','removed')),
  previous_customer_profile_id uuid REFERENCES customer_profiles(id),
  customer_profile_id uuid REFERENCES customer_profiles(id),
  reason text NOT NULL,
  idempotency_key uuid NOT NULL,
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_user_id, idempotency_key)
);
CREATE INDEX job_customer_association_events_job_idx
  ON job_customer_association_events (job_id, occurred_at DESC);

INSERT INTO permissions (key, name)
VALUES
  ('customer.manage', 'Manage customer profiles'),
  ('repair.customer.manage', 'Manage repair customer associations')
ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, updated_at = now();

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN applications a ON a.id = r.application_id
JOIN permissions p ON p.key IN ('customer.manage','repair.customer.manage')
WHERE a.key = 'core-admin' AND r.key = 'super-admin'
ON CONFLICT DO NOTHING;
