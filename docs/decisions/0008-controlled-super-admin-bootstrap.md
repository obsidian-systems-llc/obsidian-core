# ADR-0008: Use controlled bootstrap for the initial Super Admin

- Status: accepted
- Date: 2026-08-01
- Owners: Obsidian Core

## Context

Core needs an initial administrator before a dedicated administration workflow exists. Authentication
is owned by Auth0, while Core owns the user mapping, entitlement, and permissions.

## Decision

Provide an idempotent database seed that is disabled unless explicit environment variables identify
one Auth0 subject and email address. It creates or reactivates the Core user, refuses to reassign an
existing Auth0 subject, and grants only explicitly defined Core Admin permissions. The seed records
an audit event and never commits personal data, passwords, tokens, or secrets.

## Consequences

- The bootstrap is an operational procedure, not a name- or email-based runtime authorization bypass.
- The initial Super Admin gains only permissions explicitly assigned to its role; new privileges must
  be assigned deliberately.
- Bulk legacy-account migration needs its own mapping, validation, rollback, and audit workflow before
  any existing backend data is imported.
