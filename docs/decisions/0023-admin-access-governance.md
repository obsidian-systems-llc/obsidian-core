# 0023 — Admin access governance

## Status

Accepted

## Decision

Core, not Auth0 or a dashboard, manages application entitlements, application-scoped roles, role
permissions, and effective-dated role assignments. Access changes require the caller to hold the
`core-admin` entitlement and `authorization.manage` permission, as well as the configured verified
step-up claim. Core records idempotent authorization commands and audit events. The protected
Super Admin role cannot be changed through the ordinary role-permission route, and administrators
cannot change their own roles or entitlements through these APIs.

## Consequences

- UI clients cannot invent, grant, or enforce access locally.
- Assignments and entitlements expire using effective dates rather than deleting history.
- The controlled bootstrap seed receives `authorization.manage` in addition to read access after the
  corresponding migration is applied.
- Later stages add organization-scoped manager routing and employee/customer administration; this
  stage deliberately does not imply broad employee-data access.
