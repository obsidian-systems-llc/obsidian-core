# ADR-0019: Validate the API perimeter at startup

- Status: accepted
- Date: 2026-08-04
- Owners: Obsidian Core

## Context

Core will be consumed by separately hosted browser applications. Browser origins, response headers,
write-rate protection, and proof of step-up authentication must be enforced by the API rather than
assumed from GUI behavior.

## Decision

Core uses a configuration-validated origin allowlist, standard restrictive response headers, and an
in-process rate limiter for sensitive write routes. Production requires HTTPS allowed origins and a
configured Auth0 custom claim/value. High-risk subscription-plan changes require that verified token
claim. The Auth0 tenant must issue that claim only after the desired MFA or reauthentication policy.

## Consequences

The API fails fast when production perimeter configuration is absent. The in-process limiter is a
safe single-instance baseline but does not coordinate across replicas; a shared distributed limiter
is required before horizontally scaling Core. No browser client can grant itself access by supplying
headers or a local UI state.
