-- CORE-046: explicit customer SMS consent evidence. Phone numbers remain encrypted at rest.
CREATE TABLE customer_sms_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_profile_id uuid NOT NULL REFERENCES customer_profiles(id),
  user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('opted_in','opted_out')),
  source text NOT NULL CHECK (source IN ('customer_registration','customer_preferences','twilio_inbound')),
  consent_text_version text NOT NULL,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  key_id text NOT NULL,
  consented_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status='opted_in' AND revoked_at IS NULL) OR (status='opted_out' AND revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX customer_sms_consents_active_user_idx
  ON customer_sms_consents (user_id) WHERE status='opted_in';
CREATE INDEX customer_sms_consents_profile_idx
  ON customer_sms_consents (customer_profile_id, consented_at DESC);
