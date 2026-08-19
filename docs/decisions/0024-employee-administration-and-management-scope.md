# 0024 — Employee administration and management scope

## Status

Accepted

## Decision

Core owns encrypted employee profile lifecycle changes, effective-dated employee assignments, and
management-scope resolution. Core Admin employee writes require both `employee.manage` and the
configured verified step-up claim. Changes are retry-safe through a durable employee-administration
command ledger, preserve encrypted profile revisions, and emit safe audit events that exclude the
profile payload itself.

An employee with `employee.scope.read` in the `employee-portal` application may read only active
employees who are directly assigned to them or whose current store/department overlaps their own
current assignment. The client cannot supply its own scope. This is an operational routing view, not
a blanket employee-directory permission.

## Consequences

- Auth0 remains responsible for login identities; Core creates an employee profile only for an
  existing active Core user.
- Ending an assignment preserves its effective-date history; changing profile data preserves an
  encrypted revision and changed-field metadata.
- Deactivation preserves the employee record and lifecycle evidence instead of deleting it.
- Company-wide employee discovery and organization hierarchy mutation remain intentionally outside
  this scope unless a later priority supplies their authorization and data-governance contracts.
