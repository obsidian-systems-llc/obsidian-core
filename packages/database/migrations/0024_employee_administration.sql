CREATE TABLE employee_admin_commands (
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

CREATE TABLE employee_profile_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_profile_id uuid NOT NULL REFERENCES employee_profiles(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key uuid NOT NULL,
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  auth_tag bytea NOT NULL,
  key_id text NOT NULL,
  changed_field_names jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_profile_id, idempotency_key)
);

CREATE TABLE employee_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_profile_id uuid NOT NULL REFERENCES employee_profiles(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  event_type text NOT NULL CHECK (event_type IN ('created','deactivated','reactivated')),
  effective_at timestamptz NOT NULL,
  reason text,
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_profile_id, event_type, idempotency_key)
);

CREATE INDEX employee_assignments_scope_active_idx
  ON employee_assignments (store_id, department_id, employee_profile_id)
  WHERE effective_to IS NULL;
CREATE INDEX employee_profile_revisions_profile_created_idx
  ON employee_profile_revisions (employee_profile_id, created_at DESC);

INSERT INTO permissions (key, name)
VALUES
  ('employee.manage', 'Manage employee lifecycle and assignments'),
  ('employee.scope.read', 'Read employees within active management scope')
ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, updated_at = now();

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN applications a ON a.id = r.application_id
JOIN permissions p ON p.key = 'employee.manage'
WHERE a.key = 'core-admin' AND r.key = 'super-admin'
ON CONFLICT DO NOTHING;
