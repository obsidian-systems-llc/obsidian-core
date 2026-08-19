ALTER TABLE customer_subscriptions
  ADD COLUMN billing_user_id uuid REFERENCES users(id);

CREATE TABLE customer_email_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_profile_id uuid NOT NULL REFERENCES customer_profiles(id),
  recipient_user_id uuid NOT NULL REFERENCES users(id),
  recipient_email text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('profile_updated','device_care_payment_receipt')),
  event_key text NOT NULL,
  provider text NOT NULL DEFAULT 'resend' CHECK (provider IN ('resend')),
  environment text NOT NULL DEFAULT 'production' CHECK (environment IN ('sandbox','production','try')),
  template_data jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','suppressed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  provider_message_reference text,
  last_error_code text,
  queued_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_type,event_key)
);
CREATE INDEX customer_email_deliveries_pending_idx
  ON customer_email_deliveries (status,next_attempt_at,queued_at);
