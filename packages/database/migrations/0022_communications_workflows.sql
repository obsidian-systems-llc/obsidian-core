-- HMAC fingerprints permit exact customer phone matching without exposing phone numbers.
CREATE TABLE customer_contact_phone_lookups (
  customer_profile_id uuid NOT NULL REFERENCES customer_profiles(id),
  value_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_profile_id, value_hash),
  UNIQUE (value_hash, customer_profile_id)
);
CREATE INDEX customer_contact_phone_lookups_hash_idx ON customer_contact_phone_lookups (value_hash);

ALTER TABLE communication_calls
  ADD COLUMN call_purpose text,
  ADD COLUMN disposition text,
  ADD COLUMN priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  ADD COLUMN follow_up_due_at timestamptz,
  ADD COLUMN follow_up_notes text;

CREATE TABLE communication_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_communication_call_id uuid REFERENCES communication_calls(id),
  assigned_employee_profile_id uuid REFERENCES employee_profiles(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','qualified','closed','suppressed')),
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  auth_tag bytea NOT NULL,
  key_id text NOT NULL,
  phone_hash text,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (created_by_user_id, idempotency_key)
);
CREATE INDEX communication_leads_phone_hash_idx ON communication_leads (phone_hash);

CREATE TABLE communication_call_job_links (
  communication_call_id uuid PRIMARY KEY REFERENCES communication_calls(id),
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (created_by_user_id, idempotency_key)
);

CREATE TABLE communication_contact_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_hash text NOT NULL UNIQUE,
  source_communication_call_id uuid REFERENCES communication_calls(id),
  reason text NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  lifted_at timestamptz
);

INSERT INTO permissions (key,name) VALUES
  ('communication.call.repair.create','Create a reviewed repair job from a communications call'),
  ('communication.lead.create','Create a reviewed lead from a communications call'),
  ('communication.dnc.manage','Record and manage communications do-not-call suppression')
ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name;
