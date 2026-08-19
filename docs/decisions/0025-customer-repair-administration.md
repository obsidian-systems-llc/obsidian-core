# 0025 — Customer and repair administration

## Status

Accepted

## Decision

Core owns administrative customer-profile writes and the current customer association of a repair.
Administrative customer records are encrypted at rest, profile updates preserve the pre-existing
encrypted revision mechanism, and write commands are retry-safe. Repair customer links are changed
only through an immutable association-event ledger while `jobs.customer_profile_id` remains the
current operational association.

## Consequences

- Customer-profile administration requires `core-admin`, `customer.manage`, and verified step-up.
- Repair association changes require `core-admin`, `repair.customer.manage`, and verified step-up.
- Creating an administrative customer does not create or attach an Auth0 identity; account linking
  remains a separate identity-governance workflow.
- Customer portal repair reads return only ID, status, and appointment window. Internal notes,
  transcripts, employee assignments, pricing, and operational details are never included.
