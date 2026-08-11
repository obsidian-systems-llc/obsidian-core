-- Reconcile payment self-service grants for the dynamically provisioned customer portal role.
-- Migration 0017 can run before the first customer registration creates this role.
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
