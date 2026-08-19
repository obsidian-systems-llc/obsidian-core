# ADR-0027: Deliver customer transactional email through a durable Resend outbox

## Context

Customers need confirmation when their Core profile changes and a receipt after each successful
Obsidian Device Care subscription payment, including automatic recurring payments. Sending directly
from an HTTP request or a payment webhook would couple a user-facing response to an external email
provider and make retries prone to duplicate mail.

## Decision

Core writes a `customer_email_deliveries` record in the same PostgreSQL transaction as the relevant
business event. A server-only Resend adapter claims queued records, sends them with a stable provider
idempotency key, records provider delivery references, audits outcomes, and retries failures up to
five times.

Profile-change records use the immutable profile-revision ID as their event key. Device Care receipt
records use the signed payment-event and provider-invoice identifiers. This preserves normal
at-most-one delivery intent even when Square replays a webhook. The invoice receipt reads the selected
subscription plan version, so a future plan-price change cannot change a historical receipt.

`CUSTOMER_EMAIL_ENABLED` is false by default. Enabling it requires `RESEND_API_KEY` and a verified
`RESEND_FROM_EMAIL`; all credentials remain in server-side secret storage. Sandbox receipt records
are deliberately suppressed unless `CUSTOMER_EMAIL_SEND_SANDBOX=true`.

## Consequences

- Customer portal requests and Square webhooks return without waiting for an email provider.
- Receipts never include card numbers, card tokens, or other payment credentials.
- Profile-update confirmations state only that account information changed; they never echo sensitive
  customer fields.
- A delivery left in `sending` by a process interruption is eligible to be reclaimed after ten minutes;
  the stable Resend idempotency key protects the normal retry path from duplicate provider requests.
- Resend domain verification and managed Render environment configuration remain deployment actions;
  no secret is committed to this repository.
