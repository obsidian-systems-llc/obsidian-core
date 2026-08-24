-- Core-owned credentials deliberately remain separate from external login identities.
-- Passwords, verification/reset secrets, and refresh credentials are never stored in plaintext.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

CREATE TABLE core_identity_password_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  password_hash bytea NOT NULL,
  password_salt bytea NOT NULL,
  hash_version integer NOT NULL DEFAULT 1 CHECK (hash_version = 1),
  memory_kib integer NOT NULL CHECK (memory_kib >= 19 * 1024),
  iterations integer NOT NULL CHECK (iterations >= 2),
  parallelism integer NOT NULL CHECK (parallelism >= 1),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core_identity_one_time_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  purpose text NOT NULL CHECK (purpose IN ('email_verification','password_reset')),
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX core_identity_one_time_tokens_active_idx
  ON core_identity_one_time_tokens (user_id,purpose,expires_at)
  WHERE consumed_at IS NULL;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS family_id uuid,
  ADD COLUMN IF NOT EXISTS replaced_by_session_id uuid REFERENCES sessions(id),
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz,
  ADD COLUMN IF NOT EXISTS authentication_methods text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS authentication_level text NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS revoked_reason text;
UPDATE sessions SET family_id=id WHERE family_id IS NULL;
ALTER TABLE sessions ALTER COLUMN family_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS sessions_user_active_idx ON sessions (user_id,expires_at) WHERE revoked_at IS NULL;

CREATE TABLE core_identity_email_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  recipient_email text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('email_verification','password_reset')),
  event_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','suppressed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  provider_message_reference text,
  last_error_code text,
  queued_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX core_identity_email_deliveries_pending_idx
  ON core_identity_email_deliveries (status,next_attempt_at,queued_at);
