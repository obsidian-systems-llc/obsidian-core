ALTER TABLE time_entries
  ADD COLUMN job_id uuid REFERENCES jobs(id),
  ADD COLUMN unpaid_break_seconds bigint NOT NULL DEFAULT 0 CHECK (unpaid_break_seconds >= 0);

CREATE TABLE mobile_time_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_profile_id uuid NOT NULL REFERENCES employee_profiles(id),
  job_id uuid REFERENCES jobs(id),
  event_type text NOT NULL CHECK (event_type IN ('clock_in', 'clock_out', 'break_start', 'break_end')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key uuid NOT NULL,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_profile_id, idempotency_key)
);

CREATE INDEX mobile_time_events_employee_occurred_idx
  ON mobile_time_events (employee_profile_id, occurred_at DESC, id DESC);

CREATE FUNCTION reject_mobile_time_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Mobile time events are immutable.';
END;
$$;

CREATE TRIGGER mobile_time_events_immutable
  BEFORE UPDATE OR DELETE ON mobile_time_events
  FOR EACH ROW EXECUTE FUNCTION reject_mobile_time_event_mutation();
