# ADR-0028: Use Core-owned, email-bound workforce invitations

## Decision

Core issues workforce invitations only from a step-up-authenticated principal with the dedicated
`authorization.invite` permission. An invitation identifies an existing Core role; Core derives the
role's application entitlement and never accepts an application key from the client.

Core generates a 256-bit opaque token, stores only its SHA-256 hash for acceptance, and retains an
AES-GCM encrypted copy only while it is needed for durable Resend delivery retries. The token is
placed in the administrative application's URL fragment, is never returned by an API, and is erased
after acceptance. Invitations expire after seven days by default, have a maximum thirty-day lifetime,
are revocable, and are idempotent for the issuing administrator.

Auth0 owns signup, password creation, and email verification. Core accepts an invitation only after
verifying an Auth0 API token and comparing its configured email claim to the invitation recipient.
Acceptance creates or links the Core identity and grants the invitation's entitlement and role exactly
once; it does not grant access merely because a person has an Auth0 account.

## Consequences

- An owner can invite executives, managers, employees, or partners by selecting their existing
  application-scoped Core role.
- Invitations, delivery attempts, acceptance, and revocation are durable and audited.
- The invitation capability relies on the existing server-only Resend configuration; no frontend has
  provider credentials.
- Administrators must configure an Auth0 access-token email claim before activating this integration.
