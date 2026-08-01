# ADR-0010: Encrypt customer profiles and addresses at the application layer

- Status: accepted
- Date: 2026-08-01
- Owners: Obsidian Core

## Decision

Store customer profile and address payloads with AES-256-GCM application-layer encryption. Each value records an IV, authentication tag, and key identifier. Core maps Auth0 identities to customer profiles through membership records, allowing shared accounts and addresses without making Auth0 the customer data source.

## Consequences

Encryption keys are environment-only and rotate by key ID. Customer routes require both application authorization and a profile membership. Write and administrative customer workflows remain deferred.
