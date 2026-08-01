# ADR-0015: Use a provider-neutral payment contract with Square capability verification

- Status: accepted
- Date: 2026-08-01

Square is the interim processor. Its official documentation confirms sandbox support, Payments API,
Catalog/Invoices/Subscriptions integration, idempotency support, and webhook signature validation.
Core therefore exposes a provider-neutral contract using provider payment-method references and
integer minor-unit money only. Square production configuration is rejected unless `NODE_ENV` is
`production`; this spike does not make processor calls or accept webhook state changes.

Square webhook validation must calculate and constant-time compare the HMAC-SHA256 signature using
the subscription signature key, notification URL, and raw request body.
