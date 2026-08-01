# ADR-0007: Enforce roles, permissions, and entitlements server-side

- Status: accepted
- Date: 2026-08-01
- Owners: Obsidian Core

## Context

Auth0 confirms an identity but does not decide whether that person may use an Obsidian application or
perform a Core operation. These decisions must remain centrally managed and cannot depend on a GUI.

## Decision

Core resolves an Auth0 subject to its internal user record, then requires both an active application
entitlement and an effective role permission for protected application routes. Access defaults to
deny. Roles may be global or application-specific; organization scope is retained in role assignments
for later resource-level authorization.

## Consequences

- A valid token without a mapped active user, current entitlement, and required permission is denied.
- Application routes declare their own application key and permission requirement at the server
  boundary; clients cannot supply or override them.
- Role and entitlement administration, organization-scoped resource checks, and user provisioning are
  deferred to their dedicated priorities.
