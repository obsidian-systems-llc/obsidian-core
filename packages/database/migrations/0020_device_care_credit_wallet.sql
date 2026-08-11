CREATE TABLE device_care_membership_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_number integer NOT NULL UNIQUE,
  accrual_minor bigint NOT NULL CHECK (accrual_minor > 0),
  unlock_minor bigint NOT NULL CHECK (unlock_minor > 0),
  cap_minor bigint NOT NULL CHECK (cap_minor >= unlock_minor),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
INSERT INTO device_care_membership_policies (version_number,accrual_minor,unlock_minor,cap_minor)
VALUES (1,1500,6000,35000) ON CONFLICT (version_number) DO NOTHING;

CREATE TABLE device_care_credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_subscription_id uuid NOT NULL REFERENCES customer_subscriptions(id),
  membership_policy_id uuid NOT NULL REFERENCES device_care_membership_policies(id),
  entry_type text NOT NULL CHECK (entry_type IN ('accrual','redemption','reversal','forfeiture','restoration')),
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
  provider_invoice_reference text,
  provider_event_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((entry_type = 'accrual' AND provider_invoice_reference IS NOT NULL AND provider_event_reference IS NOT NULL)
    OR entry_type <> 'accrual')
);
CREATE INDEX device_care_credit_ledger_subscription_created_idx ON device_care_credit_ledger (customer_subscription_id,created_at DESC);
CREATE UNIQUE INDEX device_care_credit_ledger_provider_invoice_idx
  ON device_care_credit_ledger (provider_invoice_reference) WHERE provider_invoice_reference IS NOT NULL;
CREATE UNIQUE INDEX device_care_credit_ledger_provider_event_idx
  ON device_care_credit_ledger (provider_event_reference) WHERE provider_event_reference IS NOT NULL;
