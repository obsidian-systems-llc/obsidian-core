-- Core-owned MFA factors. TOTP seeds are encrypted with the existing field-encryption key;
-- recovery codes are random values stored only as hashes.
CREATE TABLE core_identity_mfa_factors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  factor_type text NOT NULL CHECK (factor_type IN ('totp')),
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  auth_tag bytea NOT NULL,
  key_id text NOT NULL,
  verified_at timestamptz,
  deactivated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, factor_type)
);
CREATE TABLE core_identity_mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factor_id uuid NOT NULL REFERENCES core_identity_mfa_factors(id),
  code_hash bytea NOT NULL UNIQUE,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX core_identity_mfa_active_factor_idx
  ON core_identity_mfa_factors (user_id) WHERE verified_at IS NOT NULL AND deactivated_at IS NULL;
