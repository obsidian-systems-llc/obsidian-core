# ADR-0011: Encrypt employee profiles and preserve effective assignments

- Status: accepted
- Date: 2026-08-01
- Owners: Obsidian Core

## Decision

Store employee profile payloads with the established AES-256-GCM application-layer encryption
scheme. Keep employee numbers, employment status, lifecycle dates, and effective organizational
assignments as structured Core fields so Core can enforce employment status and later retain
assignment history. Employee profile access requires the `employee-portal` application entitlement
and `employee.profile.read` permission.

## Consequences

An employee can have historical and concurrent store or department assignments with explicit
effective dates. The initial employee endpoint is self-service read-only. SSNs, copies of identity
documents, payroll tax data, and compensation values are deliberately outside this profile model:
they require a dedicated access policy, retention schedule, encrypted document storage, audit
events, and a compliance review before collection.
