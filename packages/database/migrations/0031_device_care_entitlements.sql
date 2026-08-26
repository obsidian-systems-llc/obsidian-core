ALTER TABLE device_care_membership_policies
  ADD COLUMN repair_discount_basis_points integer NOT NULL DEFAULT 1000 CHECK (repair_discount_basis_points BETWEEN 0 AND 10000),
  ADD COLUMN accessory_discount_basis_points integer NOT NULL DEFAULT 1500 CHECK (accessory_discount_basis_points BETWEEN 0 AND 10000),
  ADD COLUMN max_accessory_discount_basis_points integer NOT NULL DEFAULT 2000 CHECK (max_accessory_discount_basis_points BETWEEN 0 AND 10000),
  ADD COLUMN cleaning_interval_days integer NOT NULL DEFAULT 90 CHECK (cleaning_interval_days > 0),
  ADD COLUMN workmanship_warranty_days integer NOT NULL DEFAULT 90 CHECK (workmanship_warranty_days > 0),
  ADD COLUMN grace_period_days integer NOT NULL DEFAULT 0 CHECK (grace_period_days >= 0),
  ADD COLUMN forfeiture_after_days integer CHECK (forfeiture_after_days IS NULL OR forfeiture_after_days > grace_period_days),
  ADD COLUMN restore_forfeited_credits_on_reinstatement boolean NOT NULL DEFAULT false;

ALTER TABLE device_care_credit_ledger
  ADD COLUMN repair_job_id uuid REFERENCES jobs(id),
  ADD COLUMN quote_id uuid REFERENCES quotes(id),
  ADD COLUMN related_ledger_entry_id uuid REFERENCES device_care_credit_ledger(id),
  ADD COLUMN reason text;

CREATE TABLE device_care_household_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_customer_profile_id uuid NOT NULL REFERENCES customer_profiles(id),
  member_customer_profile_id uuid NOT NULL REFERENCES customer_profiles(id),
  relationship text NOT NULL CHECK (relationship IN ('spouse','child','parent','sibling','other_immediate_household')),
  idempotency_key uuid NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  verified_by_user_id uuid NOT NULL REFERENCES users(id),
  ended_at timestamptz,
  ended_by_user_id uuid REFERENCES users(id),
  end_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (owner_customer_profile_id <> member_customer_profile_id),
  UNIQUE (owner_customer_profile_id, member_customer_profile_id),
  UNIQUE (verified_by_user_id, idempotency_key)
);
CREATE INDEX device_care_household_member_active_idx
  ON device_care_household_memberships (member_customer_profile_id, owner_customer_profile_id)
  WHERE ended_at IS NULL;

CREATE TABLE device_care_credit_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_subscription_id uuid NOT NULL REFERENCES customer_subscriptions(id),
  customer_profile_id uuid NOT NULL REFERENCES customer_profiles(id),
  repair_job_id uuid NOT NULL REFERENCES jobs(id),
  quote_id uuid NOT NULL REFERENCES quotes(id),
  ledger_entry_id uuid NOT NULL UNIQUE REFERENCES device_care_credit_ledger(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  applied_by_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key uuid NOT NULL,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (applied_by_user_id, idempotency_key)
);
CREATE INDEX device_care_credit_applications_quote_idx ON device_care_credit_applications (quote_id, created_at DESC);

CREATE TABLE device_care_benefit_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_subscription_id uuid NOT NULL REFERENCES customer_subscriptions(id),
  customer_profile_id uuid NOT NULL REFERENCES customer_profiles(id),
  membership_policy_id uuid NOT NULL REFERENCES device_care_membership_policies(id),
  benefit_type text NOT NULL CHECK (benefit_type IN ('priority_service','free_diagnostic','device_cleaning','minor_service','screen_protector_installation','loaner_priority','workmanship_warranty')),
  repair_job_id uuid REFERENCES jobs(id),
  idempotency_key uuid NOT NULL,
  redeemed_by_user_id uuid NOT NULL REFERENCES users(id),
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (redeemed_by_user_id, idempotency_key)
);
CREATE INDEX device_care_benefit_redemptions_customer_benefit_idx
  ON device_care_benefit_redemptions (customer_profile_id, benefit_type, created_at DESC);

CREATE FUNCTION reject_device_care_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Device Care credit ledger history is immutable.'; END;
$$;
CREATE TRIGGER device_care_credit_ledger_immutable
  BEFORE UPDATE OR DELETE ON device_care_credit_ledger
  FOR EACH ROW EXECUTE FUNCTION reject_device_care_ledger_mutation();

INSERT INTO permissions (key,name) VALUES
  ('device-care.member.read','Read Device Care member entitlement state'),
  ('device-care.household.manage','Verify and manage Device Care household eligibility'),
  ('device-care.credit.apply','Apply Device Care Repair Credits to accepted repair quotes'),
  ('device-care.credit.adjust','Record audited Device Care credit adjustments'),
  ('device-care.benefit.redeem','Record Device Care MAX benefit use'),
  ('device-care.policy.manage','Create effective-dated Device Care membership policies')
ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name,updated_at=now();

INSERT INTO role_permissions (role_id,permission_id)
SELECT r.id,p.id FROM roles r JOIN applications a ON a.id=r.application_id JOIN permissions p ON p.key IN
  ('device-care.member.read','device-care.household.manage','device-care.credit.apply','device-care.credit.adjust','device-care.benefit.redeem')
WHERE a.key='core-admin' AND r.key='super-admin' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id,permission_id)
SELECT r.id,p.id FROM roles r JOIN applications a ON a.id=r.application_id JOIN permissions p ON p.key='device-care.policy.manage'
WHERE a.key='executive-panel' AND r.key='super-admin' ON CONFLICT DO NOTHING;
