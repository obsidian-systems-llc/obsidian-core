CREATE TABLE account_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_email text NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  token_ciphertext bytea NOT NULL,
  token_iv bytea NOT NULL,
  token_auth_tag bytea NOT NULL,
  token_key_id text NOT NULL,
  application_id uuid NOT NULL REFERENCES applications(id),
  role_id uuid NOT NULL REFERENCES roles(id),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','accepted','revoked','expired')),
  expires_at timestamptz NOT NULL,
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  next_delivery_at timestamptz,
  provider_message_reference text,
  last_error_code text,
  accepted_by_user_id uuid REFERENCES users(id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (created_by_user_id, idempotency_key)
);
CREATE INDEX account_invitations_delivery_idx
  ON account_invitations (status,next_delivery_at,created_at);
CREATE INDEX account_invitations_recipient_idx
  ON account_invitations (recipient_email,status,expires_at DESC);

INSERT INTO permissions (key,name) VALUES
  ('authorization.invite','Issue and manage workforce account invitations')
ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name;

INSERT INTO role_permissions (role_id,permission_id)
SELECT r.id,p.id FROM roles r
JOIN applications a ON a.id=r.application_id AND a.key='core-admin'
JOIN permissions p ON p.key='authorization.invite'
WHERE r.key='super-admin'
ON CONFLICT DO NOTHING;
