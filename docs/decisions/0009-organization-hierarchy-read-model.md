# ADR-0009: Use Core as the organizational hierarchy read model

- Status: accepted
- Date: 2026-08-01
- Owners: Obsidian Core

## Context

Employees, jobs, reporting, and authorization need a consistent organization, business unit, district,
store, and department hierarchy. The foundation schema defines those records, but no Core service
exposed them.

## Decision

Expose the active hierarchy through an authorized Core Admin read endpoint backed by PostgreSQL. The
endpoint returns only active nodes in parent order and keeps unassigned departments explicit rather
than silently attaching them to an incorrect store. Add partial indexes for active parent lookups.

## Consequences

- A valid token is insufficient; the route requires the `core-admin` entitlement and
  `organization.read` permission.
- Organization creation, changes, deactivation, and approval/audit workflows are deferred until an
  administration mutation workflow can enforce the required controls.
- Future resource-level authorization can use this hierarchy without client-owned copies.
