CREATE TABLE customer_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_profile_id uuid NOT NULL REFERENCES customer_profiles(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'retired')),
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  auth_tag bytea NOT NULL,
  key_id text NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_devices_profile_active_idx
  ON customer_devices (customer_profile_id, created_at DESC)
  WHERE archived_at IS NULL;
