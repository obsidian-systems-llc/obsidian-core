-- Make the provider-neutral payment records capable of retaining Stripe references.
-- Existing Square and Worldpay records remain unchanged.
ALTER TABLE payment_operations
  DROP CONSTRAINT IF EXISTS payment_operations_provider_check,
  ADD CONSTRAINT payment_operations_provider_check
    CHECK (provider IN ('square', 'stripe', 'worldpay'));

ALTER TABLE payment_webhook_events
  DROP CONSTRAINT IF EXISTS payment_webhook_events_provider_check,
  ADD CONSTRAINT payment_webhook_events_provider_check
    CHECK (provider IN ('square', 'stripe', 'worldpay'));

ALTER TABLE customer_payment_provider_profiles
  DROP CONSTRAINT IF EXISTS customer_payment_provider_profiles_provider_check,
  ADD CONSTRAINT customer_payment_provider_profiles_provider_check
    CHECK (provider IN ('square', 'stripe', 'worldpay')),
  DROP CONSTRAINT IF EXISTS customer_payment_provider_profiles_environment_check,
  ADD CONSTRAINT customer_payment_provider_profiles_environment_check
    CHECK (environment IN ('sandbox', 'test', 'production', 'try'));

ALTER TABLE customer_payment_methods
  DROP CONSTRAINT IF EXISTS customer_payment_methods_provider_check,
  ADD CONSTRAINT customer_payment_methods_provider_check
    CHECK (provider IN ('square', 'stripe', 'worldpay'));

ALTER TABLE customer_subscriptions
  DROP CONSTRAINT IF EXISTS customer_subscriptions_provider_check,
  ADD CONSTRAINT customer_subscriptions_provider_check
    CHECK (provider IN ('square', 'stripe', 'worldpay')),
  DROP CONSTRAINT IF EXISTS customer_subscriptions_provider_environment_check,
  ADD CONSTRAINT customer_subscriptions_provider_environment_check
    CHECK (provider_environment IN ('sandbox', 'test', 'production', 'try'));

ALTER TABLE customer_email_deliveries
  DROP CONSTRAINT IF EXISTS customer_email_deliveries_environment_check,
  ADD CONSTRAINT customer_email_deliveries_environment_check
    CHECK (environment IN ('sandbox', 'test', 'production', 'try'));
