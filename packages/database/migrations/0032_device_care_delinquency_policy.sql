-- CORE-036: preserve credit history while enforcing the approved delinquency policy.
-- Members retain benefits for seven days; day eight produces an append-only forfeiture entry.

ALTER TABLE customer_subscriptions
  ADD COLUMN IF NOT EXISTS delinquent_at timestamptz;

ALTER TABLE device_care_membership_policies
  ALTER COLUMN grace_period_days SET DEFAULT 7,
  ALTER COLUMN forfeiture_after_days SET DEFAULT 8;

UPDATE device_care_membership_policies
SET grace_period_days = 7,
    forfeiture_after_days = 8,
    restore_forfeited_credits_on_reinstatement = false
WHERE version_number = 1;
