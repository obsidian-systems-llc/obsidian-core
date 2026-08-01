# ADR-0012: Use append-only time entries and corrections

- Status: accepted
- Date: 2026-08-01
- Owners: Obsidian Core

## Decision

Record completed work intervals as immutable UTC time entries and prohibit database updates or
deletes. When an entry needs to change, Core appends a correction with the replacement interval,
actor, reason, and idempotency key. Reads use the most recent correction while retaining the
original entry and all prior corrections. Each correction writes a safe audit event.

## Consequences

All employees, including salaried staff, can have time recorded. This records time only; it does
not determine overtime, wages, taxes, pay-period boundaries, or commissions. Those business rules
need versioned compensation plans and approved payroll policy in CORE-014 and CORE-020.
