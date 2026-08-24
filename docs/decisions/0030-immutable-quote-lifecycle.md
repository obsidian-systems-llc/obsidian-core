# ADR-0030: Preserve quote lifecycle and acceptance evidence as immutable history

- Status: accepted
- Date: 2026-08-23
- Owners: Obsidian Core

## Decision

Core represents an issued quote, approval, acceptance, expiration, cancellation, and revision as
durable lifecycle events. A revision creates a new quote snapshot linked to the same root quote;
it never replaces its predecessor's line items or price. A manual price override is permitted only
while producing a new revision, requires a reason, step-up authentication, dedicated permission,
and audit evidence. Customer acceptance is allowed only for an owned issued or approved quote and
records the authenticated actor, acceptance channel, terms version, correlation ID, and timestamp.

## Consequences

Existing historical quotes remain readable. Applications may display lifecycle state but cannot
recalculate, overwrite, or silently accept a quote. Payment and repair-settlement work must bind
to an accepted immutable quote revision rather than a mutable catalog price.
