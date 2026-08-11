# ADR-0021: Model Device Care as a versioned membership-credit ledger

- Status: accepted
- Date: 2026-08-10
- Owners: Obsidian Core

## Context

Obsidian Device Care is a $15 monthly membership with repair-credit accrual, threshold and cap
rules, conditional discounts, MAX status, and benefits that depend on current membership state.
Square may temporarily collect enrollment through a hosted payment link, but a payment processor
cannot be the authoritative source for internal entitlement, repair-credit, household, or warranty
rules.

## Decision

Core will retain an append-only, integer-minor-unit credit ledger linked to a versioned Device Care
membership policy and customer subscription. It will derive available credit balance, MAX status,
and benefit eligibility from durable Core records and verified provider payment lifecycle events.
Credit spending, corrections, lapse/forfeiture decisions, household eligibility, and benefit
redemptions require authorization and audit history. The external processor stores no business-rule
state beyond its provider references.

## Consequences

- A payment link is an enrollment/collection channel only; it cannot grant benefits or change credit
  balances directly.
- Core never silently deletes credit history. Lapse and forfeiture are explicit policy events.
- Customer apps display Core-calculated membership state and must not recreate the pricing or
  entitlement rules.
- CORE-036 must implement the ledger and benefit workflows after signed provider payment lifecycle
  integration is complete.
