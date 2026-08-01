# ADR-0014: Use append-only job workflow transitions

- Status: accepted
- Date: 2026-08-01

Jobs retain their requested origin and appointment window. Every later state change is an immutable,
attributed transition validated by Core's workflow graph. Route planning and mapping are deferred to
a provider-adapter priority once these operational route-stop records are introduced.
