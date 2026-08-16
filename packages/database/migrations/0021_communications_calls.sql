CREATE TABLE communication_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('retell')),
  provider_call_reference text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound','unknown')) DEFAULT 'unknown',
  status text NOT NULL DEFAULT 'registered',
  from_number text, to_number text, customer_profile_id uuid REFERENCES customer_profiles(id),
  assigned_employee_profile_id uuid REFERENCES employee_profiles(id), claimed_by_employee_profile_id uuid REFERENCES employee_profiles(id),
  provider_agent_reference text, started_at timestamptz, ended_at timestamptz, duration_seconds integer CHECK (duration_seconds >= 0),
  transcript text, call_summary text, analysis_data jsonb, provider_metadata jsonb NOT NULL DEFAULT '{}', raw_provider_data jsonb NOT NULL DEFAULT '{}',
  follow_up_required boolean NOT NULL DEFAULT false, follow_up_status text NOT NULL DEFAULT 'none' CHECK (follow_up_status IN ('none','required','claimed','completed')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider,provider_call_reference)
);
CREATE INDEX communication_calls_inbox_idx ON communication_calls (follow_up_status,assigned_employee_profile_id,created_at DESC);
CREATE TABLE communication_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text NOT NULL, provider_event_reference text NOT NULL,
  event_type text NOT NULL, payload_sha256 text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','failed')), UNIQUE(provider,provider_event_reference)
);
CREATE TABLE communication_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), communication_call_id uuid NOT NULL REFERENCES communication_calls(id),
  employee_profile_id uuid REFERENCES employee_profiles(id), type text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','read','completed')),
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE INDEX communication_notifications_employee_idx ON communication_notifications (employee_profile_id,status,created_at DESC);
INSERT INTO permissions (key,name) VALUES
  ('communication.call.read','Read assigned and unassigned communications calls'),
  ('communication.call.claim','Claim an unassigned communications call'),
  ('communication.call.follow_up','Complete follow-up for an assigned communications call'),
  ('communication.call.manage','Manage all communications calls and assignments')
ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name;
