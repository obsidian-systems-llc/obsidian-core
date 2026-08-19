# CORE-029 admin operations readiness

This record closes the implementation readiness audit for CORE-029. Core, rather than its dashboards, owns role governance, effective-dated employee assignments, encrypted customer administration, repair/customer history, and customer-work routing.

## Operational boundary

- The versioned machine-readable route contract is [`api/admin-operations.contract.json`](api/admin-operations.contract.json). It is the handoff source for application/client generation until the repository adopts a general OpenAPI generation pipeline.
- Core Admin writes require the corresponding permission, the `core-admin` entitlement, and step-up authentication when the deployment configures a step-up claim/value.
- Manager routing is limited to direct reports or current shared store/department scope. Core Admin routing is company-wide but now also requires step-up authentication.
- Employee inboxes contain only assigned work and safe routing-notification metadata. They do not disclose profile payloads, transcripts, prices, or repair notes.
- Completion is idempotent: a duplicate key returns the original successful result without appending a second routing or audit event.
- Escalation sends an actionable notification to the current manager where one exists; it does not create a redundant notification for the employee who escalated.

## Validation matrix

| Area                                  | Evidence                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorization and step-up             | CORE-029 unit/API tests and authorization guards across admin routes.                                                                       |
| Scope and customer-work ownership     | `customer-work-routing.integration.test.ts` uses PostgreSQL identities, assignments, a call, routing, escalation, and duplicate completion. |
| Customer repair visibility            | Existing customer portal integration coverage verifies customer-owned safe repair projections.                                              |
| Encrypted customer/employee revisions | Existing administration integration coverage exercises encrypted profiles and append-only revisions.                                        |
| Audit and idempotency                 | The routing integration test asserts one completion audit event after a duplicate command; schema enforces unique actor/key.                |
| Migrations                            | Repository migration validation validates migrations through `0026_customer_work_routing.sql`.                                              |

## Deployment requirement

Migrations `0023` through `0026` must be applied to the target environment before exposing this API tree. Applying production migrations is an operational action and is intentionally not performed by this audit.
