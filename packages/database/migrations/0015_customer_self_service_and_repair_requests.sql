ALTER TABLE customer_profile_addresses ADD COLUMN idempotency_key uuid;
CREATE UNIQUE INDEX customer_profile_addresses_idempotency_idx
  ON customer_profile_addresses (customer_profile_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE customer_devices ADD COLUMN idempotency_key uuid;
CREATE UNIQUE INDEX customer_devices_profile_idempotency_idx
  ON customer_devices (customer_profile_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE customer_repair_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id),
  customer_profile_id uuid NOT NULL REFERENCES customer_profiles(id),
  customer_address_id uuid NOT NULL REFERENCES customer_addresses(id),
  customer_device_id uuid REFERENCES customer_devices(id),
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  auth_tag bytea NOT NULL,
  key_id text NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (created_by_user_id, idempotency_key)
);
CREATE INDEX customer_repair_requests_profile_created_idx
  ON customer_repair_requests (customer_profile_id, created_at DESC);
