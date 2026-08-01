# ADR-0004: Use Square as the interim payment provider

- Status: accepted
- Date: 2026-08-01
- Owners: Obsidian Core

## Context

Commerce360/GoDaddy online-payment and subscription capabilities are not yet confirmed. Obsidian
Systems needs a provider that can support payment collection and subscriptions while preserving
Obsidian Core as the single integration boundary for all applications.

## Decision

Use Square as the interim payment provider. Implement the future payments domain behind a
provider-independent adapter; clients call Obsidian Core payment APIs and never Square directly.
Commerce360 is deferred, not removed, and may be added later through another adapter after its
capabilities and contractual terms are verified.

## Consequences

- Square credentials, access tokens, webhook signatures, and production data must be held only in
  secret management and must never be committed.
- Core will store Square references and safe display metadata only; it will never store raw card
  numbers or CVV values.
- CORE-012 must verify Square's required capabilities, sandbox behavior, webhook verification,
  idempotency behavior, and subscription support before implementing payment processing.
- A future Commerce360 adapter must satisfy the same Core contract and must not create a client-side
  payment path.
