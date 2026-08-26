-- CORE-036 command history: policy versions and manual ledger corrections are idempotent and auditable.

ALTER TABLE device_care_membership_policies
  ADD COLUMN created_by_user_id uuid REFERENCES users(id),
  ADD COLUMN idempotency_key uuid;

CREATE UNIQUE INDEX device_care_membership_policy_actor_idempotency_idx
  ON device_care_membership_policies (created_by_user_id, idempotency_key)
  WHERE created_by_user_id IS NOT NULL AND idempotency_key IS NOT NULL;

CREATE TABLE device_care_credit_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_subscription_id uuid NOT NULL REFERENCES customer_subscriptions(id),
  ledger_entry_id uuid NOT NULL UNIQUE REFERENCES device_care_credit_ledger(id),
  entry_type text NOT NULL CHECK (entry_type IN ('reversal','restoration')),
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
  related_ledger_entry_id uuid REFERENCES device_care_credit_ledger(id),
  reason text NOT NULL,
  adjusted_by_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key uuid NOT NULL,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (adjusted_by_user_id, idempotency_key)
);
CREATE INDEX device_care_credit_adjustments_subscription_idx
  ON device_care_credit_adjustments (customer_subscription_id, created_at DESC);
