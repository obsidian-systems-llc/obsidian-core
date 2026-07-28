# ADR-0003: Use Auth0 for centralized identity

- Status: accepted
- Date: 2026-07-28
- Owners: Obsidian Core

## Decision

Use Auth0 as the OIDC identity provider for web and mobile applications. Use Authorization Code with PKCE, Universal Login, email verification, MFA/passkeys, refresh-token rotation, and attack protection.

## Boundaries

Auth0 authenticates a person; Obsidian Core owns business profiles, application entitlements, roles, permissions, organization scope, and resource-level authorization.
