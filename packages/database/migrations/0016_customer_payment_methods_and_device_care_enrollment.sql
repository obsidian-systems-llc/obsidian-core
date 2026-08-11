CREATE TABLE customer_payment_provider_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_profile_id uuid NOT NULL REFERENCES customer_profiles(id),
  provider text NOT NULL CHECK (provider IN ('square', 'worldpay')),
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production', 'try')),
  provider_customer_reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_profile_id, provider, environment),
  UNIQUE (provider, environment, provider_customer_reference)
);

CREATE TABLE customer_payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_profile_id uuid NOT NULL REFERENCES customer_profiles(id),
  provider_profile_id uuid NOT NULL REFERENCES customer_payment_provider_profiles(id),
  provider text NOT NULL CHECK (provider IN ('square', 'worldpay')),
  provider_card_reference text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'inactive', 'expired')),
  brand text,
  last4 char(4),
  exp_month smallint CHECK (exp_month BETWEEN 1 AND 12),
  exp_year smallint CHECK (exp_year BETWEEN 2000 AND 9999),
  cardholder_name text,
  consented_at timestamptz NOT NULL,
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_card_reference),
  UNIQUE (customer_profile_id, idempotency_key)
);
CREATE INDEX customer_payment_methods_profile_idx ON customer_payment_methods (customer_profile_id, created_at DESC);

ALTER TABLE customer_subscriptions
  ADD COLUMN provider text CHECK (provider IN ('square', 'worldpay')),
  ADD COLUMN provider_environment text CHECK (provider_environment IN ('sandbox', 'production', 'try')),
  ADD COLUMN customer_payment_method_id uuid REFERENCES customer_payment_methods(id),
  ADD COLUMN enrollment_idempotency_key uuid;
CREATE UNIQUE INDEX customer_subscriptions_enrollment_idempotency_idx
  ON customer_subscriptions (customer_profile_id, enrollment_idempotency_key)
  WHERE enrollment_idempotency_key IS NOT NULL;

INSERT INTO subscription_plans (key) VALUES ('device-care') ON CONFLICT (key) DO NOTHING;
INSERT INTO subscription_plan_versions
  (subscription_plan_id, version_number, name, currency, amount_minor, cadence, provider_plan_reference, effective_from)
SELECT id, 1, 'Obsidian Device Care', 'USD', 1500, 'monthly', 'square:device-care', now()
FROM subscription_plans
WHERE key = 'device-care'
  AND NOT EXISTS (
    SELECT 1 FROM subscription_plan_versions spv WHERE spv.subscription_plan_id = subscription_plans.id
  );

INSERT INTO permissions (key, name) VALUES
  ('payment-method.manage', 'Manage own saved payment methods'),
  ('subscription.enroll', 'Enroll in available subscriptions')
ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN applications a ON a.id = r.application_id AND a.key = 'customer-portal'
JOIN permissions p ON p.key IN ('payment-method.manage', 'subscription.enroll')
WHERE r.key = 'customer-self-service'
ON CONFLICT DO NOTHING;
