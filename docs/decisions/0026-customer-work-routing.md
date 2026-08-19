# 0026 — Customer work routing and escalation

## Status

Accepted

## Decision

Core treats online repair requests and communications calls as customer work. Routing, reassignment,
escalation, and follow-up completion create immutable routing events and safe actionable
notifications. Managers can route only to direct reports or staff within their active store or
department scope. Core Admins with `customer.work.manage` can route company-wide.

## Consequences

- Routing notifications contain only a work type and Core record ID; UIs must retrieve customer data
  through separately authorized read APIs.
- Completing a communications call marks its Core follow-up completed. Completing repair work
  completes the routing task only; it never bypasses the repair-job workflow state machine.
- The employee portal receives only assigned work and safe notification metadata.
