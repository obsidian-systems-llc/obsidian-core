# 0022 — Communications workflow and contact lookup

## Status

Accepted

## Context

Retell call events include caller phone numbers, but Core customer profiles are encrypted. Scanning and
decrypting every profile on every inbound call would be unsafe, slow, and would expand the exposure of
customer data. Employees must also be able to turn reviewed call information into a repair job or lead,
and record a do-not-call request without an outbound provider becoming the sole compliance record.

## Decision

Core stores a domain-separated HMAC fingerprint of normalized customer phone numbers in a dedicated
lookup table. The fingerprint uses Core's existing field-encryption key and never stores a raw phone
number in the lookup. Customer registration and profile updates refresh the fingerprints; a one-time
controlled profile update/backfill is required for older encrypted profiles.

The communications domain owns encrypted leads, call-to-job links, and hashed do-not-call suppressions.
Employees submit reviewed input through permission-gated actions; Retell analysis is never sufficient to
create a repair, lead, or suppression automatically. Core retains suppression state independently so
future outbound queues must check it before calling.

## Consequences

- Inbound matching is exact and only works for profiles with indexed phone data.
- Rotation of the field-encryption key requires reindexing customer contact fingerprints alongside normal
  encryption-key rotation work.
- A future campaign/outbound service must use `communication_contact_suppressions` before initiating a
  provider call.
- Lead data remains encrypted at rest and is not exposed by these write-only Phase 2 routes.
