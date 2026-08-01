# ADR-0006: Core manages recurring billing lifecycles

- Status: accepted
- Date: 2026-08-01
- Owners: Obsidian Core

## Context

Customer-facing Obsidian applications need subscriptions without each application independently
tracking due dates, billing customers, or interpreting payment outcomes.

## Decision

Core will own subscription billing schedules and lifecycle automation. A customer-facing application
collects authorized subscription choices and payment-method consent through Core APIs. Core tracks
the next payment due date, creates the associated operational invoice, requests a charge using only a
Square tokenized payment-method reference, processes signed Square webhook outcomes, and updates the
subscription and invoice state.

Core will send or request customer billing notifications through its notifications domain. It will use
idempotency and traceable retry/dunning workflows for failed payments. The application consumes the
resulting subscription state; it does not charge a card or finalize a payment itself.

## Consequences

- Automated charges require explicit customer authorization and a Square-supported saved payment
  method; Core must not store raw card data.
- Billing schedules, retry rules, grace periods, cancellation, and notification templates must be
  configurable and versioned rather than hard-coded per application.
- Every automated charge, failure, retry, invoice change, and notification must be auditable.
- CORE-022 will implement this capability after the payment adapter and subscription foundations.
