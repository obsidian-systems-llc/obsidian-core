CREATE TABLE authorization_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL,
  idempotency_key uuid NOT NULL,
  target_type text NOT NULL,
  target_id uuid,
  result jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_user_id, action, idempotency_key)
);

CREATE TABLE authorization_role_permission_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id uuid NOT NULL REFERENCES roles(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key uuid NOT NULL,
  before_permission_keys jsonb NOT NULL,
  after_permission_keys jsonb NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_id, idempotency_key)
);

CREATE INDEX user_roles_active_user_idx ON user_roles (user_id, effective_from DESC)
  WHERE effective_to IS NULL;
CREATE INDEX application_entitlements_active_user_idx ON application_entitlements (user_id, effective_from DESC)
  WHERE effective_to IS NULL AND deactivated_at IS NULL;

INSERT INTO permissions (key,name) VALUES
  ('authorization.manage','Manage roles, permissions, role assignments, and application entitlements')
ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name;

INSERT INTO role_permissions (role_id,permission_id)
SELECT r.id,p.id FROM roles r
JOIN applications a ON a.id=r.application_id AND a.key='core-admin'
JOIN permissions existing ON existing.id IN (SELECT permission_id FROM role_permissions WHERE role_id=r.id)
JOIN permissions p ON p.key='authorization.manage'
WHERE r.key='super-admin' AND existing.key='authorization.read'
ON CONFLICT DO NOTHING;
