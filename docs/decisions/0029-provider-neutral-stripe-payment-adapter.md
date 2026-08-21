# ADR-0029: Add Stripe behind Core's payment-provider boundary

- Status: accepted
- Date: 2026-08-21
- Owners: Obsidian Core

## Context

Obsidian Systems now has a Stripe account connected to its Bluevine business bank account. Core
already owns provider-neutral payment records, but the executable payment, saved-method, Device
Care, and webhook paths were implemented only for Square.

## Decision

Add `stripe` as a selectable `PAYMENT_PROCESSOR` without changing application-facing ownership.
Core uses Stripe's server-side Payment Intents, Billing subscriptions, Customer, PaymentMethod, and
SetupIntent APIs. Browser applications may use their own matching Stripe publishable key and the
short-lived SetupIntent client secret returned by Core, but never receive Core's Stripe secret or
webhook credentials.

Stripe test and production modes have separate secrets, exact public webhook URLs, Device Care Price
IDs, and webhook signing secrets. Webhooks retain the raw body, verify Stripe's timestamped v1 HMAC
within a bounded replay window, and use Core's durable provider-event ledger for idempotency. Core
retains operational provider references and safe display metadata only.

## Consequences

- `PAYMENT_PROCESSOR=stripe` activates Stripe while `square` preserves the existing Square path.
- Existing provider references remain immutable; changing the selector never migrates saved cards or
  active subscriptions. A controlled customer migration/re-consent workflow is required before a
  Square subscription can be replaced by Stripe.
- Stripe Device Care uses the selected Stripe recurring `price_...` reference and accrues credits
  only from replay-safe `invoice.paid` webhooks.
- Worldpay/Commerce360 remains disabled pending separate provider verification.
- Stripe secret keys and endpoint signing secrets must be stored only in managed server secrets.
