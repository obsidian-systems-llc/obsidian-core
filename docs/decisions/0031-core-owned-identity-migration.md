# ADR 0031: Core-owned identity with reversible external-provider migration

- Status: Accepted for implementation
- Date: 2026-08-24

## Context

Auth0 callback, claim, and onboarding configuration repeatedly interrupted the customer portal.
Obsidian Core must remain the long-term source of truth for account credentials, customer profiles,
entitlements, authorization, and audit history without placing provider credentials in a browser.

## Decision

Core will implement an internal Identity module in the existing Node.js modular monolith. It issues
short-lived HS256 access tokens only from the server and validates them alongside legacy Auth0 RS256
tokens during a reversible migration window. The Core token subject is the opaque, namespaced form
`core|<Core-user-UUID>`.

Password credentials use Node.js Argon2id with a unique 16-byte salt, versioned parameters, 19 MiB
memory, two passes, one lane, and a 32-byte tag. Passwords are never reversibly encrypted. One-time
email verification/reset tokens and rotating session credentials are random 32-byte values stored only
as SHA-256 hashes. An email delivery retry generates a replacement one-time token only at delivery
time; Core does not retain a recoverable email-link secret.

Browser refresh credentials are HTTP-only, secure, `SameSite=None` cookies in production and are
rotated on every refresh. The customer portal retains only a short-lived access token in memory. Core
continues to enforce entitlements, role permissions, memberships, and resource scope after either type
of authentication.

## Migration boundary

Existing Auth0 users remain valid. A future linking flow will require the person to prove possession of
their existing Core-authenticated account and set a new Core password. Auth0 passwords are never
migrated or read. Core-owned TOTP MFA uses an encrypted seed, one-time recovery codes stored only as
hashes, and five-minute MFA access tokens. Invitation acceptance resolves the authenticated Core
identity email server-side; it never trusts a browser-provided email. Keycloak is not part of the
production architecture.

## Consequences

Core requires a protected signing secret, verified Resend sender, HTTPS API/portal origins, email
verification and reset pages, and Node.js 24.7 or later for Argon2id. Core now provides user session
revocation, an authenticated Auth0-to-Core linking endpoint, invitation-gated workforce registration,
and real-PostgreSQL lifecycle coverage. The migration remains reversible until the portal/app clients
adopt these routes and an operational production smoke test validates email delivery, browser cookies,
and both legacy and Core access paths.

## Operational migration and rollback

1. Back up the Render PostgreSQL database and apply migrations `0031` and `0032` before enabling the
   feature flag.
2. Set a newly generated, secret-manager-held `CORE_IDENTITY_SIGNING_SECRET`; never reuse a secret
   shared in a chat or a deployment log. Configure the Core API URL as issuer/audience, the HTTPS
   portal verification/reset pages, Resend sender, and the exact portal origin allowlist.
3. Deploy with `CORE_IDENTITY_ENABLED=false`, verify `/health`, `/ready`, and the migration ledger;
   then set it to `true` and perform a synthetic registration, verification, login, refresh, password
   reset, MFA enrollment, and step-up test.
4. Keep Auth0 configuration and verification enabled during the migration window. Do not disable it
   until every active user has an approved Core-linking path and support has a recovery process.
5. To roll back the application behavior, set `CORE_IDENTITY_ENABLED=false` and redeploy. This does
   not delete identity data, sessions, MFA factors, or audit history. Rotate the signing secret and
   revoke sessions through a reviewed incident procedure if a signing secret is suspected exposed.
