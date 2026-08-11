ALTER TABLE customer_payment_methods
  ADD COLUMN is_primary boolean NOT NULL DEFAULT false,
  ADD COLUMN deactivated_at timestamptz;
CREATE UNIQUE INDEX customer_payment_methods_one_primary_idx
  ON customer_payment_methods (customer_profile_id)
  WHERE is_primary AND deactivated_at IS NULL AND status = 'active';

ALTER TABLE customer_subscriptions
  ADD COLUMN cancellation_requested_at timestamptz,
  ADD COLUMN provider_version bigint,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE subscription_lifecycle_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_profile_id uuid NOT NULL REFERENCES customer_profiles(id),
  action text NOT NULL CHECK (action IN ('primary_payment_method_changed', 'cancellation_requested', 'payment_method_removed')),
  idempotency_key uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (customer_profile_id, action, idempotency_key)
);

INSERT INTO permissions (key, name) VALUES
  ('payment-method.read', 'Read own saved payment methods'),
  ('subscription.cancel', 'Cancel own subscriptions')
ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN applications a ON a.id = r.application_id AND a.key = 'customer-portal'
JOIN permissions p ON p.key IN ('payment-method.read', 'subscription.cancel')
WHERE r.key = 'customer-self-service'
ON CONFLICT DO NOTHING;
