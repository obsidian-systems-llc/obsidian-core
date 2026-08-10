# ADR-0020: Keep employee-mobile operational rules in Core

- Status: accepted
- Date: 2026-08-10
- Owners: Obsidian Core

## Decision

The future employee mobile client will be a React Native application built with Expo and will use a
dedicated Auth0 Native application. It consumes Core's authenticated REST API; it does not own
timekeeping, job authorization, workflow validation, or retry semantics.

Core records mobile clock-in, clock-out, break-start, and break-end actions as immutable,
idempotent events. A successful clock-out derives a completed mobile time entry while retaining the
event history. Employees can read and transition only jobs currently assigned to their own active
employee profile. Core rejects state conflicts and returns no job information for another employee.

No mobile location, device fingerprint, or telemetry is collected by this contract. A future
location-verification capability requires a separate decision defining business purpose, consent,
permissions, retention, access audit, and applicable legal review.

## Consequences

Mobile clients can safely retry a command after intermittent connectivity with the same idempotency
key. They must reconcile `409 MOBILE_TIME_EVENT_CONFLICT` responses rather than overwriting server
state. Route optimization, mapping, navigation, media uploads, notes, signatures, and payment
collection remain separate Core integrations.
